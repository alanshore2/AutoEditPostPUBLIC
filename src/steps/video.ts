import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, probe } from "../lib/ffmpeg.js";

/** Mirror the video horizontally (the classic "flip"). */
export async function flip(
  input: string,
  output: string,
  direction: "h" | "v" = "h",
): Promise<void> {
  const filter = direction === "v" ? "vflip" : "hflip";
  await ffmpeg(["-i", input, "-vf", filter, "-c:a", "copy", output], `flip-${direction}`);
}

/**
 * Reframe to a target aspect ratio (e.g. "9:16") by cropping to fill.
 * Center crop keeps the subject roughly centered — good for talking heads.
 */
export async function reframe(
  input: string,
  output: string,
  aspect = "9:16",
): Promise<void> {
  const [aw, ah] = aspect.split(":").map(Number);
  if (!aw || !ah) throw new Error(`Invalid aspect ratio: ${aspect}`);
  const target = aw / ah;

  const meta = await probe(input);
  const srcAspect = meta.width / meta.height;

  // Crop the larger dimension down to the target aspect, then let output size follow.
  let cropW: number;
  let cropH: number;
  if (srcAspect > target) {
    // too wide -> crop width
    cropH = meta.height;
    cropW = Math.round(meta.height * target);
  } else {
    // too tall -> crop height
    cropW = meta.width;
    cropH = Math.round(meta.width / target);
  }
  // Keep even dimensions for h264.
  cropW -= cropW % 2;
  cropH -= cropH % 2;

  await ffmpeg(
    [
      "-i", input,
      "-vf", `crop=${cropW}:${cropH}:(iw-${cropW})/2:(ih-${cropH})/2`,
      "-c:a", "copy",
      output,
    ],
    "reframe",
  );
}

/**
 * Zoom-crop so the subject's head sits near the top of the frame (removes
 * dead headroom). Samples 3 frames, asks a vision model for the top-of-head
 * position, then crops from just above the highest detected head down to the
 * bottom edge (aspect preserved) and scales back up. Requires OPENAI_API_KEY.
 */
export async function headCrop(
  input: string,
  output: string,
  margin = 0.08, // head top lands at this fraction of frame height
): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required for --crop-head");
  const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";

  const meta = await probe(input);
  const dir = await mkdtemp(join(tmpdir(), "aep-headcrop-"));
  try {
    // Dense sampling: the subject sways, and the head must stay in frame at
    // its HIGHEST point, which 3 samples routinely miss.
    const SAMPLES = 9;
    const times = Array.from(
      { length: SAMPLES },
      (_, i) => ((i + 0.5) / SAMPLES) * meta.durationSec,
    );
    const images: string[] = [];
    for (let i = 0; i < times.length; i++) {
      const frame = join(dir, `f${i}.jpg`);
      await ffmpeg(
        ["-ss", times[i].toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale=384:-2", frame],
        "headcrop-sample",
      );
      images.push((await readFile(frame)).toString("base64"));
    }

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
              {
                type: "text",
                text:
                  "These are frames from one vertical talking-head video. For each image, report the person's head as fractions of the image (0 = top/left edge, 1 = bottom/right edge): \"top\" = very top of the head including hair, \"left\" = leftmost visible extent of the head, \"right\" = rightmost visible extent of the head. Reply with ONLY a JSON array, one {\"top\":n,\"left\":n,\"right\":n} object per image in order, null for any image with no person.",
              },
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
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) throw new Error(`No JSON array in vision output: ${text.slice(0, 200)}`);
    interface HeadBox { top: number; left: number; right: number }
    const boxes = (JSON.parse(match[0]) as (HeadBox | null)[]).filter(
      (b): b is HeadBox =>
        !!b &&
        typeof b.top === "number" && b.top > 0 && b.top < 1 &&
        typeof b.left === "number" && typeof b.right === "number" &&
        b.right > b.left,
    );
    if (boxes.length === 0) {
      console.log("  headcrop: no head detected; leaving frame as-is");
      await ffmpeg(["-i", input, "-c", "copy", output], "headcrop-copy");
      return;
    }

    // Anchor on the extremes across ALL samples: the highest head position,
    // and the widest left/right face extent — the face must never leave frame.
    const headTop = Math.min(...boxes.map((b) => b.top)) * meta.height;
    const faceL = Math.min(...boxes.map((b) => b.left));
    const faceR = Math.max(...boxes.map((b) => b.right));

    let cropTop = Math.max(0, Math.round((headTop - margin * meta.height) / (1 - margin)));
    // The full face span plus side margin must fit inside the crop width; if
    // the zoom is too tight for it, back the zoom off (reduce cropTop).
    const hMargin = 0.05;
    const spanW = Math.min(1, faceR - faceL + 2 * hMargin) * meta.width;
    const minCropH = Math.ceil(spanW * (meta.height / meta.width));
    cropTop = Math.min(cropTop, Math.max(0, meta.height - minCropH));
    cropTop -= cropTop % 2;
    let cropH = meta.height - cropTop;
    cropH -= cropH % 2;
    let cropW = Math.round(cropH * (meta.width / meta.height));
    cropW -= cropW % 2;
    // Center the crop on the face, clamped to the frame edges.
    const faceCx = ((faceL + faceR) / 2) * meta.width;
    let x = Math.round(faceCx - cropW / 2);
    x = Math.max(0, Math.min(meta.width - cropW, x));
    x -= x % 2;

    console.log(
      `  headcrop: head top ${((headTop / meta.height) * 100).toFixed(0)}%, face ${(faceL * 100).toFixed(0)}-${(faceR * 100).toFixed(0)}% wide -> crop ${cropTop}px off top, x offset ${x}px`,
    );
    await ffmpeg(
      [
        "-i", input,
        "-vf", `crop=${cropW}:${cropH}:${x}:${cropTop},scale=${meta.width}:${meta.height},setsar=1`,
        "-c:a", "copy",
        output,
      ],
      "headcrop",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Color grade presets (ported from browser-use/video-use grade.py). */
export const GRADE_PRESETS: Record<string, string> = {
  subtle: "eq=contrast=1.03:saturation=0.98",
  neutral_punch:
    "eq=contrast=1.06:brightness=0.0:saturation=1.0," +
    "curves=master='0/0 0.25/0.23 0.75/0.77 1/1'",
  warm_cinematic:
    "eq=contrast=1.12:brightness=-0.02:saturation=0.88," +
    "colorbalance=rs=0.02:gs=0.0:bs=-0.03:rm=0.04:gm=0.01:bm=-0.02:rh=0.08:gh=0.02:bh=-0.05," +
    "curves=master='0/0 0.25/0.22 0.75/0.78 1/1'",
};

/** Apply a named color grade (video re-encode, audio untouched). */
export async function gradeVideo(input: string, output: string, preset: string): Promise<void> {
  const chain = GRADE_PRESETS[preset];
  if (!chain) throw new Error(`Unknown grade preset "${preset}". Available: ${Object.keys(GRADE_PRESETS).join(", ")}`);
  await ffmpeg(["-i", input, "-vf", chain, "-c:a", "copy", output], `grade-${preset}`);
}

export interface ChinSample {
  /** Seconds into the clip. */
  t: number;
  /** Bottom of the chin as a fraction of frame height from the top. */
  chin: number;
}

/**
 * Decide where captions belong by CLIP TYPE, using ONLY signal statistics — no
 * vision model (geometry/content vision is intentionally avoided per project
 * rules). A filmed-monitor / screen-recording / "show-n-tell" clip is a bright,
 * low-saturation document, so captions go TOP to stay off what the subject
 * points at; a talking-head is mid-saturation (skin tones), so captions go
 * bottom (lower third). Validated on real reels: talking-head avg SATAVG ~11-13,
 * white-DM screen ~5 — a wide, non-overlapping margin at a threshold of 8.
 *
 * ponytail: per-CLIP average. Handles the common case (a reel is a talking-head
 * OR a screen walkthrough) and separate concatenated clips. If you ever film ONE
 * clip that flips face<->screen mid-way, upgrade to a per-window pass.
 */
export async function detectCaptionZone(input: string): Promise<"top" | "bottom"> {
  const dir = await mkdtemp(join(tmpdir(), "aep-capzone-"));
  const statsFile = join(dir, "sig.txt");
  try {
    // fps=1 -> one sample per second, averaged over the clip.
    await ffmpeg(
      ["-i", input, "-vf", `fps=1,signalstats,metadata=print:file=${statsFile}`, "-an", "-f", "null", "-"],
      "caption-zone-signalstats",
    );
    const txt = await readFile(statsFile, "utf8");
    const sats = [...txt.matchAll(/SATAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    if (sats.length === 0) return "bottom"; // no signal -> safe default (talking-head)
    const avgSat = sats.reduce((a, b) => a + b, 0) / sats.length;
    return avgSat < 8 ? "top" : "bottom";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Track the subject's chin position over time so captions can stay below it
 * while the subject sways. Samples a frame every ~intervalSec, asks a vision
 * model for the chin-bottom position in each. Requires OPENAI_API_KEY.
 */
export async function detectChinTrack(
  input: string,
  intervalSec = 0.8,
): Promise<ChinSample[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required for chin tracking");
  const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";

  const meta = await probe(input);
  const n = Math.min(32, Math.max(4, Math.ceil(meta.durationSec / intervalSec)));
  const times = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * meta.durationSec);

  const dir = await mkdtemp(join(tmpdir(), "aep-chintrack-"));
  try {
    const images: string[] = [];
    for (let i = 0; i < times.length; i++) {
      const frame = join(dir, `f${i}.jpg`);
      await ffmpeg(
        ["-ss", times[i].toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale=384:-2", frame],
        "chintrack-sample",
      );
      images.push((await readFile(frame)).toString("base64"));
    }

    const samples: ChinSample[] = [];
    const BATCH = 8; // keep per-request image count low for reliable indexing
    for (let off = 0; off < images.length; off += BATCH) {
      const batch = images.slice(off, off + BATCH);
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
                {
                  type: "text",
                  text: `These are ${batch.length} frames from one vertical talking-head video, in order. For each image, give the vertical position of the BOTTOM of the person's chin as a fraction of image height from the top (0 = top edge, 1 = bottom edge). Reply with ONLY a JSON array of ${batch.length} numbers, null for any image with no visible face.`,
                },
                ...batch.map((b64) => ({
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
      const match = text.match(/\[[^\]]*\]/);
      if (!match) throw new Error(`No JSON array in vision output: ${text.slice(0, 200)}`);
      const vals = JSON.parse(match[0]) as (number | null)[];
      for (let j = 0; j < Math.min(vals.length, batch.length); j++) {
        const v = vals[j];
        if (typeof v === "number" && v > 0 && v < 1) samples.push({ t: times[off + j], chin: v });
      }
    }
    return samples;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Clean up spoken audio: RNNoise voice denoise (arnndn, models/std.rnnn —
 * purpose-built for speech, handles wind/traffic) + loudness normalize to
 * broadcast-ish -16 LUFS, which reads well on phone speakers. Falls back to
 * FFT denoise when the model file is missing. Override model path with
 * AUDIO_RNNN_MODEL.
 */
export async function enhanceAudio(input: string, output: string): Promise<void> {
  const modelPath =
    process.env.AUDIO_RNNN_MODEL ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "models", "std.rnnn");
  const denoise = existsSync(modelPath)
    ? `arnndn=m='${modelPath.replace(/:/g, "\\:")}'`
    : "afftdn=nf=-25";
  if (!existsSync(modelPath))
    console.log("  enhance-audio: models/std.rnnn missing, using FFT denoise fallback");
  await ffmpeg(
    [
      "-i", input,
      "-af", `${denoise},loudnorm=I=-16:TP=-1.5:LRA=11`,
      "-c:v", "copy",
      output,
    ],
    "enhance-audio",
  );
}
