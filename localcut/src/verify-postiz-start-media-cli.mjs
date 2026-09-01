import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { prepareLocalMediaBinaries } from "./pipeline.mjs";

const statePath = resolve(process.env.LOCALCUT_POSTIZ_START_STATE || `${homedir()}/.localcut/postiz-start-repair-state.json`);
const state = JSON.parse(await readFile(statePath, "utf8"));
const videos = [...new Set(Object.values(state.replacements || {}).map((entry) => entry.publishMaster).filter((path) => /\.mp4$/i.test(path || "")))];
const { ffmpeg } = await prepareLocalMediaBinaries();

function inspect(video) {
  return new Promise((resolveInspect, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-nostats", "-i", video, "-t", "1", "-af", "silencedetect=noise=-30dB:d=0.04", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"],
      { cwd: dirname(video), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Opening check failed for ${video}`));
      const startsAtZero = /silence_start:\s*-?0(?:\.0+)?(?:\s|$)/.test(stderr);
      const end = Number(stderr.match(/silence_end:\s*([0-9.]+)/)?.[1]);
      const initialSilence = startsAtZero && Number.isFinite(end) ? end : 0;
      resolveInspect({ video, initialSilence: Number(initialSilence.toFixed(6)) });
    });
  });
}

const results = [];
for (const video of videos) results.push(await inspect(video));
const delayed = results.filter((entry) => entry.initialSilence > 0.1);
const maximum = Math.max(0, ...results.map((entry) => entry.initialSilence));
const average = results.length ? results.reduce((sum, entry) => sum + entry.initialSilence, 0) / results.length : 0;
process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), filesChecked: results.length, thresholdSeconds: 0.1,
  delayedFiles: delayed.length, maximumInitialSilenceSeconds: Number(maximum.toFixed(6)), averageInitialSilenceSeconds: Number(average.toFixed(6)),
  pass: delayed.length === 0, delayed }, null, 2)}\n`);
if (delayed.length) process.exitCode = 2;
