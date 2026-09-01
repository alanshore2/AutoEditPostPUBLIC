import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const key = String(process.env.POSTIZ_KEY || "").trim();
const apiUrl = String(process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1").replace(/\/$/, "");
const failedId = String(process.env.LOCALCUT_POSTIZ_ERROR_ID || "").trim();
const queuePath = String(process.env.LOCALCUT_POSTIZ_QUEUE || "").trim();
const repairStatePath = join(homedir(), ".localcut", "postiz-start-repair-state.json");
const retryStatePath = join(homedir(), ".localcut", "postiz-error-retry-state.json");
if (!key || !failedId || !queuePath) throw new Error("Postiz key, failed post ID, and queue snapshot are required");

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
};
const payload = async (response) => { const text = await response.text(); try { return text ? JSON.parse(text) : null; } catch { return { error: text.slice(0, 500) }; } };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (process.env.LOCALCUT_POSTIZ_MISSING_ONLY === "1") {
  const response = await fetch(`${apiUrl}/posts/${failedId}/missing`, { headers: { Authorization: key } });
  const result = await payload(response);
  if (!response.ok) throw new Error(`Missing-content lookup failed (${response.status}): ${JSON.stringify(result).slice(0, 400)}`);
  process.stdout.write(`${JSON.stringify({ postId: failedId, recentContent: result }, null, 2)}\n`);
  process.exit(0);
}

const queue = await readJson(queuePath), live = Array.isArray(queue) ? queue : queue.posts || [];
const failed = live.find((post) => post.id === failedId);
if (!failed || failed.state !== "ERROR") throw new Error(`Expected an ERROR post for ${failedId}`);
const repairState = await readJson(repairStatePath);
const replacement = Object.values(repairState.replacements || {}).find((entry) => entry.newPostId === failedId);
if (!replacement) throw new Error(`Repair receipt is missing for ${failedId}`);
const video = repairState.uploads?.[replacement.publishMaster];
if (!video?.id || !video?.path) throw new Error("Corrected video upload receipt is missing");
let settings = failed.settings || {};
if (typeof settings === "string") settings = JSON.parse(settings);
const cover = settings.thumbnail;
if (!cover?.id || !cover?.path) throw new Error("Reviewed YouTube thumbnail receipt is missing");
const coverReceipt = await readJson(`${replacement.publishMaster}.cover-receipt.json`);
const media = [{ ...video, thumbnail: cover.path, thumbnailTimestamp: coverReceipt.coverTimestampMs }];
const body = { type: "now", date: new Date().toISOString(), shortLink: false, tags: [], posts: [{ integration: { id: failed.integration.id },
  settings: { ...settings, __type: "youtube", thumbnail: cover, tags: Array.isArray(settings.tags) ? settings.tags : [] },
  value: [{ content: failed.content, image: media }] }] };

const createResponse = await fetch(`${apiUrl}/posts`, { method: "POST", headers: { Authorization: key, "content-type": "application/json" }, body: JSON.stringify(body) });
const createdPayload = await payload(createResponse);
const newPostId = Array.isArray(createdPayload) ? createdPayload[0]?.postId : createdPayload?.postId;
if (!createResponse.ok || !newPostId) throw new Error(`Immediate retry failed (${createResponse.status}): ${JSON.stringify(createdPayload).slice(0, 400)}`);
const state = { schema: 1, failedPostId: failedId, newPostId, createdAt: new Date().toISOString(), state: "CREATED", publishMaster: replacement.publishMaster,
  exactReviewedCover: cover.path, openingStartsAtZero: true };
await writeJson(retryStatePath, state);
process.stderr.write(`${JSON.stringify({ retryCreated: newPostId, failedPostId: failedId })}\n`);

for (let attempt = 0; attempt < 60; attempt++) {
  await sleep(10000);
  const now = Date.now();
  const url = `${apiUrl}/posts?startDate=${encodeURIComponent(new Date(now - 86400000).toISOString())}&endDate=${encodeURIComponent(new Date(now + 86400000).toISOString())}`;
  const response = await fetch(url, { headers: { Authorization: key } });
  const result = await payload(response);
  if (!response.ok) continue;
  const posts = Array.isArray(result) ? result : result?.posts || [];
  const current = posts.find((post) => post.id === newPostId);
  if (!current) continue;
  state.state = current.state; state.lastCheckedAt = new Date().toISOString(); state.releaseURL = current.releaseURL || null; state.releaseId = current.releaseId || null;
  await writeJson(retryStatePath, state);
  process.stderr.write(`${JSON.stringify({ retryPostId: newPostId, state: current.state, releaseURL: current.releaseURL || null })}\n`);
  if (current.state === "ERROR") throw new Error(`YouTube retry ${newPostId} entered ERROR`);
  if (current.state !== "PUBLISHED") continue;
  const deleted = await fetch(`${apiUrl}/posts/${failedId}`, { method: "DELETE", headers: { Authorization: key } });
  if (!deleted.ok && deleted.status !== 404) throw new Error(`Published retry succeeded, but old ERROR cleanup failed (${deleted.status})`);
  state.oldErrorDeleted = true; state.completedAt = new Date().toISOString(); await writeJson(retryStatePath, state);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`); process.exit(0);
}
throw new Error(`YouTube retry ${newPostId} did not reach a terminal state within 10 minutes`);
