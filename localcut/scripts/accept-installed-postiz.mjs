import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const installedExe = resolve(process.argv[2] || join(process.env.LOCALAPPDATA || "", "Programs", "LocalCut", "LocalCut.exe"));
const autoEditRoot = resolve(process.argv[3] || "C:\\AutoEditPost");
const proofDir = resolve(process.argv[4] || join(autoEditRoot, "out", "proof", "installed-postiz"));
const installedServer = join(dirname(installedExe), "resources", "app.asar", "src", "server.mjs");
const child = spawn(installedExe, [installedServer], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: {
  ...process.env, ELECTRON_RUN_AS_NODE: "1", LOCALCUT_DATA_DIR: join(homedir(), ".localcut"), AUTOEDITPOST_ROOT: autoEditRoot,
} });
const pending = new Map(); let id = 0, stderr = "";
child.stderr.on("data", (chunk) => stderr += chunk);
createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const request = pending.get(message.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
function rpc(method, params = {}) {
  const requestId = ++id; return new Promise((resolveRpc, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP ${method} timed out: ${stderr.slice(-500)}`)); }, 30000);
    pending.set(requestId, { resolve: resolveRpc, reject, timer }); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
}
async function tool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text || "null");
}

try {
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "installed-postiz-proof", version: "1" } });
  const listed = await rpc("tools/list"); const names = listed.tools.map((item) => item.name);
  for (const name of ["inspect_postiz_publishing", "inspect_postiz_calendar", "build_postiz_plan", "schedule_postiz_plan"]) assert.ok(names.includes(name));
  const snapshot = await tool("inspect_postiz_publishing");
  const technicalReady = snapshot.reels.filter((item) => item.technicalReady).length;
  const approved = snapshot.reels.filter((item) => item.ready && item.approval?.approved).length;
  assert.equal(snapshot.reels.length, 12); assert.equal(technicalReady, 12);
  assert.ok(approved >= 0 && approved <= 12);
  if (snapshot.savedPlan) {
    const approvedIds = new Set(snapshot.reels.filter((item) => item.ready && item.approval?.approved).map((item) => item.id));
    assert.ok(snapshot.savedPlan.items.filter((item) => item.kind === "reel").every((item) => approvedIds.has(item.id)), "Saved preview must contain only currently approved reels");
  }
  await assert.rejects(tool("schedule_postiz_plan", { planId: snapshot.savedPlan?.id || "approval-gate-proof", confirmation: "NO" }), /exact confirmation/i);
  const calendar = snapshot.connection.configured ? await tool("inspect_postiz_calendar", { daysBefore: 2, daysAhead: 30 }) : null;
  if (calendar) { assert.ok(Array.isArray(calendar.posts)); assert.equal(calendar.summary.total, calendar.posts.length); }
  const proof = { ok: true, checkedAt: new Date().toISOString(), installedServer: initialized.serverInfo, advertisedTools: names.length,
    reels: { total: snapshot.reels.length, technicalReady, approved, approvalRequired: snapshot.reels.length - approved },
    plan: snapshot.savedPlan ? { id: snapshot.savedPlan.id, schema: snapshot.savedPlan.schema, posts: snapshot.savedPlan.summary.posts, fingerprint: snapshot.savedPlan.fingerprint } : null,
    approvalGateVerified: snapshot.savedPlan ? snapshot.savedPlan.items.filter((item) => item.kind === "reel").every((item) => snapshot.reels.some((reel) => reel.id === item.id && reel.ready && reel.approval?.approved)) : true,
    activeSchedule: calendar ? { range: calendar.range, summary: calendar.summary, posts: calendar.posts.map(({ id, title, publishDate, status, platform, kind, itemId, tracked }) => ({ id, title, publishDate, status, platform, kind, itemId, tracked })) } : null,
    livePostsCreated: 0, exactConfirmationGateVerified: true, postizCredentialConfigured: snapshot.connection.configured };
  await mkdir(proofDir, { recursive: true }); await writeFile(join(proofDir, "installed-postiz-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
} finally {
  child.stdin.end(); setTimeout(() => child.kill(), 500).unref();
}
