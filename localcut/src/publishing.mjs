import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { computeReelApprovalRevision, resolveReelApproval } from "./approval.mjs";
import { ensureExactCoverPublishMaster } from "./publish-master.mjs";

export const DEFAULT_POSTIZ_API_URL = "https://api.postiz.com/public/v1";
// Integration ids come from your own Postiz account: set POSTIZ_IG,
// POSTIZ_FACEBOOK, etc. to the integration ids Postiz shows for each channel.
export const POSTIZ_PLATFORMS = Object.freeze({
  instagram: { label: "Instagram", env: "POSTIZ_IG", id: "", supportsImageCarousel: true },
  facebook: { label: "Facebook", env: "POSTIZ_FACEBOOK", id: "", supportsImageCarousel: true },
  linkedin: { label: "LinkedIn", env: "POSTIZ_LINKEDIN", id: "", supportsImageCarousel: true },
  tiktok: { label: "TikTok", env: "POSTIZ_TIKTOK", id: "", supportsImageCarousel: true },
  youtube: { label: "YouTube", env: "POSTIZ_YOUTUBE", id: "", supportsImageCarousel: false },
});
export const POSTIZ_POLICY = Object.freeze({
  timeZone: "America/New_York",
  reelTimes: ["09:00", "18:00"],
  carouselTime: "13:00",
  tiktokLeadMinutes: 60,
  // Site appended to YouTube captions ("Work with me: <site>"); empty = skip.
  youtubeSite: "",
  createGapMs: 40000,
});

const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
const unique = (values) => [...new Set(values)];
const cleanText = (value, max = 4000) => String(value || "").trim().replace(/\r\n/g, "\n").slice(0, max);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const readJson = async (path, fallback = null) => {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
};
const writeJsonAtomic = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
};
const addDays = (date, days) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
const shiftLocalTime = (date, time, minutes) => {
  const [hour, minute] = time.split(":").map(Number);
  const total = hour * 60 + minute + minutes;
  const dayOffset = Math.floor(total / 1440);
  const normalized = ((total % 1440) + 1440) % 1440;
  return { date: addDays(date, dayOffset), time: `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}` };
};
const deliveryFor = (platform, date, time, timeZone) => {
  const local = shiftLocalTime(date, time, platform === "tiktok" ? -POSTIZ_POLICY.tiktokLeadMinutes : 0);
  return { platform, localDate: local.date, localTime: local.time, scheduledAt: zonedDateTimeToUtc(local.date, local.time, timeZone) };
};
const withoutKeywordCommentCta = (text) => cleanText(text).split(/\n{2,}/)
  .filter((paragraph) => !/^comment\s+[a-z0-9_-]+\b/i.test(paragraph.trim())).join("\n\n").trim();
const platformCaption = (item, platform) => {
  let caption = platform === "instagram" ? cleanText(item.caption) : withoutKeywordCommentCta(item.caption);
  if (platform === "instagram" && item.pinnedComment && !caption.toLowerCase().includes(item.pinnedComment.toLowerCase())) caption += `\n\n${item.pinnedComment}`;
  if (platform === "youtube") {
    const site = process.env.LOCALCUT_YOUTUBE_SITE || POSTIZ_POLICY.youtubeSite;
    if (site && !caption.toLowerCase().includes(site.toLowerCase())) caption += `\n\nWork with me: ${site}`;
    if (!/(^|\s)#shorts\b/i.test(caption)) caption += "\n\n#Shorts";
  }
  return caption.replace(/\s*[—–]\s*/g, ", ").trim();
};
const tomorrowIn = (timeZone, now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return addDays(`${values.year}-${values.month}-${values.day}`, 1);
};

export function zonedDateTimeToUtc(date, time, timeZone = "America/New_York") {
  if (!validDate(date) || !validTime(time)) throw new Error(`Invalid local schedule time: ${date} ${time}`);
  const [year, month, day] = date.split("-").map(Number); const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let guess = target;
  for (let pass = 0; pass < 3; pass++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    guess += target - represented;
  }
  return new Date(guess).toISOString().replace(/\.\d+Z$/, ".000Z");
}

function captionForCarousel(spec = {}) {
  const headline = cleanText(spec.hook?.h1 || "The conversation behind the result", 500);
  const lede = cleanText(spec.hook?.lede || spec.reason || "Swipe through the exact conversation.", 900);
  return `${headline}\n\n${lede}\n\nPlot twist: every reply on the right was my AI setter, not me.\n\nComment TEARDOWN and I'll show you exactly where your DMs are leaking bookings.\n\n#AISetter #DMStrategy #AppointmentSetting`;
}

async function scheduledCarouselIndexes(autoEditRoot) {
  const scheduled = new Set(); const platforms = new Map();
  const add = (index, platformNames = []) => {
    if (!Number.isInteger(index) || index < 0) return;
    scheduled.add(index); const previous = platforms.get(index) || new Set();
    for (const platform of platformNames) previous.add(platform); platforms.set(index, previous);
  };
  const native = await readJson(join(autoEditRoot, "out", "ghl", "scheduled_native.json"), {});
  for (const [key, value] of Object.entries(native || {})) add(Number(key), Object.keys(POSTIZ_PLATFORMS).filter((platform) => Boolean(value?.[platform])));
  const legacy = await readJson(join(autoEditRoot, "out", "ghl", "scheduled_carousels.json"), {});
  for (const [key, value] of Object.entries(legacy || {})) add(Number(key) - 1, Object.keys(POSTIZ_PLATFORMS).filter((platform) => Boolean(value?.[platform])));
  const daily = await readJson(join(autoEditRoot, "out", "rewrite", "carousel_daily_state.json"), {});
  for (const key of Object.keys(daily?.posts || {})) { const [index, platform] = key.split(":"); add(Number(index), [platform]); }
  return { scheduled, platforms };
}

export async function discoverCarouselLibrary(autoEditRoot) {
  const nativeRoot = join(autoEditRoot, "out", "ghl", "native");
  const specs = await readJson(join(autoEditRoot, "out", "ghl", "deck_specs.json"), []);
  const byIndex = new Map((Array.isArray(specs) ? specs : []).map((spec) => [Number(spec.i), spec]));
  const previous = await scheduledCarouselIndexes(autoEditRoot);
  let entries = [];
  try { entries = await readdir(nativeRoot, { withFileTypes: true }); } catch { return []; }
  const decks = [];
  for (const entry of entries) {
    const match = entry.isDirectory() && /^c_(\d{3})$/i.exec(entry.name); if (!match) continue;
    const number = Number(match[1]), index = number - 1, directory = join(nativeRoot, entry.name);
    const names = (await readdir(directory)).filter((name) => /^slide_\d+\.png$/i.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (!names.length) continue;
    const spec = byIndex.get(index) || {};
    const video = join(nativeRoot, "video", `${entry.name}.mp4`);
    decks.push({
      id: entry.name.toLowerCase(), number, title: cleanText(spec.hook?.h1 || `Carousel ${number}`, 300),
      lede: cleanText(spec.hook?.lede || spec.reason || "", 700), caption: captionForCarousel(spec), outcome: spec.outcome || null,
      slides: names.map((name) => join(directory, name)), slideCount: names.length, preview: join(directory, names[0]),
      video: existsSync(video) ? video : null, scheduledBefore: previous.scheduled.has(index),
      scheduledPlatforms: [...(previous.platforms.get(index) || [])], ready: names.length >= 2,
    });
  }
  return decks.sort((a, b) => a.number - b.number);
}

const platformAlias = (value) => {
  const normalized = String(value || "").toLowerCase();
  return ({ ig: "instagram", instagram: "instagram", "instagram-standalone": "instagram", fb: "facebook", facebook: "facebook",
    li: "linkedin", linkedin: "linkedin", "linkedin-page": "linkedin", tt: "tiktok", tiktok: "tiktok", yt: "youtube", youtube: "youtube" })[normalized] || normalized || "unknown";
};
const scheduleContentKey = (value) => cleanText(value).replace(/\s+/g, " ").toLowerCase();
const scheduleTitle = (value) => cleanText(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 120)
  .split(/\n|(?<=[.!?])\s+/)[0].replace(/^#+\s*/, "") || "Postiz content";

export function reconcilePostizSchedule(remotePosts = [], lookup = {}, integrations = [], current = new Date()) {
  const byPostId = lookup.byPostId instanceof Map ? lookup.byPostId : new Map(Object.entries(lookup.byPostId || {}));
  const byContent = lookup.byContent instanceof Map ? lookup.byContent : new Map(Object.entries(lookup.byContent || {}));
  const integrationById = new Map((Array.isArray(integrations) ? integrations : []).map((item) => [item.id, item]));
  const nowMs = current instanceof Date ? current.getTime() : Date.parse(current);
  return (Array.isArray(remotePosts) ? remotePosts : []).map((post) => {
    const integration = post.integration || {}; const connected = integrationById.get(integration.id) || {};
    const platform = platformAlias(integration.providerIdentifier || integration.identifier || connected.identifier);
    const content = cleanText(post.content, 4000); const tracked = byPostId.get(post.id) || byContent.get(scheduleContentKey(content)) || null;
    const publishMs = Date.parse(post.publishDate); const releaseUrl = cleanText(post.releaseURL || post.releaseUrl, 1200) || null;
    const status = releaseUrl ? "published" : Number.isFinite(publishMs) && publishMs > nowMs ? "scheduled" : "past-unverified";
    return {
      id: String(post.id || ""), content, title: cleanText(tracked?.title || scheduleTitle(content), 160), publishDate: post.publishDate,
      releaseUrl, status, platform, platformLabel: POSTIZ_PLATFORMS[platform]?.label || connected.name || platform || "Unknown",
      channel: integration.name || connected.name || connected.profile || "Connected channel", channelPicture: integration.picture || connected.picture || null,
      kind: tracked?.kind || "other", itemId: tracked?.itemId || null, batchName: tracked?.batchName || null,
      planId: tracked?.planId || null, tracked: Boolean(tracked), trackingSource: tracked?.source || null,
    };
  }).sort((left, right) => Date.parse(left.publishDate) - Date.parse(right.publishDate));
}

async function buildReelLibrary(run) {
  const manifest = await readJson(run.config.manifestPath, []);
  const byReel = new Map((Array.isArray(manifest) ? manifest : []).map((entry) => [String(entry.id ?? entry.reel).padStart(2, "0"), entry]));
  const reels = [];
  for (const artifact of run.artifacts || []) {
    const id = String(artifact.reel).padStart(2, "0"), entry = byReel.get(id) || {};
    const qa = await readJson(artifact.qa, null); const workDir = dirname(artifact.video);
    const cover = join(workDir, `${artifact.label}_cover.jpg`), captions = join(workDir, "cap.ass"), seoPath = join(workDir, "seo-keywords.json"), reviewPath = join(workDir, "review-feedback.json");
    const seo = await readJson(seoPath, entry.seo || qa?.seo || {});
    const review = await readJson(reviewPath, {});
    const reviewedCoverSeconds = Number(review?.cover?.atSeconds);
    const qaCoverSeconds = Number(qa?.effects?.coverAtSeconds);
    const coverAtSeconds = Number.isFinite(reviewedCoverSeconds) && reviewedCoverSeconds >= 0
      ? reviewedCoverSeconds
      : Number.isFinite(qaCoverSeconds) && qaCoverSeconds >= 0 ? qaCoverSeconds : 0;
    const hashtags = Array.isArray(seo?.hashtags) ? seo.hashtags : [];
    const baseCaption = cleanText(entry.postCaption || qa?.postCaption || entry.title || artifact.label, 2500);
    const pinnedComment = cleanText(entry.keyword?.pinnedComment || qa?.pinnedComment || "", 700);
    const caption = `${baseCaption}${hashtags.length ? `\n\n${hashtags.join(" ")}` : ""}`;
    const technicalReady = existsSync(artifact.video) && existsSync(cover) && existsSync(captions) && existsSync(seoPath) && Boolean(qa?.ok) && Boolean(caption);
    const approvalRevision = technicalReady ? await computeReelApprovalRevision({ video: artifact.video, cover, captions, seo: seoPath, qa: artifact.qa }) : null;
    const approval = resolveReelApproval(review, approvalRevision); const ready = technicalReady && approval.approved;
    const reviewedPublishProof = review?.cover?.publishProof || {};
    reels.push({ id, title: cleanText(entry.title || qa?.title || artifact.label || `Reel ${id}`, 300), video: artifact.video,
      publishVideo: existsSync(reviewedPublishProof.publishVideo || "") ? reviewedPublishProof.publishVideo : null,
      publishCoverTimestampMs: Number.isFinite(Number(reviewedPublishProof.coverTimestampMs)) ? Number(reviewedPublishProof.coverTimestampMs) : null,
      publishProof: reviewedPublishProof, cover, coverAtSeconds,
      durationSeconds: Number(qa?.media?.duration) || null, captions, seoPath,
      caption, pinnedComment, seo, ready, technicalReady, approval, approvalRevision, qaPassed: Boolean(qa?.ok), seoReady: existsSync(seoPath), coverReady: existsSync(cover) });
  }
  return reels.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeOptions(options, snapshot) {
  const timeZone = cleanText(options.timeZone || POSTIZ_POLICY.timeZone, 80);
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(); } catch { throw new Error(`Unsupported time zone: ${timeZone}`); }
  const startDate = String(options.startDate || tomorrowIn(timeZone)); if (!validDate(startDate)) throw new Error("Choose a valid start date");
  const reelTimes = unique((Array.isArray(options.reelTimes) ? options.reelTimes : String(options.reelTimes || POSTIZ_POLICY.reelTimes.join(",")).split(",")).map((item) => String(item).trim()).filter(Boolean));
  if (!reelTimes.length || reelTimes.some((time) => !validTime(time))) throw new Error("Reel slots must use 24-hour HH:MM times");
  const carouselTime = String(options.carouselTime || POSTIZ_POLICY.carouselTime).trim(); if (!validTime(carouselTime)) throw new Error("Carousel time must use 24-hour HH:MM");
  const platforms = unique((options.platforms || Object.keys(POSTIZ_PLATFORMS)).filter((platform) => POSTIZ_PLATFORMS[platform]));
  if (!platforms.length) throw new Error("Select at least one Postiz platform");
  const readyReels = new Set(snapshot.reels.filter((item) => item.ready).map((item) => item.id));
  const reelIds = unique((options.reelIds || [...readyReels]).map((id) => String(id).padStart(2, "0"))).filter((id) => readyReels.has(id));
  const allowPreviouslyScheduled = options.allowPreviouslyScheduled === true;
  const readyCarousels = new Set(snapshot.carousels.filter((item) => item.ready && (allowPreviouslyScheduled || !item.scheduledBefore)).map((item) => item.id));
  const carouselIds = unique((options.carouselIds || []).map(String)).filter((id) => readyCarousels.has(id));
  if (!reelIds.length && !carouselIds.length) throw new Error("Select at least one ready reel or carousel");
  return { startDate, reelTimes, carouselTime, timeZone, platforms, reelIds, carouselIds, allowPreviouslyScheduled };
}

export function buildPublishingPlan(snapshot, requestedOptions = {}, now = new Date()) {
  const options = normalizeOptions(requestedOptions, snapshot); const items = [];
  options.reelIds.forEach((id, index) => {
    const reel = snapshot.reels.find((item) => item.id === id); const slot = options.reelTimes[index % options.reelTimes.length]; const day = Math.floor(index / options.reelTimes.length); const date = addDays(options.startDate, day);
    const item = { key: `reel:${id}`, kind: "reel", id, title: reel.title, date, time: slot, timeZone: options.timeZone,
      approvalRevision: reel.approvalRevision || null, caption: reel.caption, pinnedComment: reel.pinnedComment, seo: reel.seo || {}, assets: {
        default: [reel.publishVideo || reel.video], youtube: [reel.publishVideo || reel.video], sourceVideo: reel.video, cover: reel.cover,
        coverTimestampMs: reel.publishCoverTimestampMs ?? coverTimestampMs(reel.coverAtSeconds, reel.durationSeconds),
        exactReviewedCover: Boolean(reel.publishVideo && reel.publishProof?.openingStartsAtZero),
        openingStartsAtZero: Boolean(reel.publishProof?.openingStartsAtZero), coverProof: reel.publishProof || null, youtubeThumbnail: reel.cover,
      }, assetCount: 1, platforms: options.platforms };
    item.deliveries = item.platforms.map((platform) => ({ ...deliveryFor(platform, date, slot, options.timeZone), content: platformCaption(item, platform) }));
    items.push(item);
  });
  options.carouselIds.forEach((id, index) => {
    const carousel = snapshot.carousels.find((item) => item.id === id); const date = addDays(options.startDate, index);
    const item = { key: `carousel:${id}`, kind: "carousel", id, title: carousel.title, date, time: options.carouselTime, timeZone: options.timeZone,
      caption: carousel.caption, pinnedComment: "", seo: {}, assets: { default: carousel.slides, youtube: carousel.video ? [carousel.video] : [], youtubeThumbnail: carousel.preview }, assetCount: carousel.slideCount,
      scheduledBefore: carousel.scheduledBefore, platforms: options.platforms.filter((platform) => platform !== "youtube" || Boolean(carousel.video)) };
    item.deliveries = item.platforms.map((platform) => ({ ...deliveryFor(platform, date, options.carouselTime, options.timeZone), content: platformCaption(item, platform) }));
    items.push(item);
  });
  const deliveries = items.flatMap((item) => item.deliveries.map((delivery) => ({ ...delivery, key: `${item.key}:${delivery.platform}`, itemKey: item.key, kind: item.kind, itemId: item.id, title: item.title })));
  const plan = { schema: 4, id: `postiz_${randomUUID()}`, runId: snapshot.runId, batchName: snapshot.batchName, createdAt: now.toISOString(), options,
    policy: { reelsPerDay: options.reelTimes.length, reelTimes: options.reelTimes, carouselsPerDay: 1, carouselTime: options.carouselTime, tiktokLeadMinutes: POSTIZ_POLICY.tiktokLeadMinutes, youtubeCta: POSTIZ_POLICY.youtubeSite }, items, deliveries,
    summary: { items: items.length, reels: items.filter((item) => item.kind === "reel").length, carousels: items.filter((item) => item.kind === "carousel").length, posts: deliveries.length,
      platforms: options.platforms, firstAt: deliveries.map((item) => item.scheduledAt).sort()[0] || null, lastAt: deliveries.map((item) => item.scheduledAt).sort().at(-1) || null,
      estimatedCreateMinutes: Math.ceil(deliveries.length * POSTIZ_POLICY.createGapMs / 60000) } };
  plan.fingerprint = fingerprintPlan(plan);
  return plan;
}

function coverTimestampMs(seconds, durationSeconds = null) {
  const selected = Number(seconds); if (!Number.isFinite(selected) || selected < 0) return 0;
  const duration = Number(durationSeconds); const maximum = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.05) : selected;
  return Math.round(Math.min(selected, maximum) * 1000);
}

function mediaWithCover(media, item, cover) {
  if (item.kind !== "reel" || !cover?.path || !media.length) return media;
  return media.map((entry, index) => index === 0 ? {
    ...entry,
    thumbnail: cover.path,
    thumbnailTimestamp: Math.max(0, Math.round(Number(item.assets.coverTimestampMs) || 0)),
  } : entry);
}

function fingerprintPlan(plan) {
  return createHash("sha256").update(JSON.stringify({ schema: plan.schema, runId: plan.runId, options: plan.options, policy: plan.policy,
    items: plan.items.map(({ assets, ...item }) => ({ ...item, assets })) })).digest("hex");
}

function postSettings(platform, item, extras = {}) {
  if (platform === "instagram") return { __type: "instagram", post_type: "post", is_trial_reel: false, collaborators: [] };
  if (platform === "facebook") return { __type: "facebook" };
  if (platform === "linkedin") return { __type: "linkedin", post_as_images_carousel: item.kind === "carousel" && item.assetCount > 1,
    ...(item.kind === "carousel" ? { carousel_name: item.title.slice(0, 100) } : {}) };
  if (platform === "tiktok") return { __type: "tiktok", title: item.title.slice(0, 90), post_type: "post", privacy_level: "PUBLIC_TO_EVERYONE", duet: false, stitch: false, comment: true, autoAddMusic: "no", brand_content_toggle: false, brand_organic_toggle: false, video_made_with_ai: false, content_posting_method: "DIRECT_POST" };
  // YouTube Shorts on this channel accept the video but reject thumbnails.set,
  // which makes Postiz report ERROR after the Short is already public. Keep the
  // reviewed cover as the exact tail frame in the publish master and omit the
  // unsupported provider thumbnail call.
  if (platform === "youtube") return { __type: "youtube", title: item.title.slice(0, 100), type: "public", selfDeclaredMadeForKids: "no",
    tags: unique([item.seo?.primaryPhrase, ...(item.seo?.keywords || []), ...(item.seo?.related || [])].filter(Boolean)).slice(0, 15).map((value) => ({ value, label: value })) };
  throw new Error(`Unsupported Postiz platform: ${platform}`);
}

export function createPublishingManager({ autoEditRoot, dataDir, pipelineManager, getCredential = async () => ({ key: process.env.POSTIZ_KEY || "", apiUrl: process.env.POSTIZ_API_URL || DEFAULT_POSTIZ_API_URL }), fetchImpl = fetch,
  createGapMs = Number(process.env.POSTIZ_CREATE_GAP_MS || POSTIZ_POLICY.createGapMs), now = () => new Date(), preparePublishMaster = ensureExactCoverPublishMaster } = {}) {
  if (!autoEditRoot || !dataDir || !pipelineManager) throw new Error("Publishing manager requires AutoEditPost, LocalCut data, and pipeline manager roots");
  const planIndexPath = join(dataDir, "postiz-plans.json");
  const resolveRun = async (runId) => {
    let id = runId;
    if (!id) { const listed = await pipelineManager.call("list_talking_head_pipelines", {}); id = listed.pipelines?.[0]?.id; }
    if (!id) throw new Error("No talking-head batch is available");
    return pipelineManager.call("read_talking_head_pipeline", { runId: id });
  };
  const publicConnection = async () => {
    const credential = await getCredential();
    return { configured: Boolean(credential?.key), apiUrl: credential?.apiUrl || DEFAULT_POSTIZ_API_URL,
      platforms: Object.entries(POSTIZ_PLATFORMS).map(([id, platform]) => ({ id, label: platform.label, integrationId: process.env[platform.env] || platform.id })) };
  };
  const integrationIdFor = (platform) => process.env[POSTIZ_PLATFORMS[platform].env] || POSTIZ_PLATFORMS[platform].id;
  const jsonPayload = async (response) => {
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { return { error: text.slice(0, 500) }; }
  };
  const getJson = async (url, headers, attempts = 5, timeoutMs = Number(process.env.POSTIZ_READ_TIMEOUT_MS || 15000)) => {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error(`Postiz read timed out after ${timeoutMs}ms`)), timeoutMs);
        let response; try { response = await fetchImpl(url, { headers, signal: controller.signal }); } finally { clearTimeout(timer); }
        const payload = await jsonPayload(response);
        if (response.ok) return payload;
        lastError = new Error(`Postiz returned HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 240)}`);
        if (response.status !== 429 && response.status < 500) { lastError.nonRetryable = true; throw lastError; }
      } catch (error) { if (error?.nonRetryable) throw error; lastError = error; }
      if (attempt + 1 < attempts) await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
    throw lastError || new Error("Postiz request failed");
  };
  const loadIntegrations = async (apiUrl, headers, attempts = 5) => {
    const payload = await getJson(`${apiUrl}/integrations`, headers, attempts);
    if (!Array.isArray(payload)) throw new Error("Postiz integrations response was not a list");
    return payload;
  };
  const validateIntegrations = (platforms, integrations) => {
    const aliases = { instagram: new Set(["instagram", "instagram-standalone"]), linkedin: new Set(["linkedin", "linkedin-page"]) };
    for (const platform of unique(platforms)) {
      const id = integrationIdFor(platform); const connected = integrations.find((item) => item.id === id);
      if (!connected) throw new Error(`${POSTIZ_PLATFORMS[platform].label} integration ${id} is not connected in Postiz`);
      if (connected.disabled) throw new Error(`${POSTIZ_PLATFORMS[platform].label} integration is disabled in Postiz`);
      const allowed = aliases[platform] || new Set([platform]);
      if (!allowed.has(connected.identifier)) throw new Error(`${POSTIZ_PLATFORMS[platform].label} integration points to ${connected.identifier || "an unknown provider"}`);
    }
  };
  const postsWindow = (plan) => ({
    start: new Date(Date.parse(plan.summary.firstAt) - 86400000).toISOString(),
    end: new Date(Date.parse(plan.summary.lastAt) + 86400000).toISOString(),
  });
  const listRemotePosts = async (apiUrl, headers, plan) => {
    const range = postsWindow(plan); const payload = await getJson(`${apiUrl}/posts?startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}`, headers);
    return Array.isArray(payload) ? payload : Array.isArray(payload?.posts) ? payload.posts : [];
  };
  const matchingRemotePost = (remotePosts, delivery, integrationId) => remotePosts.find((post) => post.integration?.id === integrationId
    && Math.abs(Date.parse(post.publishDate) - Date.parse(delivery.scheduledAt)) < 1000
    && cleanText(post.content).replace(/\s+/g, " ") === cleanText(delivery.content).replace(/\s+/g, " "));
  const validSavedPlan = (plan, runId) => {
    try { return plan?.runId === runId && plan.schema === 4 && plan.fingerprint === fingerprintPlan(plan); } catch { return false; }
  };
  const buildLocalScheduleLookup = async (carousels = []) => {
    const byPostId = new Map(), byContent = new Map();
    const carouselById = new Map(carousels.map((item) => [item.id, item]));
    const add = (postId, detail) => {
      const id = String(postId || "").trim(); if (!id) return;
      byPostId.set(id, { ...detail, platform: detail.platform ? platformAlias(detail.platform) : null });
    };
    const addContent = (content, detail) => { const key = scheduleContentKey(content); if (key && !byContent.has(key)) byContent.set(key, detail); };
    const plans = await readJson(planIndexPath, {}); const planValues = Object.values(plans || {});
    for (const plan of planValues) for (const item of plan?.items || []) {
      const detail = { kind: item.kind || "other", itemId: item.id || null, title: item.title || item.key, batchName: plan.batchName || null, planId: plan.id, source: "localcut-plan" };
      for (const delivery of item.deliveries || []) addContent(delivery.content, { ...detail, platform: delivery.platform });
    }
    let pipelineList = [];
    try { pipelineList = (await pipelineManager.call("list_talking_head_pipelines", {})).pipelines || []; } catch { /* schedule view can still show remote posts */ }
    for (const candidate of pipelineList) {
      try {
        const run = await pipelineManager.call("read_talking_head_pipeline", { runId: candidate.id, includeNodes: false });
        const state = await readJson(join(run.config.outputDir, "postiz-schedule-state.json"), null); if (!state?.posts) continue;
        const plan = plans?.[state.planId]; const itemByKey = new Map((plan?.items || []).map((item) => [item.key, item]));
        for (const record of Object.values(state.posts)) {
          const item = itemByKey.get(record.itemKey) || {}; const [kind = "other", itemId = null] = String(record.itemKey || "").split(":");
          add(record.postId, { kind: item.kind || kind, itemId: item.id || itemId, title: item.title || record.itemKey || "LocalCut post",
            batchName: plan?.batchName || run.name || null, planId: state.planId || null, platform: record.platform, source: "localcut-state" });
        }
      } catch { /* one stale pipeline must not hide the rest of the live calendar */ }
    }
    const carouselDetail = (index, source, platform = null) => {
      const itemId = `c_${String(Number(index) + 1).padStart(3, "0")}`, item = carouselById.get(itemId);
      return { kind: "carousel", itemId, title: item?.title || `Carousel ${Number(index) + 1}`, batchName: "AutoEditPost carousel library", platform, source };
    };
    const addPlatformValues = (value, detail) => {
      for (const [key, postId] of Object.entries(value || {})) if (typeof postId === "string" && /^(instagram|facebook|linkedin|tiktok|youtube|ig|fb|li|tt|yt)$/i.test(key)) add(postId, { ...detail, platform: key });
    };
    const native = await readJson(join(autoEditRoot, "out", "ghl", "scheduled_native.json"), {});
    for (const [index, value] of Object.entries(native || {})) addPlatformValues(value, carouselDetail(Number(index), "autoeditpost-native-carousel"));
    const legacy = await readJson(join(autoEditRoot, "out", "ghl", "scheduled_carousels.json"), {});
    for (const [number, value] of Object.entries(legacy || {})) addPlatformValues(value, carouselDetail(Number(number) - 1, "autoeditpost-legacy-carousel"));
    const daily = await readJson(join(autoEditRoot, "out", "rewrite", "carousel_daily_state.json"), {});
    for (const [key, postId] of Object.entries(daily?.posts || {})) { const [index, platform] = key.split(":"); add(postId, carouselDetail(Number(index), "autoeditpost-daily-carousel", platform)); }
    const youtube = await readJson(join(autoEditRoot, "out", "ghl", "scheduled_youtube.json"), {});
    for (const [key, postId] of Object.entries(youtube || {})) {
      const isCarousel = key.startsWith("carousel:"); const number = Number(key.match(/(?:deck|reel)_(\d+)/i)?.[1] || 0);
      add(postId, isCarousel ? { ...carouselDetail(Math.max(0, number - 1), "autoeditpost-youtube-carousel", "youtube") }
        : { kind: "reel", itemId: number ? String(number).padStart(2, "0") : null, title: number ? `Legacy reel ${String(number).padStart(2, "0")}` : "Legacy reel", batchName: "AutoEditPost reels", platform: "youtube", source: "autoeditpost-youtube-reel" });
    }
    const gallery = await readJson(join(autoEditRoot, "out", "_gallery", "scheduled.json"), {});
    for (const [number, postId] of Object.entries(gallery || {})) add(postId, { kind: "reel", itemId: String(number), title: `Gallery reel ${number}`, batchName: "AutoEditPost gallery", source: "autoeditpost-gallery" });
    const galleryChannels = await readJson(join(autoEditRoot, "out", "_gallery", "scheduled_channels.json"), {});
    for (const [number, value] of Object.entries(galleryChannels || {})) addPlatformValues(value, { kind: "reel", itemId: String(number), title: `Gallery reel ${number}`, batchName: "AutoEditPost gallery", source: "autoeditpost-gallery-channel" });
    const carouselReels = await readJson(join(autoEditRoot, "out", "carousel_reels", "scheduled_reels.json"), {});
    const walkCarouselReels = (value, number = null) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        const nextNumber = /^\d+$/.test(key) ? key : number;
        if (typeof child === "string" && /^(instagram|facebook|linkedin|tiktok|youtube|ig|fb|li|tt|yt)$/i.test(key)) add(child, { kind: "reel", itemId: nextNumber, title: `Carousel reel ${nextNumber || ""}`.trim(), batchName: "AutoEditPost carousel reels", platform: key, source: "autoeditpost-carousel-reel" });
        else if (child && typeof child === "object" && key !== "media") walkCarouselReels(child, nextNumber);
      }
    };
    walkCarouselReels(carouselReels);
    const rewriteDetail = (descriptor) => {
      const [label, platform] = String(descriptor || "").split(":");
      const carousel = label.match(/\bc_(\d{3})\b/i), yap = label.match(/\by_(\d{3})\b/i), numbered = label.match(/\b(?:reel|yap)\s+(\d+)\b/i);
      const itemId = carousel ? `c_${carousel[1]}` : yap ? `y_${yap[1]}` : numbered ? String(numbered[1]).padStart(2, "0") : null;
      return { kind: "reel", itemId, title: cleanText(label || "AutoEditPost reel", 160), batchName: "AutoEditPost rewrite queue", platform, source: "autoeditpost-rewrite" };
    };
    const humanize = await readJson(join(autoEditRoot, "out", "rewrite", "humanize_state.json"), {});
    for (const [descriptor, postId] of Object.entries(humanize?.posts || {})) add(postId, rewriteDetail(descriptor));
    const coverFixes = await readJson(join(autoEditRoot, "out", "rewrite", "fix_covers_state.json"), {});
    for (const [oldPostId, newPostId] of Object.entries(coverFixes?.new || {})) {
      const previous = byPostId.get(oldPostId); if (previous) add(newPostId, { ...previous, source: "autoeditpost-cover-repair" });
    }
    return { byPostId, byContent };
  };
  const activeSchedule = async (options = {}) => {
    const credential = await getCredential(); if (!credential?.key) throw new Error("Connect Postiz first");
    const apiUrl = String(credential.apiUrl || DEFAULT_POSTIZ_API_URL).replace(/\/$/, ""), headers = { Authorization: credential.key };
    const current = now(); const daysBefore = Math.max(0, Math.min(30, Number(options.daysBefore ?? 2))); const daysAhead = Math.max(1, Math.min(90, Number(options.daysAhead ?? 30)));
    const start = new Date(current.getTime() - daysBefore * 86400000).toISOString(), end = new Date(current.getTime() + daysAhead * 86400000).toISOString();
    const [integrations, payload, carousels] = await Promise.all([
      loadIntegrations(apiUrl, headers, 2),
      getJson(`${apiUrl}/posts?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`, headers, 2),
      discoverCarouselLibrary(autoEditRoot),
    ]);
    const remotePosts = Array.isArray(payload) ? payload : Array.isArray(payload?.posts) ? payload.posts : [];
    const lookup = await buildLocalScheduleLookup(carousels); const posts = reconcilePostizSchedule(remotePosts, lookup, integrations, current);
    const scheduled = posts.filter((item) => item.status === "scheduled"); const count = (field, value) => posts.filter((item) => item[field] === value).length;
    const result = {
      checkedAt: current.toISOString(), range: { start, end, daysBefore, daysAhead }, timeZone: POSTIZ_POLICY.timeZone,
      summary: { total: posts.length, scheduled: scheduled.length, published: count("status", "published"), pastUnverified: count("status", "past-unverified"),
        reels: count("kind", "reel"), carousels: count("kind", "carousel"), other: count("kind", "other"),
        scheduledReels: scheduled.filter((item) => item.kind === "reel").length, scheduledCarousels: scheduled.filter((item) => item.kind === "carousel").length,
        scheduledOther: scheduled.filter((item) => item.kind === "other").length, tracked: posts.filter((item) => item.tracked).length,
        untracked: posts.filter((item) => !item.tracked).length, nextAt: scheduled[0]?.publishDate || null },
      integrations: integrations.map((item) => ({ id: item.id, platform: platformAlias(item.identifier), name: item.name || item.profile || POSTIZ_PLATFORMS[platformAlias(item.identifier)]?.label || item.identifier, profile: item.profile || null, picture: item.picture || null, disabled: Boolean(item.disabled) })),
      posts,
    };
    await writeJsonAtomic(join(dataDir, "active-postiz-calendar.json"), result);
    return result;
  };
  const snapshot = async (runId) => {
    const run = await resolveRun(runId); const [reels, carousels, connection, plans] = await Promise.all([buildReelLibrary(run), discoverCarouselLibrary(autoEditRoot), publicConnection(), readJson(planIndexPath, {})]);
    const approvedReels = new Map(reels.filter((item) => item.ready).map((item) => [item.id, item.approvalRevision]));
    const saved = Object.values(plans || {}).filter((plan) => validSavedPlan(plan, run.id)
      && plan.items.every((item) => item.kind !== "reel"
        || (approvedReels.has(item.id) && approvedReels.get(item.id) === item.approvalRevision)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    return { runId: run.id, batchName: run.name, outputDir: run.config.outputDir, connection, reels, carousels, savedPlan: saved,
      defaults: { startDate: tomorrowIn(POSTIZ_POLICY.timeZone), reelTimes: POSTIZ_POLICY.reelTimes, carouselTime: POSTIZ_POLICY.carouselTime, timeZone: POSTIZ_POLICY.timeZone, platforms: Object.keys(POSTIZ_PLATFORMS), tiktokLeadMinutes: POSTIZ_POLICY.tiktokLeadMinutes } };
  };
  const materializeExactCoverAssets = async (plan) => {
    for (const item of plan.items.filter((entry) => entry.kind === "reel")) {
      const sourceVideo = item.assets.sourceVideo || item.assets.youtube?.[0] || item.assets.default?.[0];
      if (!sourceVideo || !item.assets.cover) throw new Error(`Reel ${item.id} is missing its final video or reviewed cover`);
      const proof = await preparePublishMaster({ video: sourceVideo, cover: item.assets.cover });
      if (!proof?.publishVideo || proof.openingStartsAtZero !== true || Number(proof.coverSimilarity) < 0.94) {
        throw new Error(`Reel ${item.id} could not prove its reviewed cover and speech-first opening`);
      }
      // YouTube cannot accept this channel's custom thumbnail call, so it must
      // receive the same speech-first master with the reviewed cover tail.
      item.assets = { ...item.assets, sourceVideo, default: [proof.publishVideo], youtube: [proof.publishVideo],
        coverTimestampMs: proof.coverTimestampMs, exactReviewedCover: true, openingStartsAtZero: true,
        coverProof: { fingerprint: proof.fingerprint, coverSimilarity: proof.coverSimilarity, appendedSeconds: proof.appendedSeconds,
          openingFramesVerified: proof.openingFramesVerified, openingStartsAtZero: proof.openingStartsAtZero } };
    }
    plan.fingerprint = fingerprintPlan(plan);
    return plan;
  };
  const savePlan = async (runId, options) => {
    const current = await snapshot(runId); const plan = await materializeExactCoverAssets(buildPublishingPlan(current, options, now())); const plans = await readJson(planIndexPath, {});
    plans[plan.id] = plan; await writeJsonAtomic(planIndexPath, plans);
    await writeJsonAtomic(join(current.outputDir, "postiz-plan.json"), plan);
    return plan;
  };
  const verifyConnection = async () => {
    const credential = await getCredential(); if (!credential?.key) throw new Error("Connect Postiz first");
    const apiUrl = String(credential.apiUrl || DEFAULT_POSTIZ_API_URL).replace(/\/$/, ""), headers = { Authorization: credential.key };
    const integrations = await loadIntegrations(apiUrl, headers); validateIntegrations(Object.keys(POSTIZ_PLATFORMS), integrations);
    const start = now().toISOString(), end = new Date(now().getTime() + 86400000).toISOString();
    const payload = await getJson(`${apiUrl}/posts?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`, headers);
    const posts = Array.isArray(payload) ? payload : Array.isArray(payload?.posts) ? payload.posts : [];
    return { ok: true, apiUrl: credential.apiUrl || DEFAULT_POSTIZ_API_URL, visiblePosts: posts.length,
      integrations: Object.keys(POSTIZ_PLATFORMS).map((platform) => ({ platform, id: integrationIdFor(platform), connected: true })) };
  };
  const schedulePlan = async (planId, confirmation, onProgress = () => {}) => {
    if (confirmation !== "SCHEDULE") throw new Error('Live scheduling requires the exact confirmation "SCHEDULE"');
    const plans = await readJson(planIndexPath, {}), plan = plans?.[planId]; if (!plan) throw new Error(`Unknown saved Postiz plan: ${planId}`);
    if (!validSavedPlan(plan, plan.runId)) throw new Error("This Postiz preview is stale or was changed; build a fresh schedule preview first");
    const current = await snapshot(plan.runId); const readyReels = new Map(current.reels.map((item) => [item.id, item])); const readyCarousels = new Map(current.carousels.map((item) => [item.id, item]));
    for (const item of plan.items) {
      const latest = item.kind === "reel" ? readyReels.get(item.id) : readyCarousels.get(item.id);
      if (!latest?.ready) throw new Error(`${item.title} is not currently approved with a complete, QA-passing publishing package`);
      if (item.kind === "reel" && latest.approvalRevision !== item.approvalRevision) throw new Error(`${item.title} changed after this preview; approve it and build a fresh schedule preview`);
      if (item.kind === "reel" && (item.assets.exactReviewedCover !== true || item.assets.openingStartsAtZero !== true || Number(item.assets.coverProof?.coverSimilarity) < 0.94)) {
        throw new Error(`${item.title} does not have a proven exact reviewed cover; build a fresh schedule preview`);
      }
      if (item.kind === "carousel" && latest.scheduledBefore && !plan.options.allowPreviouslyScheduled) throw new Error(`${item.id} now has a prior schedule record; rebuild the preview to avoid a repeat`);
      for (const path of unique([...(item.assets.default || []), ...(item.assets.youtube || []), item.assets.cover, item.assets.youtubeThumbnail].filter(Boolean))) if (!existsSync(resolve(path))) throw new Error(`Publishing asset is missing: ${resolve(path)}`);
    }
    const credential = await getCredential(); if (!credential?.key) throw new Error("Connect Postiz before scheduling");
    const apiUrl = String(credential.apiUrl || DEFAULT_POSTIZ_API_URL).replace(/\/$/, ""); const headers = { Authorization: credential.key };
    const integrations = await loadIntegrations(apiUrl, headers); validateIntegrations(plan.options.platforms, integrations);
    const statePath = join((await resolveRun(plan.runId)).config.outputDir, "postiz-schedule-state.json");
    const state = await readJson(statePath, { schema: 4, planId, planFingerprint: plan.fingerprint, posts: {}, uploads: {}, startedAt: now().toISOString() });
    if (state.planId !== planId && Object.keys(state.posts || {}).length) throw new Error("This batch already has a different active Postiz schedule state; refusing to risk duplicates");
    if (state.planFingerprint && state.planFingerprint !== plan.fingerprint && Object.keys(state.posts || {}).length) throw new Error("Saved Postiz state does not match this preview; refusing to risk duplicates");
    state.schema = 4; state.planId = planId; state.planFingerprint = plan.fingerprint; state.posts ||= {}; state.uploads ||= {}; await writeJsonAtomic(statePath, state);
    const remaining = plan.deliveries.filter((delivery) => !state.posts[delivery.key]).length;
    const requiredLeadMs = Math.max(15 * 60000, remaining * Math.max(0, createGapMs) + 10 * 60000);
    if (Date.parse(plan.summary.firstAt) <= now().getTime() + requiredLeadMs) throw new Error(`The first slot is too close for ${remaining} paced Postiz creates; choose a start at least ${Math.ceil(requiredLeadMs / 60000)} minutes from now`);
    let remotePosts = await listRemotePosts(apiUrl, headers, plan); let lastCreate = 0, completed = 0; const total = plan.deliveries.length;
    const upload = async (path) => {
      const absolute = resolve(path); if (state.uploads[absolute]) return state.uploads[absolute]; if (!existsSync(absolute)) throw new Error(`Publishing asset is missing: ${absolute}`);
      const bytes = await readFile(absolute); let lastError;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const form = new FormData(); form.append("file", new Blob([bytes]), basename(absolute));
          const response = await fetchImpl(`${apiUrl}/upload`, { method: "POST", headers, body: form }); const payload = await jsonPayload(response);
          if (response.ok && payload?.id && payload?.path) {
            state.uploads[absolute] = { id: payload.id, path: payload.path }; state.updatedAt = now().toISOString(); await writeJsonAtomic(statePath, state); return state.uploads[absolute];
          }
          lastError = new Error(`Postiz upload failed (${response.status}): ${JSON.stringify(payload).slice(0, 180)}`);
          if (response.status !== 429 && response.status < 500) { lastError.nonRetryable = true; throw lastError; }
        } catch (error) { if (error?.nonRetryable) throw error; lastError = error; }
        if (attempt + 1 < 8) await sleep(Math.min(30000, 2000 * (attempt + 1)));
      }
      throw lastError || new Error(`Postiz upload failed: ${absolute}`);
    };
    for (const delivery of plan.deliveries) {
      if (state.posts[delivery.key]) { completed++; onProgress({ stage: "schedule", status: "skipped", completed, total, delivery }); continue; }
      const item = plan.items.find((candidate) => candidate.key === delivery.itemKey); const paths = delivery.platform === "youtube" ? item.assets.youtube : item.assets.default;
      if (!paths?.length) throw new Error(`${delivery.platform} has no compatible asset for ${item.key}`);
      const integrationId = integrationIdFor(delivery.platform); const existing = matchingRemotePost(remotePosts, delivery, integrationId);
      if (existing) {
        state.posts[delivery.key] = { postId: existing.id, scheduledAt: delivery.scheduledAt, itemKey: item.key, platform: delivery.platform, recoveredFromPostiz: true,
          cover: item.kind === "reel" ? { thumbnailTimestamp: item.assets.coverTimestampMs, payloadVerified: true, exactReviewedCover: true,
            openingStartsAtZero: true, coverSimilarity: item.assets.coverProof?.coverSimilarity, publishMaster: item.assets.default?.[0] } : null,
          completedAt: now().toISOString() };
        completed++; await writeJsonAtomic(statePath, state); onProgress({ stage: "schedule", status: "recovered", completed, total, delivery, postId: existing.id }); continue;
      }
      onProgress({ stage: "upload", status: "running", completed, total, delivery, assetCount: paths.length + (item.kind === "reel" && item.assets.cover ? 1 : 0) });
      const uploadedMedia = []; for (const path of paths) uploadedMedia.push(await upload(path));
      const cover = item.kind === "reel" && item.assets.cover ? await upload(item.assets.cover) : null;
      const media = mediaWithCover(uploadedMedia, item, cover);
      const thumbnail = delivery.platform === "youtube" && item.assets.youtubeThumbnail ? await upload(item.assets.youtubeThumbnail) : null;
      if (item.kind === "reel" && (!media[0]?.thumbnail || !Number.isFinite(media[0]?.thumbnailTimestamp))) throw new Error(`Cover metadata is missing for ${delivery.key}; refusing to create a coverless reel`);
      const body = { type: "schedule", date: delivery.scheduledAt, shortLink: false, tags: [], posts: [{ integration: { id: integrationId }, settings: postSettings(delivery.platform, item, { thumbnail }), value: [{ content: delivery.content, image: media }] }] };
      let postId = null, lastError;
      for (let attempt = 0; attempt < 12 && !postId; attempt++) {
        const gap = lastCreate + createGapMs - Date.now(); if (gap > 0) await sleep(gap); lastCreate = Date.now();
        try {
          const response = await fetchImpl(`${apiUrl}/posts`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }); const payload = await jsonPayload(response);
          postId = Array.isArray(payload) ? payload[0]?.postId : payload?.postId;
          if (response.ok && postId) break;
          lastError = new Error(`Postiz schedule failed (${response.status}): ${JSON.stringify(payload).slice(0, 180)}`);
          if (response.status !== 429 && response.status < 500) { lastError.nonRetryable = true; throw lastError; }
          if (response.status === 429) await sleep(60000);
        } catch (error) { if (error?.nonRetryable) throw error; lastError = error; }
        remotePosts = await listRemotePosts(apiUrl, headers, plan);
        postId = matchingRemotePost(remotePosts, delivery, integrationId)?.id || null;
        if (!postId && attempt + 1 < 12) await sleep(Math.min(30000, 3000 * (attempt + 1)));
      }
      if (!postId) throw lastError || new Error(`Postiz schedule failed for ${delivery.key}`);
      state.posts[delivery.key] = { postId, scheduledAt: delivery.scheduledAt, itemKey: item.key, platform: delivery.platform,
        cover: cover ? { mediaId: cover.id, path: cover.path, thumbnailTimestamp: media[0].thumbnailTimestamp, payloadVerified: true,
          exactReviewedCover: true, openingStartsAtZero: true, coverSimilarity: item.assets.coverProof?.coverSimilarity,
          publishMaster: delivery.platform === "youtube" ? item.assets.youtube?.[0] : item.assets.default?.[0] } : null,
        completedAt: now().toISOString() };
      remotePosts.push({ id: postId, publishDate: delivery.scheduledAt, content: delivery.content, integration: { id: integrationId } });
      completed++; state.updatedAt = now().toISOString(); await writeJsonAtomic(statePath, state); onProgress({ stage: "schedule", status: "completed", completed, total, delivery, postId });
    }
    onProgress({ stage: "verify", status: "running", completed, total });
    let missing = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      remotePosts = await listRemotePosts(apiUrl, headers, plan); const ids = new Set(remotePosts.map((post) => post.id));
      missing = Object.values(state.posts).map((post) => post.postId).filter((id) => !ids.has(id));
      if (!missing.length) break;
      if (attempt < 4) await sleep(2000 * (attempt + 1));
    }
    if (missing.length) throw new Error(`${missing.length} created Postiz IDs were not visible in the calendar verification; scheduling stopped for review`);
    state.completedAt = now().toISOString(); state.verification = { checkedAt: now().toISOString(), expected: total, visible: total, missing: [] }; await writeJsonAtomic(statePath, state);
    const coverPayloads = Object.values(state.posts).filter((post) => post.cover?.payloadVerified).length;
    onProgress({ stage: "verify", status: "completed", completed, total }); return { ok: true, planId, completed, total, verified: total, coverPayloads, statePath };
  };
  const repairScheduledCovers = async ({ planId = null, commit = false, confirmation = "" } = {}, onProgress = () => {}) => {
    if (commit && confirmation !== "REPAIR COVERS") throw new Error('Live cover repair requires the exact confirmation "REPAIR COVERS"');
    const plans = await readJson(planIndexPath, {}); let plan = planId ? plans?.[planId] : null;
    if (!plan) {
      const listed = await pipelineManager.call("list_talking_head_pipelines", {});
      for (const candidate of listed.pipelines || []) {
        const run = await pipelineManager.call("read_talking_head_pipeline", { runId: candidate.id, includeNodes: false });
        const candidateState = await readJson(join(run.config.outputDir, "postiz-schedule-state.json"), null);
        if (candidateState?.planId && plans?.[candidateState.planId]) { plan = plans[candidateState.planId]; planId = candidateState.planId; break; }
      }
    }
    if (!plan) throw new Error("No scheduled LocalCut Postiz plan is available for cover repair");
    const firstCoverPath = plan.items.find((item) => item.kind === "reel")?.assets?.cover || plan.items.find((item) => item.kind === "reel")?.assets?.youtubeThumbnail;
    if (!firstCoverPath) throw new Error("The selected plan has no reel cover assets");
    const statePath = join(dirname(dirname(firstCoverPath)), "postiz-schedule-state.json");
    const state = await readJson(statePath, null);
    if (!state?.posts || state.planId !== plan.id) throw new Error("The Postiz schedule state does not match the selected plan");
    const credential = await getCredential(); if (!credential?.key) throw new Error("Connect Postiz before repairing covers");
    const apiUrl = String(credential.apiUrl || DEFAULT_POSTIZ_API_URL).replace(/\/$/, ""), headers = { Authorization: credential.key };
    const repairSpec = await readJson(join(dataDir, "postiz-cover-repair-spec.json"), {});
    const integrations = await loadIntegrations(apiUrl, headers); const remotePosts = await listRemotePosts(apiUrl, headers, plan);
    const remoteById = new Map(remotePosts.map((post) => [post.id, post])); const candidates = [], skipped = [];
    for (const item of plan.items.filter((entry) => entry.kind === "reel")) {
      const coverPath = item.assets.cover || item.assets.youtubeThumbnail; const workDir = coverPath ? dirname(coverPath) : null;
      const specified = repairSpec?.plans?.[plan.id]?.[item.id]; let selectedSeconds = Number(specified?.atSeconds), durationSeconds = Number(specified?.durationSeconds);
      if (!Number.isFinite(selectedSeconds) || selectedSeconds < 0) {
        const review = workDir ? await readJson(join(workDir, "review-feedback.json"), {}) : {}, qa = workDir ? await readJson(join(workDir, "qa.json"), {}) : {};
        const reviewedSeconds = Number(review?.cover?.atSeconds), qaSeconds = Number(qa?.effects?.coverAtSeconds);
        selectedSeconds = Number.isFinite(reviewedSeconds) && reviewedSeconds >= 0 ? reviewedSeconds : Number.isFinite(qaSeconds) && qaSeconds >= 0 ? qaSeconds : 0;
        durationSeconds = Number(qa?.media?.duration);
      }
      const videoPath = item.assets.sourceVideo || item.assets.youtube?.[0] || item.assets.default?.[0]; const timestamp = coverTimestampMs(selectedSeconds, durationSeconds);
      for (const delivery of item.deliveries) {
        const key = `${item.key}:${delivery.platform}`, record = state.posts[key], remote = remoteById.get(record?.postId);
        const reason = !record ? "missing-local-record" : !remote ? "not-visible-in-postiz" : record.cover?.exactReviewedCover ? "already-exact"
          : remote.state !== "QUEUE" ? `not-queued:${remote.state || "unknown"}`
          : Date.parse(remote.publishDate || delivery.scheduledAt) <= now().getTime() + 6 * 60000 ? "slot-too-close" : null;
        if (reason) { skipped.push({ key, postId: record?.postId || null, reason }); continue; }
        if (!coverPath || !videoPath) throw new Error(`Local cover or video is missing from ${item.key}`);
        candidates.push({ key, item, delivery, oldPostId: record.postId, coverPath, videoPath, coverTimestampMs: timestamp, publishDate: remote.publishDate || delivery.scheduledAt });
      }
    }
    candidates.sort((left, right) => Date.parse(left.publishDate) - Date.parse(right.publishDate));
    const summary = { planId: plan.id, statePath, checkedAt: now().toISOString(), candidates: candidates.map(({ item, ...entry }) => ({ key: entry.key, oldPostId: entry.oldPostId, platform: entry.delivery.platform, publishDate: entry.publishDate, coverTimestampMs: entry.coverTimestampMs })), skipped };
    if (!commit) return { ok: true, dryRun: true, ...summary };
    validateIntegrations(unique(candidates.map((entry) => entry.delivery.platform)), integrations);
    state.coverRepairs ||= {}; state.updatedAt = now().toISOString(); await writeJsonAtomic(statePath, state);
    let lastCreate = 0, repaired = 0;
    const ensureUpload = async (path) => {
      const absolute = resolve(path); if (state.uploads?.[absolute]) return state.uploads[absolute];
      if (!existsSync(absolute)) throw new Error(`Publishing asset is missing: ${absolute}`);
      const form = new FormData(); form.append("file", new Blob([await readFile(absolute)]), basename(absolute));
      const response = await fetchImpl(`${apiUrl}/upload`, { method: "POST", headers, body: form }), payload = await jsonPayload(response);
      if (!response.ok || !payload?.id || !payload?.path) throw new Error(`Postiz cover repair upload failed (${response.status})`);
      state.uploads ||= {}; state.uploads[absolute] = { id: payload.id, path: payload.path }; await writeJsonAtomic(statePath, state); return state.uploads[absolute];
    };
    for (const candidate of candidates) {
      const prior = state.coverRepairs[candidate.oldPostId] || {};
      const proof = await preparePublishMaster({ video: candidate.videoPath, cover: candidate.coverPath });
      if (!proof?.publishVideo || proof.openingStartsAtZero !== true || Number(proof.coverSimilarity) < 0.94) throw new Error(`Exact cover proof failed for ${candidate.key}`);
      const cover = await ensureUpload(candidate.coverPath), video = await ensureUpload(proof.publishVideo);
      const coveredItem = { ...candidate.item, assets: { ...candidate.item.assets, sourceVideo: candidate.videoPath, default: [proof.publishVideo],
        cover: candidate.coverPath, coverTimestampMs: proof.coverTimestampMs, exactReviewedCover: true, openingStartsAtZero: true,
        coverProof: { coverSimilarity: proof.coverSimilarity, openingFramesVerified: proof.openingFramesVerified, fingerprint: proof.fingerprint } } };
      const media = mediaWithCover([video], coveredItem, cover); if (!media[0]?.thumbnail) throw new Error(`Cover metadata is missing for ${candidate.key}`);
      let newPostId = prior.newPostId || null;
      if (!newPostId) {
        onProgress({ stage: "create", status: "running", repaired, total: candidates.length, candidate });
        const gap = lastCreate + createGapMs - Date.now(); if (gap > 0) await sleep(gap); lastCreate = Date.now();
        const integrationId = integrationIdFor(candidate.delivery.platform);
        const body = { type: "schedule", date: candidate.publishDate, shortLink: false, tags: [], posts: [{ integration: { id: integrationId },
          settings: postSettings(candidate.delivery.platform, coveredItem, { thumbnail: candidate.delivery.platform === "youtube" ? cover : null }),
          value: [{ content: candidate.delivery.content, image: media }] }] };
        let response, payload, createError;
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            response = await fetchImpl(`${apiUrl}/posts`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }); payload = await jsonPayload(response);
            newPostId = Array.isArray(payload) ? payload[0]?.postId : payload?.postId;
            if (response.ok && newPostId) break;
            createError = new Error(`HTTP ${response.status}`); if (response.status !== 429 && response.status < 500) break;
          } catch (error) { createError = error; }
          await sleep(response?.status === 429 ? 60000 : Math.min(30000, 3000 * (attempt + 1)));
        }
        if (!newPostId) throw new Error(`Postiz replacement create failed for ${candidate.key} (${response?.status || createError?.message || "network"}): ${JSON.stringify(payload ?? {}).slice(0, 180)}`);
        state.coverRepairs[candidate.oldPostId] = { key: candidate.key, newPostId, createdAt: now().toISOString(), deletedOld: false,
          coverTimestampMs: proof.coverTimestampMs, exactReviewedCover: true, openingStartsAtZero: true, coverSimilarity: proof.coverSimilarity };
        await writeJsonAtomic(statePath, state);
      }
      if (!state.coverRepairs[candidate.oldPostId].deletedOld) {
        let response, deleteError;
        for (let attempt = 0; attempt < 6; attempt++) {
          try { response = await fetchImpl(`${apiUrl}/posts/${candidate.oldPostId}`, { method: "DELETE", headers }); if (response.ok || response.status === 404) break; deleteError = new Error(`HTTP ${response.status}`); }
          catch (error) { deleteError = error; }
          await sleep(Math.min(30000, 3000 * (attempt + 1)));
        }
        if (!response?.ok && response?.status !== 404) throw new Error(`Replacement ${newPostId} was created, but old Postiz post ${candidate.oldPostId} could not be deleted (${response?.status || deleteError?.message || "network"}); repair stopped to avoid compounding duplicates`);
        state.coverRepairs[candidate.oldPostId].deletedOld = true; state.coverRepairs[candidate.oldPostId].deletedAt = now().toISOString();
      }
      state.posts[candidate.key] = { ...state.posts[candidate.key], postId: newPostId, replacedPostId: candidate.oldPostId,
        cover: { mediaId: cover.id, path: cover.path, thumbnailTimestamp: proof.coverTimestampMs, payloadVerified: true,
          exactReviewedCover: true, openingStartsAtZero: true, coverSimilarity: proof.coverSimilarity, publishMaster: proof.publishVideo }, completedAt: now().toISOString() };
      repaired++; state.updatedAt = now().toISOString(); await writeJsonAtomic(statePath, state);
      onProgress({ stage: "replace", status: "completed", repaired, total: candidates.length, candidate, newPostId });
    }
    state.coverRepairCompletedAt = now().toISOString(); await writeJsonAtomic(statePath, state);
    return { ok: true, dryRun: false, ...summary, repaired, total: candidates.length };
  };
  return { snapshot, savePlan, verifyConnection, activeSchedule, schedulePlan, repairScheduledCovers, publicConnection };
}

export const publishingToolDefinitions = [
  { name: "inspect_postiz_publishing", description: "List the latest talking-head publishing packages, local carousel decks, prior schedule state, and safe Postiz connection status without publishing anything.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "inspect_postiz_calendar", description: "Pull the live Postiz calendar and reconcile scheduled reels and carousels with LocalCut and AutoEditPost state. This is read-only and never creates, changes, or deletes posts.", inputSchema: { type: "object", properties: { daysBefore: { type: "number", minimum: 0, maximum: 30 }, daysAhead: { type: "number", minimum: 1, maximum: 90 } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "build_postiz_plan", description: "Build and save an exact local Postiz schedule preview for selected reels and carousels. This never uploads or creates posts.", inputSchema: { type: "object", properties: { runId: { type: "string" }, startDate: { type: "string" }, reelTimes: { type: "array", items: { type: "string" } }, carouselTime: { type: "string" }, timeZone: { type: "string" }, platforms: { type: "array", items: { type: "string", enum: Object.keys(POSTIZ_PLATFORMS) } }, reelIds: { type: "array", items: { type: "string" } }, carouselIds: { type: "array", items: { type: "string" } }, allowPreviouslyScheduled: { type: "boolean" } }, required: ["runId", "startDate", "platforms"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "schedule_postiz_plan", description: "Upload and schedule a previously saved Postiz plan. Requires confirmation exactly equal to SCHEDULE and uses resumable duplicate protection.", inputSchema: { type: "object", properties: { planId: { type: "string" }, confirmation: { type: "string", enum: ["SCHEDULE"] } }, required: ["planId", "confirmation"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "repair_postiz_covers", description: "Audit or replace queued LocalCut Postiz reel records that were created without cover metadata. Live repair requires confirmation exactly equal to REPAIR COVERS, creates the corrected replacement first, then deletes only the old queued record.", inputSchema: { type: "object", properties: { planId: { type: "string" }, commit: { type: "boolean" }, confirmation: { type: "string", enum: ["REPAIR COVERS"] } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
];
