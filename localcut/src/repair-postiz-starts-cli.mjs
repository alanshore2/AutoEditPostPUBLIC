import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { ensureExactCoverPublishMaster } from "./publish-master.mjs";
import { prepareLocalMediaBinaries } from "./pipeline.mjs";

const key = String(process.env.POSTIZ_KEY || "").trim();
const apiUrl = String(process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1").replace(/\/$/, "");
const commit = process.env.LOCALCUT_POSTIZ_START_COMMIT === "1";
if (!key) throw new Error("The in-memory Postiz credential was not provided");
if (commit && process.env.LOCALCUT_POSTIZ_START_CONFIRMATION !== "REPAIR STARTS") throw new Error('Live start repair requires "REPAIR STARTS"');

const AUTOEDIT = resolve(process.env.AUTOEDITPOST_ROOT || "C:/AutoEditPost");
const planPath = join(AUTOEDIT, "out", "rewrite", "plan.json");
const queuePath = resolve(process.env.LOCALCUT_POSTIZ_QUEUE || join(homedir(), "AppData", "Local", "Temp", "postiz-upcoming-2026-08-17.json"));
const statePath = resolve(process.env.LOCALCUT_POSTIZ_START_STATE || join(homedir(), ".localcut", "postiz-start-repair-state.json"));
const reportPath = resolve(process.env.LOCALCUT_POSTIZ_START_REPORT || join(homedir(), ".localcut", "postiz-start-repair-report.json"));
const createGapMs = Math.max(0, Number(process.env.LOCALCUT_POSTIZ_START_GAP_MS || 40000));
const headers = { Authorization: key };
const videoTypes = new Set(["dm", "insight", "yap"]);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanContent = (value) => String(value || "").trim().replace(/\r\n/g, "\n").replace(/\s+/g, " ");
const readJson = async (path, fallback = null) => { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } };
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, path);
};
const jsonPayload = async (response) => { const text = await response.text(); try { return text ? JSON.parse(text) : null; } catch { return { error: text.slice(0, 500) }; } };
// Remap paths recorded on another machine (AUTOEDITPOST_LINUX_ROOT) to this
// machine's AutoEditPost root before touching the files locally.
const LINUX_ROOT = process.env.AUTOEDITPOST_LINUX_ROOT || "/mnt/autoeditpost";
const localPath = (linuxPath) => { const s = String(linuxPath || ""); const mapped = s.toLowerCase().startsWith(LINUX_ROOT.toLowerCase()) ? AUTOEDIT + s.slice(LINUX_ROOT.length) : s; return resolve(mapped.replace(/\//g, process.platform === "win32" ? "\\" : "/")); };
const provider = (post) => String(post.integration?.providerIdentifier || "").replace("linkedin-page", "linkedin");
const targetKey = (platform, date) => `${platform}|${new Date(date).toISOString()}`;
const settingsFor = (remote, platform) => {
  let saved = remote.settings || {}; if (typeof saved === "string") { try { saved = JSON.parse(saved); } catch { saved = {}; } }
  const defaults = platform === "instagram" ? { post_type: "post" }
    : platform === "tiktok" ? { post_type: "post", privacy_level: "PUBLIC_TO_EVERYONE", duet: false, stitch: false, comment: true,
      autoAddMusic: "no", brand_content_toggle: false, brand_organic_toggle: false, content_posting_method: "DIRECT_POST" }
    : platform === "youtube" ? { title: String(remote.content || "Video").split(/\r?\n/)[0].slice(0, 90), type: "public", selfDeclaredMadeForKids: "no" }
    : platform === "linkedin" ? { post_as_images_carousel: false } : {};
  return { ...defaults, ...saved, __type: saved.__type || platform };
};

function cleanSourceFor(item) {
  const planned = localPath(item.media);
  if (item.type === "dm") return planned.replace(/_cover\.mp4$/i, "_FINAL.mp4");
  return planned.replace(/_cover\.mp4$/i, item.type === "yap" ? "_FINAL.mp4" : "_reel.mp4");
}

function coverFor(item, source) {
  if (item.type === "dm") {
    const match = basename(source).match(/c_(\d{3})/i); return join(AUTOEDIT, "out", "carousel_reels", "covers", `c_${match?.[1]}_cover.png`);
  }
  if (item.type === "yap") {
    const match = basename(source).match(/y_(\d{3})/i); return join(AUTOEDIT, "out", "yaps", "covers", `y_${match?.[1]}_cover.png`);
  }
  return source.replace(/_reel\.mp4$/i, "_reel.cover.png");
}

function run(command, args, cwd, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"] });
    let stdout = "", stderr = ""; if (capture) child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolveRun(`${stdout}\n${stderr}`) : reject(new Error(`Media command exited ${code}: ${stderr.slice(-2000)}`)));
  });
}

async function inspectOpening(source, ffmpeg) {
  const output = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", source, "-t", "3", "-af", "silencedetect=noise=-30dB:d=0.04", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"], dirname(source), true);
  const startsAtZero = /silence_start:\s*-?0(?:\.0+)?(?:\s|$)/.test(output); const end = Number(output.match(/silence_end:\s*([0-9.]+)/)?.[1]);
  const initialSilence = startsAtZero && Number.isFinite(end) ? end : 0;
  return { initialSilence: Number(initialSilence.toFixed(6)), trimSeconds: initialSilence > 0.08 ? Number(Math.max(0, initialSilence - 0.06).toFixed(6)) : 0 };
}

async function trimmedSource(source, opening, ffmpeg) {
  if (!opening.trimSeconds) return source;
  const output = source.replace(/\.mp4$/i, "_NO_DELAY.mp4"), receiptPath = `${output}.receipt.json`;
  const info = await stat(source); const fingerprint = createHash("sha256").update(`${source}|${info.size}|${info.mtimeMs}|${opening.trimSeconds}|v1`).digest("hex");
  const prior = await readJson(receiptPath, {}); if (prior.fingerprint === fingerprint && existsSync(output)) return output;
  const temporary = `${output}.${process.pid}.tmp.mp4`;
  await run(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-ss", String(opening.trimSeconds), "-i", source, "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", temporary], dirname(source));
  try { await unlink(output); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await rename(temporary, output); await writeJson(receiptPath, { fingerprint, source, output, trimSeconds: opening.trimSeconds, createdAt: new Date().toISOString() }); return output;
}

async function upload(path, state) {
  const absolute = resolve(path); if (state.uploads[absolute]) return state.uploads[absolute];
  const bytes = await readFile(absolute); let lastError;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const form = new FormData(); form.append("file", new Blob([bytes]), basename(absolute));
      const response = await fetch(`${apiUrl}/upload`, { method: "POST", headers, body: form }); const payload = await jsonPayload(response);
      if (response.ok && payload?.id && payload?.path) { state.uploads[absolute] = { id: payload.id, path: payload.path }; await writeJson(statePath, state); return state.uploads[absolute]; }
      lastError = new Error(`Upload failed (${response.status}): ${JSON.stringify(payload).slice(0, 180)}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) { lastError = error; }
    await sleep(Math.min(60000, 3000 * (attempt + 1)));
  }
  throw lastError;
}

const plan = await readJson(planPath, []), queue = await readJson(queuePath, {}), remotePosts = Array.isArray(queue) ? queue : queue.posts || [];
const priorState = await readJson(statePath, { schema: 1, startedAt: new Date().toISOString(), uploads: {}, replacements: {} });
priorState.uploads ||= {}; priorState.replacements ||= {};
const correctedPostIds = new Set(Object.values(priorState.replacements).filter((entry) => entry?.deletedOld && entry?.newPostId).map((entry) => entry.newPostId));
const planned = new Map();
for (const item of plan.filter((entry) => videoTypes.has(entry.type) && entry.media)) for (const post of item.posts || []) planned.set(targetKey(post.prov, post.date), { item, post });
const candidates = [];
for (const remote of remotePosts.filter((post) => post.state === "QUEUE")) {
  if (correctedPostIds.has(remote.id)) continue;
  const match = planned.get(targetKey(provider(remote), remote.publishDate)); if (!match) continue;
  if (cleanContent(remote.content) !== cleanContent(match.item.caption)) continue;
  const source = cleanSourceFor(match.item), cover = coverFor(match.item, source);
  if (!existsSync(source)) throw new Error(`Clean source is missing: ${source}`); if (!existsSync(cover)) throw new Error(`Cover is missing: ${cover}`);
  candidates.push({ oldPostId: remote.id, provider: provider(remote), publishDate: new Date(remote.publishDate).toISOString(), content: remote.content,
    integrationId: remote.integration.id, settings: settingsFor(remote, provider(remote)), source, cover, type: match.item.type, label: match.item.label });
}
candidates.sort((a, b) => Date.parse(a.publishDate) - Date.parse(b.publishDate));
const { ffmpeg } = await prepareLocalMediaBinaries(); const assets = new Map();
for (const candidate of candidates) if (!assets.has(candidate.source)) {
  const opening = await inspectOpening(candidate.source, ffmpeg); assets.set(candidate.source, { source: candidate.source, cover: candidate.cover, type: candidate.type, label: candidate.label, ...opening });
}
const summary = { checkedAt: new Date().toISOString(), queuePath, candidates: candidates.length, uniqueVideos: assets.size,
  uniquePublishDates: new Set(candidates.map((item) => item.publishDate)).size,
  byProvider: Object.fromEntries([...new Set(candidates.map((item) => item.provider))].sort().map((name) => [name, candidates.filter((item) => item.provider === name).length])),
  byType: Object.fromEntries([...videoTypes].map((name) => [name, candidates.filter((item) => item.type === name).length])),
  totalInitialSilenceSeconds: Number([...assets.values()].reduce((sum, item) => sum + item.initialSilence, 0).toFixed(3)),
  assets: [...assets.values()] };
if (!commit) { await writeJson(reportPath, { ...summary, dryRun: true }); process.stdout.write(`${JSON.stringify({ ...summary, assets: undefined, dryRun: true, reportPath }, null, 2)}\n`); process.exit(0); }

const state = priorState;
let lastCreate = 0, repaired = 0, tooClose = 0;
for (const candidate of candidates) {
  const existing = state.replacements[candidate.oldPostId]; if (existing?.deletedOld) { repaired++; continue; }
  if (Date.parse(candidate.publishDate) <= Date.now() + 5 * 60000) { tooClose++; continue; }
  const opening = assets.get(candidate.source); const source = await trimmedSource(candidate.source, opening, ffmpeg);
  const proof = await ensureExactCoverPublishMaster({ video: source, cover: candidate.cover });
  const video = await upload(proof.publishVideo, state); const cover = await upload(candidate.cover, state);
  const media = [{ ...video, thumbnail: cover.path, thumbnailTimestamp: proof.coverTimestampMs }]; let newPostId = existing?.newPostId || null;
  if (!newPostId) {
    const gap = lastCreate + createGapMs - Date.now(); if (gap > 0) await sleep(gap); lastCreate = Date.now();
    const settings = { ...candidate.settings, __type: candidate.settings?.__type || candidate.provider,
      ...(candidate.provider === "youtube" ? { thumbnail: cover } : {}) };
    const body = { type: "schedule", date: candidate.publishDate, shortLink: false, tags: [], posts: [{ integration: { id: candidate.integrationId }, settings,
      value: [{ content: candidate.content, image: media }] }] };
    let lastError;
    for (let attempt = 0; attempt < 10 && !newPostId; attempt++) {
      const response = await fetch(`${apiUrl}/posts`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }); const payload = await jsonPayload(response);
      newPostId = Array.isArray(payload) ? payload[0]?.postId : payload?.postId;
      if (response.ok && newPostId) break; lastError = new Error(`Create failed (${response.status}): ${JSON.stringify(payload).slice(0, 200)}`);
      await sleep(response.status === 429 ? 60000 : Math.min(30000, 3000 * (attempt + 1)));
    }
    if (!newPostId) throw lastError || new Error(`Create failed for ${candidate.oldPostId}`);
    state.replacements[candidate.oldPostId] = { newPostId, provider: candidate.provider, publishDate: candidate.publishDate, source: candidate.source,
      publishMaster: proof.publishVideo, initialSilenceRemoved: opening.initialSilence, deletedOld: false, createdAt: new Date().toISOString() }; await writeJson(statePath, state);
  }
  if (!state.replacements[candidate.oldPostId].deletedOld) {
    let deleted = false;
    for (let attempt = 0; attempt < 6 && !deleted; attempt++) {
      const response = await fetch(`${apiUrl}/posts/${candidate.oldPostId}`, { method: "DELETE", headers }); deleted = response.ok || response.status === 404;
      if (!deleted) await sleep(Math.min(30000, 3000 * (attempt + 1)));
    }
    if (!deleted) throw new Error(`Replacement ${newPostId} exists but old post ${candidate.oldPostId} could not be deleted`);
    state.replacements[candidate.oldPostId].deletedOld = true; state.replacements[candidate.oldPostId].deletedAt = new Date().toISOString(); await writeJson(statePath, state);
  }
  repaired++; process.stderr.write(`${JSON.stringify({ repaired, total: candidates.length, provider: candidate.provider, publishDate: candidate.publishDate, label: candidate.label, newPostId })}\n`);
}
state.completedAt = new Date().toISOString(); await writeJson(statePath, state);
const result = { ...summary, assets: [...assets.values()], dryRun: false, repaired, tooClose, remaining: candidates.length - repaired - tooClose, statePath };
await writeJson(reportPath, result); process.stdout.write(`${JSON.stringify({ ...result, assets: undefined }, null, 2)}\n`);
