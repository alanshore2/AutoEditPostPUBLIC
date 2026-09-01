import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const key = String(process.env.POSTIZ_KEY || "").trim();
const apiUrl = String(process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1").replace(/\/$/, "");
const queuePath = String(process.env.LOCALCUT_POSTIZ_QUEUE || "").trim();
const commit = process.env.LOCALCUT_POSTIZ_YOUTUBE_COMMIT === "1";
const gapMs = Math.max(36000, Number(process.env.LOCALCUT_POSTIZ_YOUTUBE_GAP_MS || 40000));
const repairStatePath = join(homedir(), ".localcut", "postiz-start-repair-state.json");
const statePath = join(homedir(), ".localcut", "postiz-youtube-shorts-repair-state.json");
if (!key || !queuePath) throw new Error("Postiz key and live queue snapshot are required");
if (commit && process.env.LOCALCUT_POSTIZ_YOUTUBE_CONFIRMATION !== "FIX YOUTUBE SHORTS") throw new Error('Live repair requires "FIX YOUTUBE SHORTS"');

const readJson = async (path, fallback = null) => { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } };
const writeJson = async (path, value) => { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, path); };
const jsonPayload = async (response) => { const text = await response.text(); try { return text ? JSON.parse(text) : null; } catch { return { error: text.slice(0, 400) }; } };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const parseSettings = (value) => { if (typeof value !== "string") return value || {}; try { return JSON.parse(value); } catch { return {}; } };

const queue = await readJson(queuePath), posts = Array.isArray(queue) ? queue : queue.posts || [];
const startRepair = await readJson(repairStatePath, {});
const correctedById = new Map(Object.values(startRepair.replacements || {}).map((entry) => [entry.newPostId, entry]));
const candidates = posts.filter((post) => post.state === "QUEUE" && post.integration?.providerIdentifier === "youtube" && correctedById.has(post.id))
  .sort((a, b) => Date.parse(a.publishDate) - Date.parse(b.publishDate));
const summary = { checkedAt: new Date().toISOString(), candidates: candidates.length, firstAt: candidates[0]?.publishDate || null, lastAt: candidates.at(-1)?.publishDate || null,
  reason: "YouTube Short uploaded successfully but Postiz thumbnail call caused provider ERROR", coverMode: "reviewed cover preserved as exact tail frame" };
if (!commit) { process.stdout.write(`${JSON.stringify({ ...summary, dryRun: true }, null, 2)}\n`); process.exit(0); }

const state = await readJson(statePath, { schema: 1, startedAt: new Date().toISOString(), replacements: {} }); state.replacements ||= {};
let lastCreate = 0, repaired = 0;
for (const post of candidates) {
  const previous = state.replacements[post.id]; if (previous?.deletedOld) { repaired++; continue; }
  const source = correctedById.get(post.id); const video = startRepair.uploads?.[source.publishMaster];
  if (!video?.id || !video?.path) throw new Error(`Corrected upload receipt missing for ${post.id}`);
  const { thumbnail: _unsupportedThumbnail, ...savedSettings } = parseSettings(post.settings);
  const settings = { ...savedSettings, __type: "youtube", selfDeclaredMadeForKids: savedSettings.selfDeclaredMadeForKids || "no", tags: Array.isArray(savedSettings.tags) ? savedSettings.tags : [] };
  const body = { type: "schedule", date: new Date(post.publishDate).toISOString(), shortLink: false, tags: [], posts: [{ integration: { id: post.integration.id }, settings,
    value: [{ content: post.content, image: [{ id: video.id, path: video.path }] }] }] };
  let newPostId = previous?.newPostId || null;
  if (!newPostId) {
    const wait = lastCreate + gapMs - Date.now(); if (wait > 0) await sleep(wait); lastCreate = Date.now();
    const response = await fetch(`${apiUrl}/posts`, { method: "POST", headers: { Authorization: key, "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await jsonPayload(response); newPostId = Array.isArray(result) ? result[0]?.postId : result?.postId;
    if (!response.ok || !newPostId) throw new Error(`YouTube replacement failed (${response.status}): ${JSON.stringify(result).slice(0, 300)}`);
    state.replacements[post.id] = { newPostId, publishDate: post.publishDate, publishMaster: source.publishMaster, deletedOld: false, createdAt: new Date().toISOString(),
      coverMode: "exact-tail-frame", openingStartsAtZero: true }; await writeJson(statePath, state);
  }
  if (!state.replacements[post.id].deletedOld) {
    const deleted = await fetch(`${apiUrl}/posts/${post.id}`, { method: "DELETE", headers: { Authorization: key } });
    if (!deleted.ok && deleted.status !== 404) throw new Error(`Created ${newPostId}, but could not delete old YouTube post ${post.id} (${deleted.status})`);
    state.replacements[post.id].deletedOld = true; state.replacements[post.id].deletedAt = new Date().toISOString(); await writeJson(statePath, state);
  }
  repaired++; process.stderr.write(`${JSON.stringify({ repaired, total: candidates.length, publishDate: post.publishDate, newPostId })}\n`);
}
state.completedAt = new Date().toISOString(); await writeJson(statePath, state);
process.stdout.write(`${JSON.stringify({ ...summary, dryRun: false, repaired, remaining: candidates.length - repaired, statePath }, null, 2)}\n`);
