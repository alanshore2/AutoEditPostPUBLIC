import { spawn } from "node:child_process";

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

function run(
  bin: string,
  args: string[],
  opts: { capture?: boolean; label?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: opts.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let out = "";
    let err = "";
    if (opts.capture) {
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
    }
    child.on("error", (e) =>
      reject(new Error(`${bin} failed to start (is it installed and on PATH?): ${e.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${opts.label ?? bin} exited with code ${code}\n${err.slice(-2000)}`));
    });
  });
}

/** Run an ffmpeg command. Pass the full arg list (without the leading "ffmpeg"). */
export function ffmpeg(args: string[], label = "ffmpeg"): Promise<string> {
  // -y overwrites output, -hide_banner keeps logs readable
  return run("ffmpeg", ["-hide_banner", "-y", ...args], { label });
}

/** Inspect a media file's key properties via ffprobe. */
export async function probe(input: string): Promise<ProbeResult> {
  const raw = await run(
    "ffprobe",
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      input,
    ],
    { capture: true, label: "ffprobe" },
  );
  const data = JSON.parse(raw);
  const video = (data.streams ?? []).find((s: any) => s.codec_type === "video");
  const audio = (data.streams ?? []).find((s: any) => s.codec_type === "audio");
  if (!video) throw new Error(`No video stream found in ${input}`);

  const [num, den] = String(video.avg_frame_rate ?? video.r_frame_rate ?? "30/1")
    .split("/")
    .map(Number);
  const fps = den ? num / den : Number(num) || 30;

  return {
    durationSec: Number(data.format?.duration ?? video.duration ?? 0),
    width: Number(video.width),
    height: Number(video.height),
    fps: Math.round(fps * 1000) / 1000,
    hasAudio: Boolean(audio),
  };
}
