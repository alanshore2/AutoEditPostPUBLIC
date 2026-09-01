import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ffmpeg, probe } from "../lib/ffmpeg.js";
import { askClaudeJSON } from "../lib/llm.js";
import type { Word } from "../lib/types.js";

/**
 * Screen cards: a floating semi-transparent
 * panel composited over the talking head. Two states — _a base and _b with the
 * key line highlighted blue — swapped at the moment the line is spoken.
 * Composite runs BEFORE caption burn; on the mirror variant it must run AFTER
 * the flip (the card has text).
 */

export interface CardSpec {
  /** Renderer JSON for scripts/render_card.py. */
  lines: { text: string; kind: string | null }[];
  cta?: string;
  panel?: "dark" | "red";
  /** The words the speaker actually SAYS at the highlight moment (for beat search). */
  hl_spoken: string;
}

export interface CardTiming {
  tIn: number;
  tHl: number;
  tOut: number;
}

const SPEC_SYSTEM = `You convert one screen-card build spec (a markdown section) into render JSON for a compact "tease" card.

Output ONLY JSON:
{
  "lines": [{"text": "...", "kind": "header|grey|body|hl|red|dim|dim2|null"}],
  "cta": "comment KEYWORD for the full block",
  "panel": "dark" | "red",
  "hl_spoken": "the exact words the speaker says at the highlight moment"
}

Rules:
- TEASE, not the full card: max 10 content lines. Show the header, the key
  highlighted content (kind "hl"), and let remaining content trail off with
  one "dim" then one "dim2" line ending in "..." — that's the hook to comment.
- Monospace 34px in a 900px panel: wrap lines at ~36 characters. Preserve the
  spec's indentation style (arrows, quotes).
- kind "hl" = the line(s) the Animate: instruction says turn blue. "grey" =
  prospect/context lines. "red" = wrong/struck content (State B cards).
  "header" = the ## title line.
- hl_spoken: take from the Animate: instruction — the spoken phrase that
  triggers the highlight, as the speaker would say it (lowercase, no quotes).
- SCRUB (omit entirely, never render): booking URLs, prices, internal or
  personal names, real prospect DMs, private workspace links. If a line
  contains one, drop or rewrite the line without it.
- CTA: keep the default unless the card spec names a different comment word.`;

/** Ask the LLM to turn a card's spec section into renderer JSON. */
export async function genCardSpec(cardSectionMd: string): Promise<CardSpec> {
  return askClaudeJSON<CardSpec>(SPEC_SYSTEM, cardSectionMd);
}

/** Render a CardSpec to <base>_a.png / <base>_b.png via scripts/render_card.py. */
export async function renderCard(spec: CardSpec, outBase: string): Promise<{ a: string; b: string }> {
  const dir = await mkdtemp(join(tmpdir(), "aep-card-"));
  const specPath = join(dir, "spec.json");
  await writeFile(specPath, JSON.stringify(spec), "utf8");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", ["scripts/render_card.py", specPath, outBase], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`render_card.py exited ${code}`)),
    );
  });
  return { a: `${outBase}_a.png`, b: `${outBase}_b.png` };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

/**
 * Find when a spoken phrase starts, from word-level timestamps.
 * Sliding-window token match; returns the start of the best window when at
 * least 60% of the phrase tokens line up. Null if nothing matches.
 */
export function findBeat(words: Word[], phrase: string): number | null {
  const target = norm(phrase);
  if (target.length === 0 || words.length === 0) return null;
  const tokens = words.map((w) => norm(w.word)[0] ?? "");
  let best = { score: 0, at: -1 };
  for (let i = 0; i <= tokens.length - Math.min(target.length, tokens.length); i++) {
    let hits = 0;
    for (let j = 0; j < target.length && i + j < tokens.length; j++) {
      if (tokens[i + j] === target[j]) hits++;
    }
    const score = hits / target.length;
    if (score > best.score) best = { score, at: i };
  }
  if (best.score < 0.6) return null;
  return words[best.at].start;
}

/**
 * Composite the two card states over the video with alpha fades:
 * _a fades in at tIn, holds; hard-swaps to _b at tHl; _b fades out at tOut.
 * Overlays are PTS-shifted to their windows and gated with enable= so nothing
 * lingers after its window (ffmpeg overlay repeats last frame otherwise).
 */
export async function applyCard(
  input: string,
  output: string,
  aPng: string,
  bPng: string,
  t: CardTiming,
): Promise<void> {
  const durA = Math.max(0.5, t.tHl - t.tIn);
  const durB = Math.max(0.5, t.tOut - t.tHl);
  const meta = await probe(input);
  const filter = [
    `[1:v]format=rgba,fade=t=in:st=0:d=0.35:alpha=1,` +
      `setpts=PTS-STARTPTS+${t.tIn.toFixed(3)}/TB[ca]`,
    `[2:v]format=rgba,fade=t=out:st=${(durB - 0.35).toFixed(3)}:d=0.35:alpha=1,` +
      `setpts=PTS-STARTPTS+${t.tHl.toFixed(3)}/TB[cb]`,
    `[0:v][ca]overlay=0:0:enable='between(t,${t.tIn.toFixed(3)},${t.tHl.toFixed(3)})'[v1]`,
    `[v1][cb]overlay=0:0:enable='between(t,${t.tHl.toFixed(3)},${t.tOut.toFixed(3)})'[vout]`,
  ].join(";");
  await ffmpeg(
    [
      "-i", input,
      "-loop", "1", "-t", durA.toFixed(3), "-i", aPng,
      "-loop", "1", "-t", durB.toFixed(3), "-i", bPng,
      "-filter_complex", filter,
      "-map", "[vout]",
      ...(meta.hasAudio ? ["-map", "0:a", "-c:a", "copy"] : []),
      output,
    ],
    "apply-card",
  );
}

/**
 * Resolve card timing against the (post-cut) transcript. The card rides the
 * spoken beat: fade in shortly BEFORE the key line, flip to the highlight
 * state on the line, gone a couple seconds after — a punch, not a poster.
 */
export function resolveCardTiming(
  words: Word[],
  hlSpoken: string,
  durationSec: number,
  opts: { preRoll?: number; holdAfter?: number } = {},
): CardTiming & { beatFound: boolean } {
  const preRoll = opts.preRoll ?? 2.0;
  const holdAfter = opts.holdAfter ?? 2.5;
  const beat = findBeat(words, hlSpoken);
  let tHl = beat ?? durationSec * 0.4;
  tHl = Math.max(tHl, 1.6); // never earlier than the viewer can register
  const tIn = Math.max(0.8, tHl - preRoll);
  let tOut = Math.min(tHl + holdAfter, durationSec - 0.5);
  if (tOut <= tHl + 0.5) tOut = Math.min(tHl + 1.0, durationSec - 0.1);
  return { tIn, tHl, tOut, beatFound: beat !== null };
}

/** Pull one card's section out of the build-spec markdown by number. */
export async function cardSection(specsPath: string, cardNo: number): Promise<string | null> {
  const md = await readFile(specsPath, "utf8");
  const tag = `CARD ${String(cardNo).padStart(2, "0")}`;
  const start = md.indexOf(`### ${tag}`);
  if (start === -1) return null;
  const next = md.indexOf("### CARD", start + 8);
  return md.slice(start, next === -1 ? undefined : next).trim();
}

const MATCH_SYSTEM = `You match a spoken-reel transcript to its teleprompter script number.
You get the transcript of one recorded take and the full teleprompter file
(50 numbered scripts). Reply ONLY with JSON:
{"reel": <1-50>, "confidence": <0-1>, "reason": "<one line>"}
Match on content, not exact wording — the speaker ad-libs. If nothing matches
well, use confidence below 0.5.`;

/** Match one take's transcript to its teleprompter number. */
export async function matchTeleprompter(
  transcriptText: string,
  teleprompterMd: string,
): Promise<{ reel: number; confidence: number; reason: string }> {
  return askClaudeJSON(MATCH_SYSTEM, `TAKE TRANSCRIPT:\n${transcriptText}\n\nTELEPROMPTER FILE:\n${teleprompterMd}`);
}
