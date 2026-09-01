import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, probe } from "../lib/ffmpeg.js";
import type { ChinSample } from "./video.js";

/** One face observation: fractions of the frame (0=top/left, 1=bottom/right). */
export interface FaceSample {
  t: number;
  top: number;
  chin: number;
  left: number;
  right: number;
}

const VISION_BATCH = 8;

async function visionCall(
  images: string[],
  prompt: string,
): Promise<(Record<string, number | boolean> | null)[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required for face tracking");
  const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...images.map((b64) => ({
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${b64}` },
            })),
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Vision API failed (${res.status}): ${await res.text()}`);
  const data: any = await res.json();
  const text: string = data.choices?.[0]?.message?.content ?? "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON array in vision output: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

/** Extract sampled frames as base64 thumbnails. */
async function sampleFrames(input: string, times: number[], dir: string): Promise<string[]> {
  const images: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const frame = join(dir, `f${i}.jpg`);
    await ffmpeg(
      ["-ss", times[i].toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale=384:-2", frame],
      "track-sample",
    );
    images.push((await readFile(frame)).toString("base64"));
  }
  return images;
}

/**
 * Sample the video and return a face box track. Uses OpenCV (Haar cascade)
 * via scripts/face_track.py — a real detector; LLM vision proved unable to
 * return usable geometry (it emits rounded guesses like cx=0.50 everywhere).
 */
export async function detectFaceTrack(input: string, intervalSec = 0.25): Promise<FaceSample[]> {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "face_track.py");
  const json = await new Promise<string>((resolve, reject) => {
    const child = spawn("python3", [script, input, String(intervalSec)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(new Error(`face_track.py failed to start: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`face_track.py exited ${code}\n${err.slice(-1000)}`)),
    );
  });
  const track = JSON.parse(json) as FaceSample[];
  return track.filter(
    (s) => s.chin > s.top && s.right > s.left && s.top >= 0 && s.chin <= 1,
  );
}

/** Moving-average smooth (window 5) so the virtual camera drifts, not jitters. */
function smooth(track: FaceSample[]): FaceSample[] {
  return track.map((s, i) => {
    const win = track.slice(Math.max(0, i - 2), i + 3);
    const avg = (f: (x: FaceSample) => number) => win.reduce((a, x) => a + f(x), 0) / win.length;
    return { t: s.t, top: avg((x) => x.top), chin: avg((x) => x.chin), left: avg((x) => x.left), right: avg((x) => x.right) };
  });
}

/** Piecewise-linear ffmpeg expression in t through the given points. */
function piecewise(times: number[], vals: number[]): string {
  if (times.length === 1) return String(vals[0]);
  const parts: string[] = [`(lt(t,${times[0].toFixed(3)})*${vals[0].toFixed(1)})`];
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i], b = times[i + 1];
    const slope = (vals[i + 1] - vals[i]) / (b - a);
    parts.push(
      `(gte(t,${a.toFixed(3)})*lt(t,${b.toFixed(3)})*(${vals[i].toFixed(1)}+${slope.toFixed(4)}*(t-${a.toFixed(3)})))`,
    );
  }
  parts.push(`(gte(t,${times[times.length - 1].toFixed(3)})*${vals[vals.length - 1].toFixed(1)})`);
  return parts.join("+");
}

export interface TrackCropResult {
  /** Chin positions mapped into the OUTPUT frame, for caption placement. */
  chinTrack: ChinSample[];
}

/**
 * Dynamic tracking crop: a fixed-zoom window pans to follow the face, keeping
 * the head near the top of frame the whole video and reserving a caption zone
 * below the chin. Zoom is the tightest that fits the face (with margins) at
 * EVERY sampled moment.
 */
export async function trackCrop(
  input: string,
  output: string,
  rawTrack: FaceSample[],
  topMargin = 0.05,
  captionZone = 0.22,
  sideMargin = 0.04,
  zoomOut = 1.0, // 1.0 = tightest face-fit; 1.25 = 25% wider window (more background)
): Promise<TrackCropResult> {
  if (rawTrack.length === 0) throw new Error("trackCrop: empty face track");
  const meta = await probe(input);
  const W = meta.width, H = meta.height;
  const track = smooth(rawTrack);

  // Fixed zoom: crop height must hold the face band (top margin + face +
  // caption zone) at the biggest face, and crop width must hold the widest
  // face span. Take the loosest requirement so everything always fits.
  let cropH = 0;
  for (const s of track) {
    const needFace = ((s.chin - s.top) * H) / (1 - topMargin - captionZone);
    const needSpan = ((s.right - s.left + 2 * sideMargin) * W * H) / W;
    cropH = Math.max(cropH, needFace, needSpan);
  }
  cropH = Math.min(H, Math.ceil(cropH * zoomOut));
  cropH -= cropH % 2;
  let cropW = Math.round(cropH * (W / H));
  cropW -= cropW % 2;

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const times = track.map((s) => s.t);
  const xs = track.map((s) => clamp(((s.left + s.right) / 2) * W - cropW / 2, 0, W - cropW));
  const ys = track.map((s) => clamp(s.top * H - topMargin * cropH, 0, H - cropH));

  for (let i = 0; i < track.length; i += 10) {
    console.log(
      `  trackcrop sample t=${track[i].t.toFixed(1)}s top=${track[i].top.toFixed(2)} chin=${track[i].chin.toFixed(2)} cx=${((track[i].left + track[i].right) / 2).toFixed(2)} -> x=${xs[i].toFixed(0)} y=${ys[i].toFixed(0)}`,
    );
  }
  const xExpr = piecewise(times, xs);
  const yExpr = piecewise(times, ys);
  await ffmpeg(
    [
      "-i", input,
      "-vf", `crop=w=${cropW}:h=${cropH}:x='${xExpr}':y='${yExpr}',scale=${W}:${H},setsar=1`,
      "-c:a", "copy",
      output,
    ],
    "track-crop",
  );
  console.log(
    `  trackcrop: zoom ${(H / cropH).toFixed(2)}x (window ${cropW}x${cropH}), following ${track.length} samples`,
  );

  // Chin positions in output coords: what the caption layer must stay below.
  const chinTrack: ChinSample[] = track.map((s, i) => ({
    t: s.t,
    chin: clamp((s.chin * H - ys[i]) / cropH, 0, 1),
  }));
  return { chinTrack };
}

export interface FramingIssue {
  t: number;
  problem: string;
}

/**
 * QA pass: sample the FINAL video and have the vision model check the goal —
 * top of head visible, whole face visible, captions clear of the chin/face.
 */
export async function verifyFraming(video: string, samples = 6): Promise<FramingIssue[]> {
  const meta = await probe(video);
  const times = Array.from({ length: samples }, (_, i) => ((i + 0.5) / samples) * meta.durationSec);
  const dir = await mkdtemp(join(tmpdir(), "aep-qa-"));
  try {
    const images = await sampleFrames(video, times, dir);
    const issues: FramingIssue[] = [];
    for (let off = 0; off < images.length; off += VISION_BATCH) {
      const batch = images.slice(off, off + VISION_BATCH);
      const vals = await visionCall(
        batch,
        `These are ${batch.length} frames from one vertical talking-head video with burned-in captions. For each image answer strictly: "headOk" = is the very top of the person's head fully inside the frame (not touching or cut by the top edge)? "faceOk" = is the entire face visible (nothing cut off at any edge)? "captionClear" = true if there is no caption text overlapping any part of the face or chin (also true if no caption is visible). Reply with ONLY a JSON array of ${batch.length} entries {"headOk":bool,"faceOk":bool,"captionClear":bool}.`,
      );
      for (let j = 0; j < Math.min(vals.length, batch.length); j++) {
        const v = vals[j] as any;
        const t = times[off + j];
        if (!v) continue;
        if (v.headOk === false) issues.push({ t, problem: "top of head cut off" });
        if (v.faceOk === false) issues.push({ t, problem: "face partly out of frame" });
        if (v.captionClear === false) issues.push({ t, problem: "caption overlaps face/chin" });
      }
    }
    return issues;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
