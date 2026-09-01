import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ffmpeg, probe } from "../lib/ffmpeg.js";
import { askClaudeJSON } from "../lib/llm.js";
import { transcribe } from "./transcribe.js";
import { detectSilences } from "./cuts.js";

/**
 * Split a raw multi-take recording into one clip per take.
 *
 * A take = continuous speech separated from the next by >= minGap of silence.
 * Each take is transcribed, cut with padding, and classified good/bad (false
 * starts, flubs, "let me redo that", director chatter, cut-offs). Writes
 * takes.txt next to the clips.
 */
export interface Take {
  index: number;
  start: number;
  end: number;
  text: string;
  bad: boolean;
  reason?: string;
  file?: string;
  durationSec?: number;
}

const MIN_TAKE_SEC = 2.5; // anything shorter is a fragment, auto-bad

export async function splitTakes(
  input: string,
  outDir = "takes",
  minGap = 1.5,
  pad = 0.25,
): Promise<Take[]> {
  console.log("Transcribing...");
  const { segments } = await transcribe(input);
  const spoken = segments.filter((s) => s.text.trim().length > 0);
  if (spoken.length === 0) throw new Error("No speech found in the recording");

  // Real silence intervals (padSec=0 -> raw boundaries) to sanity-check gaps.
  console.log(`Detecting silences (>${minGap}s)...`);
  const silences = await detectSilences(input, minGap, 0);
  const inSilence = (t: number) =>
    silences.some((s) => t >= s.start - 0.2 && t <= s.end + 0.2);

  const meta = await probe(input);

  // Group segments into takes on >= minGap gaps (confirmed against silence).
  const takes: Take[] = [];
  let curStart = spoken[0].start;
  let curEnd = spoken[0].end;
  let curText: string[] = [spoken[0].text.trim()];
  for (let i = 1; i < spoken.length; i++) {
    const s = spoken[i];
    const gap = s.start - curEnd;
    if (gap >= minGap && (inSilence(curEnd + gap / 2) || silences.length === 0)) {
      takes.push({ index: takes.length + 1, start: curStart, end: curEnd, text: curText.join(" "), bad: false });
      curStart = s.start;
      curText = [];
    }
    curEnd = Math.max(curEnd, s.end);
    curText.push(s.text.trim());
  }
  takes.push({ index: takes.length + 1, start: curStart, end: curEnd, text: curText.join(" "), bad: false });
  console.log(`Found ${takes.length} take(s)`);

  // Classify: LLM reads all takes in order and flags the mess-ups.
  console.log("Classifying takes (LLM)...");
  const listing = takes
    .map((t) => `[${t.index}] (${(t.end - t.start).toFixed(1)}s) ${t.text}`)
    .join("\n");
  const system = `You review takes from one raw talking-head recording session where the speaker attempts the same lines multiple times. Mark a take bad ONLY if it is a mess-up:
- false start or aborted line (often restarted in the next take)
- flub, self-correction, or "let me redo that" moments
- off-script chatter ("we got it", "perfect", cursing, direction)
- a clean line glued to a flub/restart inside the same take
- cut off mid-sentence
Clean repeated attempts of the same line are all GOOD (the editor picks later).
Respond ONLY with a JSON array: [{"index": <n>, "bad": <bool>, "reason": "<short, only when bad>"}] covering every index.`;
  const verdicts = await askClaudeJSON<{ index: number; bad: boolean; reason?: string }[]>(
    system,
    listing,
  );
  for (const v of verdicts) {
    const t = takes.find((x) => x.index === v.index);
    if (t && v.bad) {
      t.bad = true;
      t.reason = v.reason ?? "flagged";
    }
  }
  for (const t of takes) {
    if (t.end - t.start < MIN_TAKE_SEC && !t.bad) {
      t.bad = true;
      t.reason = "very short fragment";
    }
  }

  // Cut each take (frame-accurate re-encode) into outDir.
  await mkdir(outDir, { recursive: true });
  for (const t of takes) {
    const start = Math.max(0, t.start - pad);
    const end = Math.min(meta.durationSec, t.end + pad);
    const slug = t.text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().split(/\s+/).slice(0, 4).join("-") || "take";
    const name = `take_${String(t.index).padStart(2, "0")}_${t.bad ? "bad" : "good"}_${slug}.mp4`;
    const out = join(outDir, name);
    console.log(`Cutting ${name} (${start.toFixed(1)}-${end.toFixed(1)}s)...`);
    const takeDur = end - start;
    await ffmpeg(
      [
        "-ss", start.toFixed(3), "-i", input, "-t", takeDur.toFixed(3),
        // 30ms edge fades so take boundaries never pop.
        "-af", `afade=t=in:st=0:d=0.03,afade=t=out:st=${Math.max(0, takeDur - 0.03).toFixed(3)}:d=0.03`,
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
        "-c:a", "aac", "-b:a", "192k",
        out,
      ],
      `cut take ${t.index}`,
    );
    t.file = name;
    t.durationSec = (await probe(out)).durationSec;
  }

  // takes.txt manifest.
  const lines: string[] = [
    `Source: ${basename(input)}`,
    `Takes: ${takes.length}  good: ${takes.filter((t) => !t.bad).length}  bad: ${takes.filter((t) => t.bad).length}`,
    "",
  ];
  for (const t of takes) {
    lines.push(
      `${t.file}  ${t.durationSec!.toFixed(1)}s  ${t.bad ? `BAD (${t.reason})` : "GOOD"}`,
      `  "${t.text}"`,
      "",
    );
  }
  await writeFile(join(outDir, "takes.txt"), lines.join("\n"), "utf8");
  console.log(`\ntakes.txt written -> ${join(outDir, "takes.txt")}`);
  return takes;
}
