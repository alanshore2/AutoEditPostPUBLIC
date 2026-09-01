import { spawn } from "node:child_process";
import { ffmpeg, probe } from "../lib/ffmpeg.js";
import { askClaudeJSON } from "../lib/llm.js";
import type { TranscriptSegment } from "../lib/types.js";

export interface CutRange {
  /** Seconds into the clip where the cut starts. */
  start: number;
  /** Seconds into the clip where the cut ends. */
  end: number;
  /** Why this range is being removed (logs / review). */
  reason?: string;
}

/** Run ffmpeg capturing stderr (filters like silencedetect log there). */
function ffmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostats", ...args]);
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      reject(new Error(`ffmpeg failed to start: ${e.message}`)),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(err)
        : reject(new Error(`ffmpeg (silencedetect) exited ${code}\n${err.slice(-2000)}`)),
    );
  });
}

/**
 * Find silences longer than minGapSec and propose cuts for them, leaving
 * padSec of breathing room on each side so speech never starts abruptly.
 */
export async function detectSilences(
  input: string,
  minGapSec = 0.6,
  padSec = 0.15,
  noiseDb = -35,
): Promise<CutRange[]> {
  const log = await ffmpegStderr([
    "-i", input,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minGapSec}`,
    "-f", "null", "-",
  ]);
  const cuts: CutRange[] = [];
  let start: number | null = null;
  for (const line of log.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (s) start = Number(s[1]);
    else if (e && start !== null) {
      const from = start + padSec;
      const to = Number(e[1]) - padSec;
      if (to - from > 0.1) cuts.push({ start: from, end: to, reason: "silence" });
      start = null;
    }
  }
  // A silence running to EOF logs silence_start but never silence_end.
  if (start !== null) {
    const { durationSec } = await probe(input);
    const from = start + padSec;
    if (durationSec - from > 0.1)
      cuts.push({ start: from, end: durationSec, reason: "trailing silence" });
  }
  return cuts;
}

/**
 * Ask the LLM to find bad takes, false starts, and flubs in the transcript.
 * Keeps the last take of anything repeated (the retake is the intended one).
 */
export async function planTakeCuts(segments: TranscriptSegment[]): Promise<CutRange[]> {
  if (segments.length === 0) return [];
  const lines = segments
    .map((s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`)
    .join("\n");
  const system = `You are a short-form video editor. The user gives a timestamped transcript of a single talking-head clip. Find content that should be CUT:
- repeated takes of the same line (keep the LAST take; cut the earlier attempts)
- false starts, flubs, and self-corrections ("wait, let me start over")
- dead filler that adds nothing ("um, okay, so, where was I")
Do NOT cut content just to shorten the video; only cut mistakes and repeats.
Respond ONLY with a JSON array: [{"start": <sec>, "end": <sec>, "reason": "<short>"}].
Use the transcript timestamps; prefer cutting whole segments. Return [] if the clip is clean.`;
  const cuts = await askClaudeJSON<CutRange[]>(system, lines);
  return cuts.filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
}

/** Merge overlapping/adjacent cut ranges, clamp to clip bounds, drop slivers. */
export function mergeCuts(cuts: CutRange[], durationSec: number): CutRange[] {
  const valid = cuts
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(durationSec, c.end) }))
    .filter((c) => c.end - c.start >= 0.2)
    .sort((a, b) => a.start - b.start);
  const merged: CutRange[] = [];
  for (const c of valid) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 0.05) {
      last.end = Math.max(last.end, c.end);
      if (c.reason && last.reason && !last.reason.includes(c.reason))
        last.reason += ` + ${c.reason}`;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

/**
 * Remove the cut ranges from the video. Re-encodes (frame-accurate trims
 * can't stream-copy); x264 crf 18 keeps quality visually lossless.
 */
export async function applyCuts(
  input: string,
  cuts: CutRange[],
  output: string,
): Promise<void> {
  const { durationSec, hasAudio } = await probe(input);
  // Invert cuts into keep ranges.
  const keeps: Array<[number, number]> = [];
  let pos = 0;
  for (const c of cuts) {
    if (c.start - pos > 0.05) keeps.push([pos, c.start]);
    pos = Math.max(pos, c.end);
  }
  if (durationSec - pos > 0.05) keeps.push([pos, durationSec]);
  if (keeps.length === 0) throw new Error("Cuts would remove the entire clip");

  const parts: string[] = [];
  const labels: string[] = [];
  keeps.forEach(([a, b], i) => {
    parts.push(`[0:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[v${i}]`);
    if (hasAudio) {
      // 30ms fades at every cut boundary — without them each join pops.
      const segDur = b - a;
      const fadeOutStart = Math.max(0, segDur - 0.03).toFixed(3);
      parts.push(
        `[0:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.03,afade=t=out:st=${fadeOutStart}:d=0.03[a${i}]`,
      );
    }
    labels.push(hasAudio ? `[v${i}][a${i}]` : `[v${i}]`);
  });
  parts.push(
    `${labels.join("")}concat=n=${keeps.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? "[a]" : ""}`,
  );

  const args = ["-i", input, "-filter_complex", parts.join(";"), "-map", "[v]"];
  if (hasAudio) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k");
  args.push("-c:v", "libx264", "-crf", "18", "-preset", "veryfast", output);
  await ffmpeg(args, "ffmpeg (apply cuts)");
}
