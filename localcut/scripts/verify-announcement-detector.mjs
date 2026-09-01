import { spawn } from "node:child_process";
import { findOpeningAnnouncement, windowsAnnouncementRecognitionArgs } from "../src/podcast.mjs";

const scanPath = process.argv[2];
if (!scanPath) throw new Error("Pass the opening WAV scan path");
const expectClear = process.argv.includes("--expect-clear");

const child = spawn("powershell.exe", windowsAnnouncementRecognitionArgs(scanPath), {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "", stderr = "";
child.stdout.on("data", (chunk) => stdout += chunk);
child.stderr.on("data", (chunk) => stderr += chunk);
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", resolve);
});
if (code !== 0) throw new Error(stderr || `Recognizer exited ${code}`);
const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
const rows = Array.isArray(parsed) ? parsed : [parsed];
const match = findOpeningAnnouncement(rows);
console.log(JSON.stringify({ recognized: rows, match }, null, 2));
if ((expectClear && match) || (!expectClear && !match)) process.exitCode = 2;
