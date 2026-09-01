import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg } from "../lib/ffmpeg.js";
import type { TranscriptSegment } from "../lib/types.js";

/** Format seconds as an SRT timestamp: HH:MM:SS,mmm */
function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

export function segmentsToSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((seg, i) => `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text}\n`)
    .join("\n");
}

export interface CaptionStyle {
  fontName?: string;
  fontSize?: number;
  /** &HBBGGRR hex (ASS order) or a plain name-less hex we convert. */
  primaryColour?: string;
  outlineColour?: string;
  outline?: number;
  /** 2 = bottom-center, 8 = top-center (ASS numpad alignment). */
  alignment?: number;
  /** Vertical margin from the aligned edge, in pixels. */
  marginV?: number;
  bold?: boolean;
}

const DEFAULT_STYLE: Required<CaptionStyle> = {
  fontName: "Arial",
  fontSize: 18,
  primaryColour: "&HFFFFFF", // white
  outlineColour: "&H000000", // black
  outline: 2,
  alignment: 2,
  marginV: 60,
  bold: true,
};

function buildForceStyle(style: CaptionStyle): string {
  const s = { ...DEFAULT_STYLE, ...style };
  return [
    `FontName=${s.fontName}`,
    `FontSize=${s.fontSize}`,
    `PrimaryColour=${s.primaryColour}`,
    `OutlineColour=${s.outlineColour}`,
    `BorderStyle=1`,
    `Outline=${s.outline}`,
    `Shadow=0`,
    `Alignment=${s.alignment}`,
    `MarginV=${s.marginV}`,
    `Bold=${s.bold ? 1 : 0}`,
  ].join(",");
}

/**
 * Burn styled captions into a video from transcript segments.
 * Re-encodes video (subtitles filter requires it); audio is copied.
 */
export async function burnCaptions(
  input: string,
  output: string,
  segments: TranscriptSegment[],
  style: CaptionStyle = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "aep-srt-"));
  const srtPath = join(dir, "captions.srt");
  await writeFile(srtPath, segmentsToSrt(segments), "utf8");

  // Escape path for the ffmpeg filtergraph (colons and backslashes are special).
  const escaped = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const force = buildForceStyle(style).replace(/'/g, "\\'");

  await ffmpeg(
    [
      "-i", input,
      "-vf", `subtitles='${escaped}':force_style='${force}'`,
      "-c:a", "copy",
      output,
    ],
    "burn-captions",
  );
}
