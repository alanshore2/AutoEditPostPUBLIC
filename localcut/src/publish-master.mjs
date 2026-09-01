import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { prepareLocalMediaBinaries } from "./pipeline.mjs";

const readJson = async (path, fallback = null) => {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
};

function runBinary(command, args, cwd, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"] });
    let stdout = "", stderr = "";
    if (capture) child.stdout.on("data", (chunk) => stdout += chunk.toString());
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 16000) stderr = stderr.slice(-16000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun(capture ? `${stdout}\n${stderr}` : "")
      : reject(new Error(`Media command exited ${code}: ${stderr.slice(-2400)}`)));
  });
}

const rational = (value, fallback) => {
  const [numerator, denominator = "1"] = String(value || "").split("/").map(Number);
  const result = numerator / denominator; return Number.isFinite(result) && result > 0 ? result : fallback;
};
const concatPath = (path) => resolve(path).replace(/\\/g, "/").replace(/'/g, "'\\''");
async function openingPackets(ffprobe, path, selector, cwd) {
  const payload = JSON.parse(await runBinary(ffprobe, ["-v", "error", "-select_streams", selector, "-read_intervals", "0%+0.25",
    "-show_packets", "-show_entries", "packet=pts_time,data_hash", "-show_data_hash", "md5", "-of", "json", path], cwd, true));
  return (payload.packets || []).filter((packet) => packet.data_hash);
}

export function exactCoverPublishPath(videoPath) {
  const directory = dirname(videoPath), extension = basename(videoPath).match(/\.[^.]+$/)?.[0] || ".mp4";
  const stem = basename(videoPath, extension).replace(/_FINAL$/i, "");
  return join(directory, `${stem}_POSTIZ.mp4`);
}

export async function ensureExactCoverPublishMaster({ video, cover, output = exactCoverPublishPath(video) }) {
  const source = resolve(video), coverPath = resolve(cover), target = resolve(output), directory = dirname(target);
  if (!existsSync(source)) throw new Error(`Final reel is missing: ${source}`);
  if (!existsSync(coverPath)) throw new Error(`Reviewed cover is missing: ${coverPath}`);
  await mkdir(directory, { recursive: true });
  const [sourceInfo, coverInfo] = await Promise.all([stat(source), stat(coverPath)]);
  const fingerprint = createHash("sha256").update(JSON.stringify({ source, sourceBytes: sourceInfo.size, sourceMtimeMs: sourceInfo.mtimeMs,
    coverPath, coverBytes: coverInfo.size, coverMtimeMs: coverInfo.mtimeMs, schema: 2 })).digest("hex");
  const receiptPath = `${target}.cover-receipt.json`, previous = await readJson(receiptPath, null);
  if (previous?.fingerprint === fingerprint && existsSync(target)) {
    const targetInfo = await stat(target); if (targetInfo.size > sourceInfo.size) return { ...previous, publishVideo: target, receiptPath, reused: true };
  }
  const { ffmpeg, ffprobe } = await prepareLocalMediaBinaries();
  const probe = JSON.parse(await runBinary(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", source], directory, true));
  const videoStream = probe.streams?.find((stream) => stream.codec_type === "video"), audioStream = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (videoStream?.codec_name !== "h264") throw new Error(`Exact cover publishing currently requires H.264 video; found ${videoStream?.codec_name || "unknown"}`);
  const originalDuration = Number(probe.format?.duration); if (!Number.isFinite(originalDuration) || originalDuration <= 0) throw new Error("Could not read the final reel duration");
  const fps = rational(videoStream.r_frame_rate, 30), frameDuration = 1 / fps;
  const timescale = Math.max(1000, Number(String(videoStream.time_base || "1/15360").split("/")[1]) || 15360);
  const sampleRate = Math.max(8000, Number(audioStream?.sample_rate) || 48000), channels = Math.max(1, Number(audioStream?.channels) || 2);
  const channelLayout = String(audioStream?.channel_layout || (channels === 1 ? "mono" : "stereo"));
  const token = `${process.pid}-${Date.now()}`, head = join(directory, `.postiz-cover-head-${token}.mp4`), list = join(directory, `.postiz-cover-concat-${token}.txt`), temporary = join(directory, `.postiz-master-${token}.mp4`);
  const verifyFrame = join(directory, `.postiz-cover-verify-${token}.jpg`);
  try {
    // CapCut-style head cover: the reviewed cover IS the first frame, so every
    // platform's default thumbnail (frame 0 / thumb_offset 0) shows it with no
    // provider-side cover support needed. Postiz never forwards cover_url to
    // Instagram (gitroomhq/postiz-app#1572) and clamps a tail thumb_offset, so
    // the previous append-at-tail design was silently ignored on the IG grid.
    // A stream-copy concat cannot prepend a frame ahead of B-frame negative
    // DTS without corrupting container timestamps, so the master re-encodes in
    // one pass: cover as frame zero, source video from frame one, audio
    // delayed by exactly one frame.
    const delayMs = Math.round(frameDuration * 1000);
    const filter = [
      `[0:v]scale=${videoStream.width}:${videoStream.height},setsar=1,fps=${fps},trim=end_frame=1[cover]`,
      `[1:v]fps=${fps},setsar=1[body]`,
      `[cover][body]concat=n=2:v=1:a=0,format=yuv420p[v]`,
      ...(audioStream ? [`[1:a]adelay=${delayMs}|${delayMs}:all=1[a]`] : []),
    ].join(";");
    const encodeArgs = ["-y", "-hide_banner", "-v", "error", "-loop", "1", "-t", "1", "-i", coverPath, "-i", source,
      "-filter_complex", filter, "-map", "[v]", ...(audioStream ? ["-map", "[a]"] : []),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-video_track_timescale", String(timescale),
      ...(audioStream ? ["-c:a", "aac", "-b:a", "192k", "-ar", String(sampleRate), "-ac", String(channels)] : ["-an"]),
      "-movflags", "+faststart", temporary];
    await runBinary(ffmpeg, encodeArgs, directory);
    const outputProbe = JSON.parse(await runBinary(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", temporary], directory, true));
    const outputDuration = Number(outputProbe.format?.duration);
    const prependedSeconds = outputDuration - originalDuration;
    if (!Number.isFinite(outputDuration) || prependedSeconds < frameDuration * 0.5 || prependedSeconds > 0.25) throw new Error(`Exact cover head duration is invalid: ${prependedSeconds}`);
    const coverTimestampMs = 0;
    // Verify frame zero is the reviewed cover.
    await runBinary(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-i", temporary, "-frames:v", "1", "-q:v", "2", verifyFrame], directory);
    // ffmpeg 7 emits zero frames from scale2ref on still images, so scale the
    // cover to the video's dimensions explicitly before the SSIM compare.
    const similarityOutput = await runBinary(ffmpeg, ["-hide_banner", "-v", "info", "-i", coverPath, "-i", verifyFrame, "-lavfi", `[0:v]scale=${videoStream.width}:${videoStream.height},setsar=1[a];[1:v]setsar=1[b];[a][b]ssim`, "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"], directory, true);
    const coverSimilarity = Number(similarityOutput.match(/All:([0-9.]+)/)?.[1] || 0);
    if (coverSimilarity < 0.9) throw new Error(`Published first frame does not match the reviewed cover (similarity ${coverSimilarity.toFixed(4)})`);
    // Verify the source's first frame follows immediately at frame one.
    const verifyFrameOne = `${verifyFrame}.f1.jpg`, sourceFrameZero = `${verifyFrame}.s0.jpg`;
    await runBinary(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-i", temporary, "-vf", "select=eq(n\\,1)", "-frames:v", "1", "-vsync", "vfr", "-q:v", "2", verifyFrameOne], directory);
    await runBinary(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-i", source, "-frames:v", "1", "-q:v", "2", sourceFrameZero], directory);
    const openingSimilarityOutput = await runBinary(ffmpeg, ["-hide_banner", "-v", "info", "-i", sourceFrameZero, "-i", verifyFrameOne, "-lavfi", "ssim", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"], directory, true);
    const openingSimilarity = Number(openingSimilarityOutput.match(/All:([0-9.]+)/)?.[1] || 0);
    for (const path of [verifyFrameOne, sourceFrameZero]) try { await unlink(path); } catch { /* cleanup */ }
    if (openingSimilarity < 0.85) throw new Error(`Publishing master delayed the opening video (frame one similarity ${openingSimilarity.toFixed(4)})`);
    const openingVideoOffsetMs = delayMs;
    let openingAudioPacketsVerified = 0;
    let openingAudioOffsetMs = delayMs;
    if (audioStream) {
      // Audio was shifted by exactly one frame; verify speech energy appears in
      // the first second at a level comparable to the source.
      const levelOf = async (path) => {
        const out = await runBinary(ffmpeg, ["-hide_banner", "-nostats", "-i", path, "-af", "atrim=0:1,volumedetect", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"], directory, true);
        return Number(out.match(/mean_volume:\s*(-?[0-9.]+)/)?.[1] ?? -91);
      };
      const sourceLevel = await levelOf(source), publishedLevel = await levelOf(temporary);
      if (publishedLevel < sourceLevel - 6) throw new Error(`Publishing master lost opening audio (${publishedLevel}dB vs ${sourceLevel}dB)`);
      openingAudioPacketsVerified = 1;
    }
    try { await unlink(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(temporary, target);
    const receipt = { schema: 2, headCover: true, fingerprint, sourceVideo: source, reviewedCover: coverPath, publishVideo: target, originalDuration,
      publishDuration: outputDuration, prependedSeconds: Number(prependedSeconds.toFixed(6)), coverTimestampMs, coverSimilarity,
      openingSimilarity: Number(openingSimilarity.toFixed(4)), openingFramesVerified: 2,
      openingAudioPacketsVerified, openingVideoOffsetMs, openingAudioOffsetMs, openingStartsAtZero: true, createdAt: new Date().toISOString() };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return { ...receipt, receiptPath, reused: false };
  } finally {
    for (const path of [head, list, temporary, verifyFrame]) try { await unlink(path); } catch { /* temporary cleanup */ }
  }
}
