import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg } from "../lib/ffmpeg.js";
import type { Word } from "../lib/types.js";
import type { ChinSample } from "./video.js";

/**
 * Dynamic (word-level animated) captions in the style of the Captions / Submagic
 * apps. Renders an ASS subtitle file with per-word timing and animation, then
 * burns it in with FFmpeg.
 *
 * Two modes:
 *  - "word":   one word on screen at a time, pops/bounces in (Captions default)
 *  - "phrase": a few words at once, the spoken word highlighted (Hormozi look)
 */
export interface CaptionTemplate {
  name: string;
  mode: "word" | "phrase";
  fontName: string;
  /** Font size as a fraction of video height (e.g. 0.06 -> 6% of height). */
  fontScale: number;
  /** Hex colors, "#RRGGBB". */
  primary: string;
  highlight: string;
  outlineColor: string;
  /** Outline thickness as a fraction of the font size. */
  outlineScale: number;
  bold: boolean;
  uppercase: boolean;
  /** ASS numpad alignment: 2 = bottom-center, 5 = middle-center, 8 = top. */
  alignment: number;
  /** Vertical margin from the aligned edge, as a fraction of height. */
  marginVScale: number;
  /** phrase mode: how many words share the screen. */
  wordsPerChunk: number;
  animation: "pop" | "bounce" | "none";
}

export const TEMPLATES: Record<string, CaptionTemplate> = {
  // Captions-app default: single bold word, white, pops in, lower third.
  pop: {
    name: "pop",
    mode: "word",
    fontName: "Montserrat",
    fontScale: 0.075,
    primary: "#FFFFFF",
    highlight: "#FFE94A",
    outlineColor: "#000000",
    outlineScale: 0.11,
    bold: true,
    uppercase: true,
    alignment: 2,
    marginVScale: 0.22,
    wordsPerChunk: 1,
    animation: "pop",
  },
  // Springy overshoot on each word.
  bounce: {
    name: "bounce",
    mode: "word",
    fontName: "Montserrat",
    fontScale: 0.08,
    primary: "#FFFFFF",
    highlight: "#FF4D6D",
    outlineColor: "#000000",
    outlineScale: 0.12,
    bold: true,
    uppercase: true,
    alignment: 2,
    marginVScale: 0.22,
    wordsPerChunk: 1,
    animation: "bounce",
  },
  // Alex Hormozi style: 3 uppercase words, active word highlighted yellow.
  hormozi: {
    name: "hormozi",
    mode: "phrase",
    // Montserrat Black ships in the fonts-montserrat package and gives the heavy
    // Hormozi look. Swap to "Anton" if you install it for the condensed variant.
    fontName: "Montserrat Black",
    fontScale: 0.07,
    primary: "#FFFFFF",
    // Cover-palette blue — captions and cover text share one color system.
    highlight: "#4361EE",
    outlineColor: "#000000",
    outlineScale: 0.13,
    bold: true,
    uppercase: true,
    // Top-anchored just below the chin: the anchor edge never moves, so
    // 1-line and 2-line chunks stay put instead of jumping vertically.
    alignment: 2,
    marginVScale: 0.15,
    wordsPerChunk: 3,
    animation: "pop",
  },
  // hormozi_top: same heavy look, anchored to the TOP of the frame. For
  // screen-recording / show-n-tell clips where the subject films a monitor and
  // POINTS at the content in the lower-middle — top-anchored captions stay out
  // of the pointing zone and off the active message being read. alignment 8 =
  // top; marginV is measured from the top edge.
  hormozi_top: {
    name: "hormozi_top",
    mode: "phrase",
    fontName: "Montserrat Black",
    fontScale: 0.07,
    primary: "#FFFFFF",
    highlight: "#4361EE",
    outlineColor: "#000000",
    outlineScale: 0.13,
    bold: true,
    uppercase: true,
    alignment: 8,
    marginVScale: 0.06,
    wordsPerChunk: 3,
    animation: "pop",
  },
  // video-use house style: 2 uppercase words at a time, white, quick pop.
  duo: {
    name: "duo",
    mode: "phrase",
    fontName: "Montserrat Black",
    fontScale: 0.065,
    primary: "#FFFFFF",
    highlight: "#FFFFFF",
    outlineColor: "#000000",
    outlineScale: 0.12,
    bold: true,
    uppercase: true,
    alignment: 8,
    marginVScale: 0.62,
    wordsPerChunk: 2,
    animation: "pop",
  },
  // Karaoke: full phrase, spoken word fills green, no per-word pop.
  karaoke: {
    name: "karaoke",
    mode: "phrase",
    fontName: "Montserrat",
    fontScale: 0.055,
    primary: "#FFFFFF",
    highlight: "#38E07B",
    outlineColor: "#000000",
    outlineScale: 0.1,
    bold: true,
    uppercase: false,
    alignment: 2,
    marginVScale: 0.16,
    wordsPerChunk: 5,
    animation: "none",
  },
  // Neon: single word, cyan with a thick colored glow-ish outline.
  neon: {
    name: "neon",
    mode: "word",
    fontName: "Montserrat",
    fontScale: 0.075,
    primary: "#00F0FF",
    highlight: "#FF00E5",
    outlineColor: "#0A0A2A",
    outlineScale: 0.16,
    bold: true,
    uppercase: true,
    alignment: 2,
    marginVScale: 0.22,
    wordsPerChunk: 1,
    animation: "pop",
  },
};

export function listTemplates(): string[] {
  return Object.keys(TEMPLATES);
}

/** "#RRGGBB" -> ASS "&H00BBGGRR" (ASS is BGR with an alpha byte). */
function hexToAss(hex: string): string {
  const h = hex.replace("#", "");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

/** Seconds -> ASS time "H:MM:SS.cc" (centiseconds). */
function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${h}:${p(m)}:${p(s)}.${p(c)}`;
}

/** Escape text for an ASS Dialogue line. */
function assEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")");
}

/** Animation override injected at the start of a word/chunk event. */
function animTag(anim: CaptionTemplate["animation"]): string {
  switch (anim) {
    case "pop":
      return "\\fad(40,0)\\fscx72\\fscy72\\t(0,110,\\fscx100\\fscy100)";
    case "bounce":
      return "\\fad(30,0)\\fscx55\\fscy55\\t(0,90,\\fscx112\\fscy112)\\t(90,170,\\fscx100\\fscy100)";
    default:
      return "\\fad(40,0)";
  }
}

interface Chunk {
  words: Word[];
}

/**
 * Group words into chunks, breaking on size, a natural pause (>0.6s gap), or a
 * sentence boundary (Whisper segment end) — so a chunk never straddles two
 * sentences and phrases read naturally.
 */
function chunkWords(
  words: Word[],
  perChunk: number,
  segments?: { start: number; end: number }[],
): Chunk[] {
  const ends = (segments ?? []).map((s) => s.end).sort((a, b) => a - b);
  let si = 0;
  const chunks: Chunk[] = [];
  let cur: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    const gap = prev ? w.start - prev.end : 0;
    if (cur.length >= perChunk || (prev && gap > 0.6 && cur.length > 0)) {
      chunks.push({ words: cur });
      cur = [];
    }
    cur.push(w);
    if (si < ends.length && w.end >= ends[si] - 0.1) {
      chunks.push({ words: cur });
      cur = [];
      si++;
    }
  }
  if (cur.length) chunks.push({ words: cur });
  return chunks;
}

function endOf(words: Word[], i: number): number {
  // A word stays on screen until the next begins (feels continuous), with a
  // small tail on the last word.
  const next = words[i + 1];
  return next ? Math.max(words[i].end, next.start) : words[i].end + 0.35;
}

export function buildAss(
  words: Word[],
  template: CaptionTemplate,
  width: number,
  height: number,
  segments?: { start: number; end: number }[],
  chinTrack?: ChinSample[],
  chinPad = 0.13,
): string {
  const t = template;
  const fontSize = Math.round(t.fontScale * height);
  const outline = Math.max(2, Math.round(fontSize * t.outlineScale));
  const marginV = Math.round(t.marginVScale * height);
  const primary = hexToAss(t.primary);
  const outlineC = hexToAss(t.outlineColor);
  const highlight = hexToAss(t.highlight);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    // 0 = smart wrapping (top line wider); keeps long phrases inside the frame.
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${t.fontName},${fontSize},${primary},&H000000FF,${outlineC},&H00000000,${
      t.bold ? 1 : 0
    },0,0,0,100,100,0,0,1,${outline},0,${t.alignment},60,60,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text",
  ];

  const cased = (s: string) => (t.uppercase ? s.toUpperCase() : s);
  const lines: string[] = [];

  // With a chin track, pin each event's TOP-center just below the lowest chin
  // position seen during its window, so captions follow the subject and never
  // cover the face. \an8 anchors the top edge; \pos overrides style margins.
  const posTag = (startSec: number, endSec: number): string => {
    if (!chinTrack || chinTrack.length === 0) return "";
    const win = chinTrack.filter((p) => p.t >= startSec - 0.6 && p.t <= endSec + 0.6);
    const src = win.length > 0 ? win : chinTrack;
    const chin = Math.max(...src.map((p) => p.chin));
    const pad = chinPad;
    // IG safe zone: the bottom ~15% is covered by UI, so a 2-line caption
    // block must END by 0.85H — clamp the block top accordingly. If the chin
    // sits very low this can graze it; UI overlap is the worse failure.
    const maxY = Math.round(0.85 * height - fontSize * 2.9);
    const y = Math.min(Math.round((chin + pad) * height), maxY);
    return `\\an8\\pos(${Math.round(width / 2)},${y})`;
  };

  if (t.mode === "word") {
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const endSec = endOf(words, i);
      const start = assTime(w.start);
      const end = assTime(endSec);
      const text = `{${posTag(w.start, endSec)}${animTag(t.animation)}}${assEscape(cased(w.word))}`;
      lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,${text}`);
    }
  } else {
    // phrase mode: show the whole chunk; recolor the currently spoken word.
    // Time each word against the *global* next word so chunk boundaries don't
    // overlap (the last word of a chunk must end when the next chunk begins).
    const chunks = chunkWords(words, t.wordsPerChunk, segments);
    let gi = 0;
    for (const chunk of chunks) {
      const cw = chunk.words;
      // One position for the whole chunk — every per-word event shares it, so
      // the block never jumps while its words highlight.
      const chunkPos = posTag(cw[0].start, cw[cw.length - 1].end);
      for (let i = 0; i < cw.length; i++) {
        const start = assTime(cw[i].start);
        const nextGlobal = words[gi + 1];
        const endSec = nextGlobal
          ? Math.max(cw[i].end, nextGlobal.start)
          : cw[i].end + 0.35;
        const end = assTime(endSec);
        gi++;
        const rendered = cw
          .map((w, idx) => {
            const word = assEscape(cased(w.word));
            return idx === i ? `{\\c${highlight}}${word}{\\c${primary}}` : word;
          })
          .join(" ");
        // Animate only when the chunk first appears; later words swap the
        // highlight with no fade so the chunk doesn't visibly re-render.
        const intro =
          i === 0
            ? `{${chunkPos}${animTag(t.animation)}}`
            : chunkPos
              ? `{${chunkPos}}`
              : "";
        lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,${intro}${rendered}`);
      }
    }
  }

  return header.concat(lines).join("\n") + "\n";
}

/**
 * Burn dynamic captions into a video using a named template.
 * `width`/`height` should be the final frame size (post-reframe).
 */
export async function burnDynamicCaptions(
  input: string,
  output: string,
  words: Word[],
  templateName: string,
  width: number,
  height: number,
  segments?: { start: number; end: number }[],
  chinTrack?: ChinSample[],
  chinPad?: number,
): Promise<void> {
  const template = TEMPLATES[templateName];
  if (!template) {
    throw new Error(
      `Unknown caption style "${templateName}". Available: ${listTemplates().join(", ")}`,
    );
  }
  if (words.length === 0) {
    throw new Error(
      "Dynamic captions need word-level timestamps, but none were returned. " +
        "Use TRANSCRIBE_PROVIDER=openai (whisper-1) or local whisper with word timestamps.",
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "aep-ass-"));
  const assPath = join(dir, "captions.ass");
  await writeFile(assPath, buildAss(words, template, width, height, segments, chinTrack, chinPad), "utf8");

  const escaped = assPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const fontsDir = process.env.CAPTION_FONTS_DIR;
  const assFilter = fontsDir
    ? `ass='${escaped}':fontsdir='${fontsDir.replace(/:/g, "\\:")}'`
    : `ass='${escaped}'`;

  await ffmpeg(["-i", input, "-vf", assFilter, "-c:a", "copy", output], "burn-dynamic-captions");
}
