import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { existsSync } from "node:fs";
import { ffmpeg, probe } from "../lib/ffmpeg.js";
import { askClaudeJSON } from "../lib/llm.js";
import type {
  BrollLibrary,
  BrollClip,
  BrollPlacement,
  TranscriptSegment,
} from "../lib/types.js";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const INDEX_FILE = "index.json";

/**
 * Build or refresh the b-roll library index for a directory.
 * - Discovers video files.
 * - Preserves any existing descriptions/tags in index.json.
 * - Fills in duration via ffprobe.
 * - New clips get a placeholder description derived from the filename, which
 *   you should edit (or later auto-tag with a vision model).
 */
export async function indexBroll(dir: string): Promise<BrollLibrary> {
  const indexPath = join(dir, INDEX_FILE);
  let existing: BrollLibrary = { clips: [] };
  if (existsSync(indexPath)) {
    existing = JSON.parse(await readFile(indexPath, "utf8"));
  }
  const byFile = new Map(existing.clips.map((c) => [c.file, c]));

  const entries = await readdir(dir);
  const videos = entries.filter((f) => VIDEO_EXTS.has(extname(f).toLowerCase()));

  const clips: BrollClip[] = [];
  for (const file of videos.sort()) {
    const prev = byFile.get(file);
    let durationSec = prev?.durationSec;
    try {
      durationSec = (await probe(join(dir, file))).durationSec;
    } catch {
      // leave whatever we had
    }
    clips.push({
      file,
      description:
        prev?.description ??
        basename(file, extname(file)).replace(/[-_]+/g, " ").trim(),
      tags: prev?.tags ?? [],
      durationSec,
    });
  }

  const library: BrollLibrary = { clips };
  await writeFile(indexPath, JSON.stringify(library, null, 2) + "\n", "utf8");
  return library;
}

export async function loadLibrary(dir: string): Promise<BrollLibrary> {
  const indexPath = join(dir, INDEX_FILE);
  if (!existsSync(indexPath)) {
    throw new Error(
      `No ${INDEX_FILE} in ${dir}. Run "autoeditpost index --broll ${dir}" first, then add descriptions.`,
    );
  }
  return JSON.parse(await readFile(indexPath, "utf8"));
}

const MATCH_SYSTEM = `You are a video editor placing b-roll cutaways over a talking-head clip.
You receive a timestamped transcript and a library of available b-roll clips with descriptions.
Choose where cutaways strengthen the message. Rules:
- Only use clips from the provided library (match by exact "file").
- Place a cutaway when the words clearly evoke something a clip shows.
- Keep cutaways 1.5-4s. Never overlap two cutaways.
- Prefer quality over quantity: a 30s clip usually wants 2-4 cutaways, not 10.
- Leave the opening ~2s on the speaker so the viewer connects first.
- "start" and "duration" are in seconds relative to the talking-head clip.
Return ONLY a JSON array of {file, start, duration, reason}. No prose.`;

/** Ask the model to choose b-roll placements from the transcript. */
export async function matchBroll(
  segments: TranscriptSegment[],
  library: BrollLibrary,
): Promise<BrollPlacement[]> {
  const transcript = segments
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n");
  const clips = library.clips
    .map((c) => `- ${c.file} (${(c.durationSec ?? 0).toFixed(1)}s): ${c.description}`)
    .join("\n");

  const user = `TRANSCRIPT:\n${transcript}\n\nB-ROLL LIBRARY:\n${clips}`;
  const placements = await askClaudeJSON<BrollPlacement[]>(MATCH_SYSTEM, user);

  // Validate against the library and clamp durations to available footage.
  const known = new Map(library.clips.map((c) => [c.file, c]));
  return placements
    .filter((p) => known.has(p.file))
    .map((p) => {
      const avail = known.get(p.file)!.durationSec;
      const duration = avail ? Math.min(p.duration, avail) : p.duration;
      return { ...p, duration };
    })
    .sort((a, b) => a.start - b.start);
}

/**
 * Overlay b-roll cutaways onto the A-roll, keeping the A-roll's audio running
 * underneath. Each placement scales its clip to cover the base frame and shows
 * it only during its window.
 */
export async function applyBroll(
  input: string,
  brollDir: string,
  placements: BrollPlacement[],
  output: string,
): Promise<void> {
  if (placements.length === 0) {
    throw new Error("No b-roll placements to apply.");
  }
  const base = await probe(input);
  // Guard against placements the model put outside the video.
  placements = placements
    .filter((p) => p.start < base.durationSec - 1)
    .map((p) => ({ ...p, duration: Math.min(p.duration, base.durationSec - p.start) }));
  if (placements.length === 0) {
    throw new Error("All b-roll placements fall outside the video.");
  }
  const inputs: string[] = ["-i", input];
  placements.forEach((p) => inputs.push("-i", join(brollDir, p.file)));

  // Build a filtergraph: scale+crop each b-roll to the base size, then overlay
  // it with an enable window. Trim/loop each source to its cutaway duration.
  const parts: string[] = [];
  let last = "0:v";
  placements.forEach((p, i) => {
    const src = `${i + 1}:v`;
    const scaled = `b${i}`;
    parts.push(
      `[${src}]trim=duration=${p.duration.toFixed(3)},` +
        `scale=${base.width}:${base.height}:force_original_aspect_ratio=increase,` +
        `crop=${base.width}:${base.height},` +
        // Shift the clip's frame 0 to its overlay window start, otherwise the
        // stream ends before the window opens and the overlay freezes on its
        // last frame for the whole cutaway.
        `setpts=PTS-STARTPTS+${p.start.toFixed(3)}/TB[${scaled}]`,
    );
    const outLabel = i === placements.length - 1 ? "vout" : `ov${i}`;
    const end = (p.start + p.duration).toFixed(3);
    parts.push(
      `[${last}][${scaled}]overlay=enable='between(t,${p.start.toFixed(3)},${end})':` +
        `x=0:y=0[${outLabel}]`,
    );
    last = outLabel;
  });

  const filter = parts.join(";");
  const args = [
    ...inputs,
    "-filter_complex", filter,
    "-map", "[vout]",
    ...(base.hasAudio ? ["-map", "0:a"] : []),
    "-c:a", "copy",
    output,
  ];
  await ffmpeg(args, "apply-broll");
}
