import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const installedExe = resolve(process.argv[2] || join(process.env.LOCALAPPDATA || "", "Programs", "LocalCut", "LocalCut.exe"));
const autoEditRoot = resolve(process.argv[3] || "C:\\AutoEditPost");
const proofDir = resolve(process.argv[4] || join(autoEditRoot, "out", "proof", "installed-postiz-calendar"));
const calendarPath = join(proofDir, "live-postiz-calendar.json");
await mkdir(proofDir, { recursive: true }); await rm(calendarPath, { force: true });

const child = spawn(installedExe, ["--postiz-calendar"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: {
  ...process.env, AUTOEDITPOST_ROOT: autoEditRoot, LOCALCUT_POSTIZ_CALENDAR_OUTPUT: calendarPath,
} });
let childExit = null, stderr = ""; child.stderr.on("data", (chunk) => stderr += chunk); child.on("exit", (code) => childExit = code);
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  try { await access(calendarPath); break; } catch { await new Promise((done) => setTimeout(done, 500)); }
  if (childExit !== null) throw new Error(`Installed LocalCut calendar pull exited ${childExit}: ${stderr.slice(-800)}`);
}
if (Date.now() >= deadline) { child.kill(); throw new Error("Installed LocalCut did not write the live Postiz calendar receipt within 90 seconds"); }
const calendar = JSON.parse(await readFile(calendarPath, "utf8"));
if (calendar.ok === false) throw new Error(`Installed LocalCut calendar pull failed: ${calendar.error}`);
assert.ok(Array.isArray(calendar.posts)); assert.equal(calendar.summary.total, calendar.posts.length);
assert.ok(calendar.range?.start && calendar.range?.end); assert.ok(calendar.checkedAt);
assert.ok(calendar.posts.every((item) => item.id && item.publishDate && item.platform && item.status && item.kind));
const proof = { ok: true, checkedAt: new Date().toISOString(), readOnly: true, livePostsCreated: 0,
  range: calendar.range, summary: calendar.summary,
  posts: calendar.posts.map(({ id, title, publishDate, status, platform, platformLabel, channel, kind, itemId, batchName, tracked }) => ({ id, title, publishDate, status, platform, platformLabel, channel, kind, itemId, batchName, tracked })),
  calendarPath };
await writeFile(join(proofDir, "acceptance.json"), `${JSON.stringify(proof, null, 2)}\n`);
child.kill(); process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
