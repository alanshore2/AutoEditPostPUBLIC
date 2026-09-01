import { readFile } from "node:fs/promises";

const key = String(process.env.POSTIZ_KEY || "").trim();
const apiUrl = String(process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1").replace(/\/$/, "");
const queuePath = String(process.env.LOCALCUT_POSTIZ_QUEUE || "").trim();
const requestedIds = String(process.env.LOCALCUT_POSTIZ_ERROR_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
const commit = process.env.LOCALCUT_POSTIZ_ERROR_CLEANUP_COMMIT === "1";

if (!key || !queuePath || !requestedIds.length) throw new Error("Postiz key, queue snapshot, and error IDs are required");
if (commit && process.env.LOCALCUT_POSTIZ_ERROR_CLEANUP_CONFIRMATION !== "REMOVE STALE ERROR CARDS") {
  throw new Error('Live cleanup requires "REMOVE STALE ERROR CARDS"');
}

const snapshot = JSON.parse(await readFile(queuePath, "utf8"));
const posts = Array.isArray(snapshot) ? snapshot : snapshot.posts || [];
const byId = new Map(posts.map((post) => [post.id, post]));
const candidates = requestedIds.map((id) => byId.get(id)).filter(Boolean);
const invalid = candidates.filter((post) => post.state !== "ERROR" || post.integration?.providerIdentifier !== "youtube");
if (candidates.length !== requestedIds.length) throw new Error("Every requested cleanup ID must exist in the live queue snapshot");
if (invalid.length) throw new Error("Cleanup is limited to YouTube records already in ERROR state");

if (!commit) {
  process.stdout.write(`${JSON.stringify({ dryRun: true, candidates: candidates.map(({ id, state, publishDate }) => ({ id, state, publishDate })) }, null, 2)}\n`);
  process.exit(0);
}

const removed = [];
for (const post of candidates) {
  const response = await fetch(`${apiUrl}/posts/${post.id}`, { method: "DELETE", headers: { Authorization: key } });
  if (!response.ok && response.status !== 404) throw new Error(`Could not remove stale Postiz error ${post.id} (${response.status})`);
  removed.push(post.id);
}
process.stdout.write(`${JSON.stringify({ dryRun: false, removed }, null, 2)}\n`);
