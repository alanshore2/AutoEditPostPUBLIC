import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, probe } from "../lib/ffmpeg.js";
import { askClaudeJSON } from "../lib/llm.js";

/** Number words -> digits, so "seven" in a transcript grounds a "7" on a cover. */
const NUMWORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40",
  fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
  hundred: "100", thousand: "1000", percent: "%",
};
function normalizeNumbers(s: string): string {
  return " " + s.toLowerCase().replace(/[a-z]+|%/g, (w) => NUMWORDS[w] ?? w) + " ";
}
/**
 * True if every number that appears in `text` also appears (as digits or spelled
 * out) in `transcript`. Catches fabricated stats like "40%" / "90%" that the
 * model invents for a punchier hook. A "%" on the cover requires "%"/"percent"
 * in the transcript.
 */
function numbersAreGrounded(text: string, transcript: string): boolean {
  const norm = normalizeNumbers(transcript);
  const nums = text.match(/\d+/g) ?? [];
  for (const n of nums) if (!new RegExp(`(^|\\D)${n}(\\D|$)`).test(norm)) return false;
  if (/%/.test(text) && !/%/.test(norm)) return false;
  return true;
}

/**
 * Bake the cover into the video as its first ~0.12s (CapCut-style): the feed
 * thumbnail becomes the cover without platform thumbnail APIs (Postiz only
 * supports custom thumbnails on YouTube). Cover segment is encoded to match
 * the main video, then joined with a stream-copy concat.
 */
export async function prependCover(video: string, coverPng: string, output: string): Promise<void> {
  const meta = await probe(video);
  const dir = await mkdtemp(join(tmpdir(), "aep-coverintro-"));
  try {
    const seg = join(dir, "cover-seg.mp4");
    const dur = Math.max(3 / meta.fps, 0.12); // at least 3 frames
    await ffmpeg(
      [
        "-loop", "1", "-t", dur.toFixed(3), "-i", coverPng,
        "-f", "lavfi", "-t", dur.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo",
        "-vf", `scale=${meta.width}:${meta.height},setsar=1`,
        "-r", String(meta.fps),
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        seg,
      ],
      "cover-segment",
    );
    // concat demuxer resolves relative paths against the LIST FILE's dir —
    // absolute paths only, or the main video silently goes missing.
    const list = join(dir, "list.txt");
    const absVideo = resolve(video);
    await writeFile(list, `file '${seg}'\nfile '${absVideo.replace(/'/g, "'\\''")}'\n`, "utf8");
    const joined = join(dir, "joined.mp4");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined], "cover-concat");
    // Validate the stream-copy join; if the demuxer mangled it, re-encode.
    const check = await probe(joined);
    if (Math.abs(check.durationSec - (meta.durationSec + dur)) > 1.0) {
      await ffmpeg(
        [
          "-i", seg, "-i", video,
          "-filter_complex",
          "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
          "-map", "[v]", "-map", "[a]",
          "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
          "-c:a", "aac", "-b:a", "192k",
          joined,
        ],
        "cover-concat-reencode",
      );
    }
    await ffmpeg(["-i", joined, "-c", "copy", output], "cover-finalize");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Variant caption for the mirrored (trial reel) clone: same idea and CTA,
 * different hook and wording, so the two posts don't read as duplicates.
 */
export async function writeMirrorCaption(
  original: string,
  transcript: string,
  outPath: string,
): Promise<string> {
  const system = `You rewrite an Instagram reel caption for a second posting of the same video. Keep the same voice (casual, direct, dry, lowercase-leaning), the same core specific, and the same comment CTA if present — but change the hook line and rephrase every sentence so it does not read as a duplicate. Same length or shorter. Same bans: no emoji spam, no guru words, no title case.
Respond ONLY with valid JSON on one line: {"caption": "<rewritten caption, line breaks escaped as \\n>"}`;
  const { caption } = await askClaudeJSON<{ caption: string }>(
    system,
    `Original caption:\n${original}\n\nVideo transcript:\n${transcript}`,
  );
  await writeFile(outPath, caption.trim() + "\n", "utf8");
  return caption;
}

/**
 * Generate the reel's cover: grab a clean frame from the (pre-caption) video,
 * have the LLM write kicker + headline from the transcript, and render them
 * in the house style (blue accent, white condensed uppercase, bottom fade).
 */
export async function makeCover(
  cleanVideo: string,
  transcript: string,
  outPath: string,
  mirrorOutPath?: string,
  pre?: { kicker: string; accent: string; headline: string },
): Promise<void> {
  const system = `You write text for an Instagram reel COVER IMAGE (the thumbnail) for an AI-setter agency owner. The cover must be about the SPECIFIC point THIS transcript makes — never generic AI-setter advice, never a topic the transcript doesn't cover. Say it with intrigue (different words from the spoken hook), not description.
HARD RULE ON NUMBERS: every digit/percentage on the cover must appear in the transcript (as digits or spelled out). NEVER invent a statistic, percentage, or count to sound punchy. If the transcript has no compelling number, use a short verbatim PHRASE from it instead — no number at all.
Respond ONLY with JSON:
{"kicker": "<tiny top line, casual question or aside, <= 6 words, NO invented numbers>",
 "accent": "<the punch: 1-3 words — a real number FROM THE TRANSCRIPT, or a key phrase the speaker actually says>",
 "headline": "<rest of the statement, <= 4 words>"}`;
  let text = pre ?? (await askClaudeJSON<{ kicker: string; accent: string; headline: string }>(system, transcript));
  // Deterministic backstop: the "never invent numbers" instruction alone has
  // failed (40%, 90% fabricated). Verify, retry naming the bad number, then
  // fall back to a number-free cover. (Pre-supplied text is already validated.)
  for (let attempt = 0; !pre && attempt < 2; attempt++) {
    const joined = `${text.kicker} ${text.accent} ${text.headline}`;
    if (numbersAreGrounded(joined, transcript)) break;
    const bad = (joined.match(/\d+%?/g) ?? []).filter((n) => !numbersAreGrounded(n, transcript));
    console.log(`  cover: fabricated number(s) ${bad.join(", ")} not in transcript — regenerating`);
    text = await askClaudeJSON(
      `${system}\n\nYour previous answer used ${bad.join(", ")}, which is NOT in the transcript. Redo with ZERO numbers — use only verbatim phrases from the transcript.`,
      transcript,
    );
  }

  console.log(`  cover text: "${text.kicker}" / "${text.accent}" / "${text.headline}"`);
  const dir = await mkdtemp(join(tmpdir(), "aep-cover-"));
  try {
    const frame = join(dir, "base.png");
    // Pick an inviting frame (smile + open eyes via OpenCV); fall back to 25%.
    let at: number;
    try {
      const pick = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "pick_frame.py");
      at = await new Promise<number>((resolve, reject) => {
        const child = spawn("python3", [pick, cleanVideo], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 && Number.isFinite(Number(out.trim()))
            ? resolve(Number(out.trim()))
            : reject(new Error(`pick_frame.py exited ${code}`)),
        );
      });
      console.log(`  cover: best frame at ${at.toFixed(1)}s (smile/eyes scored)`);
    } catch {
      at = (await probe(cleanVideo)).durationSec * 0.25;
      console.log("  cover: frame scoring failed, using 25% mark");
    }
    await ffmpeg(["-ss", at.toFixed(2), "-i", cleanVideo, "-frames:v", "1", frame], "cover-frame");
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "make_cover.py");
    const render = (base: string, out: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn("python3", [script, base, out, text.kicker, text.accent, text.headline], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (d) => (err += d.toString()));
        child.on("error", (e) => reject(new Error(`make_cover.py failed to start: ${e.message}`)));
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`make_cover.py exited ${code}\n${err.slice(-800)}`)),
        );
      });
    await render(frame, outPath);
    if (mirrorOutPath) {
      // Mirror cover: flip the BASE frame, then overlay text fresh — flipping
      // the finished cover would mirror the text.
      const flipped = join(dir, "base_m.png");
      await ffmpeg(["-i", frame, "-vf", "hflip", flipped], "cover-frame-mirror");
      await render(flipped, mirrorOutPath);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Write the Instagram post caption for a reel — in the speaker's own voice,
 * built from the transcript. Deliberately anti-slop: reads like a text
 * message from a real operator, not marketing copy.
 */
export async function writePostCaption(
  transcript: string,
  outPath: string,
  cta?: string | null,
  pre?: string,
): Promise<string> {
  if (pre) {
    await writeFile(outPath, pre.trim() + "\n", "utf8");
    return pre.trim();
  }
  const system = `You write Instagram reel captions for a real person: an AI-setter agency owner posting raw talking-head reels. Write the caption like HE would text it — casual, direct, confident, a little dry.

Rules:
- The caption MUST be about the SPECIFIC point THIS transcript makes. Do NOT write generic AI-setter advice or drift to a topic the transcript doesn't cover. If the reel is about uneven contractions, the caption is about uneven contractions.
- First line: scroll-stopping hook, under 8 words. No clickbait punctuation, no ALL CAPS.
- 2-4 short lines total, blank line between thoughts.
- Work in ONE concrete specific from the video (a phrase he actually says). Any number you use MUST appear in the transcript — never invent a statistic or percentage.
${cta ? `- End the caption with EXACTLY this line, verbatim: "${cta}"` : "- End with a blunt one-liner, not a question. NEVER invent a \"comment X\" call-to-action."}
- BANNED: emoji (one max, only if it truly earns it), generic hashtags, "game-changer", "unlock", "imagine", "dive in", "here's the thing", rhetorical question stacks, em dashes, title case headlines.
- 2-3 hashtags allowed ONLY if hyper-specific to the niche; zero is fine.
- Lowercase-leaning. Sounds human. If it could be any guru's caption, rewrite it.

Respond ONLY with valid JSON on one line: {"caption": "<the caption text, line breaks escaped as \\n>"}`;
  const { caption } = await askClaudeJSON<{ caption: string }>(system, transcript);
  await writeFile(outPath, caption.trim() + "\n", "utf8");
  return caption;
}
