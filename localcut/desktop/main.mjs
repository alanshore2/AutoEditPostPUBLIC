import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell, Tray } from "electron";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPipelineManager, prepareLocalMediaBinaries } from "../src/pipeline.mjs";
import { createEditorEngine } from "../src/editor-engine.mjs";
import { checkUploadServer, loadUploadConfig, uploadFileToServer } from "../src/upload-client.mjs";
import { coverCandidateTimes, isFaceSafeCaptionY, normalizeCoverCopy, normalizeSeoPackage } from "../src/review.mjs";
import { computeReelApprovalRevision, resolveReelApproval } from "../src/approval.mjs";
import { createPublishingManager, DEFAULT_POSTIZ_API_URL, POSTIZ_PLATFORMS } from "../src/publishing.mjs";
import { createPodcastManager } from "../src/podcast.mjs";
import { ensureExactCoverPublishMaster } from "../src/publish-master.mjs";
import { createLocalCutWebHost } from "../src/web-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_MODE = process.argv.includes("--mcp");
const POSTIZ_IMPORT_MODE = process.argv.includes("--import-postiz-key");
const POSTIZ_CHECK_MODE = process.argv.includes("--check-postiz");
const POSTIZ_CALENDAR_MODE = process.argv.includes("--postiz-calendar");
const POSTIZ_REPAIR_COVERS_MODE = process.argv.includes("--repair-postiz-covers");
const WEB_MODE = process.argv.includes("--web") || !process.argv.includes("--desktop");
const AUTOEDITPOST_WEB_URL = String(process.env.LOCALCUT_WEB_PUBLIC_URL || "http://127.0.0.1").replace(/\/$/, "");
const DATA_DIR = resolve(process.env.LOCALCUT_DATA_DIR || join(homedir(), ".localcut"));
const DEFAULT_AEP = process.env.AUTOEDITPOST_ROOT || "C:\\AutoEditPost";
const POSTIZ_CONFIG_PATH = join(DATA_DIR, "postiz.json");
const STANDALONE_MODE = POSTIZ_IMPORT_MODE || POSTIZ_CHECK_MODE || POSTIZ_CALENDAR_MODE || POSTIZ_REPAIR_COVERS_MODE;
if (STANDALONE_MODE) app.setPath("userData", join(DATA_DIR, "standalone-electron"));
const PRIMARY_INSTANCE = MCP_MODE || STANDALONE_MODE || app.requestSingleInstanceLock();

async function loadStoredPostizCredential() {
  let config = {};
  try { config = JSON.parse(await readFile(POSTIZ_CONFIG_PATH, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  let key = String(process.env.POSTIZ_KEY || "").trim();
  if (!key && config.encryptedKey && safeStorage.isEncryptionAvailable()) {
    try { key = safeStorage.decryptString(Buffer.from(config.encryptedKey, "base64")).trim(); } catch { key = ""; }
  }
  return { key, apiUrl: String(process.env.POSTIZ_API_URL || config.apiUrl || DEFAULT_POSTIZ_API_URL).replace(/\/$/, ""), source: process.env.POSTIZ_KEY ? "environment" : key ? "windows-encrypted" : "missing" };
}

async function runStandalonePostizTask() {
  await app.whenReady();
  try {
    const configPath = join(DATA_DIR, "postiz.json"); let config = {};
    try { config = JSON.parse(await readFile(configPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (POSTIZ_IMPORT_MODE) {
      const key = String(await readFile(0, "utf8")).trim();
      if (!key) throw new Error("No Postiz API key was received");
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encrypted storage is unavailable");
      const next = { schema: 1, apiUrl: String(config.apiUrl || DEFAULT_POSTIZ_API_URL).replace(/\/$/, ""),
        encryptedKey: safeStorage.encryptString(key).toString("base64"), updatedAt: new Date().toISOString() };
      await mkdir(DATA_DIR, { recursive: true }); await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ ok: true, configured: true, source: "windows-encrypted", configPath })}\n`);
    } else {
      const credential = await loadStoredPostizCredential(); const { key, apiUrl } = credential;
      if (!key) throw new Error("No encrypted Postiz API key is available to LocalCut");
      if (POSTIZ_CALENDAR_MODE || POSTIZ_REPAIR_COVERS_MODE) {
        const pipelines = createPipelineManager({ dataDir: DATA_DIR });
        const publishing = createPublishingManager({ autoEditRoot: DEFAULT_AEP, dataDir: DATA_DIR, pipelineManager: pipelines, getCredential: async () => credential });
        const result = POSTIZ_REPAIR_COVERS_MODE
          ? await publishing.repairScheduledCovers({ planId: String(process.env.LOCALCUT_POSTIZ_REPAIR_PLAN_ID || "").trim() || null,
            commit: process.env.LOCALCUT_POSTIZ_REPAIR_COMMIT === "1", confirmation: String(process.env.LOCALCUT_POSTIZ_REPAIR_CONFIRMATION || "") })
          : await publishing.activeSchedule({ daysBefore: 2, daysAhead: 30 });
        const receiptPath = String(process.env[POSTIZ_REPAIR_COVERS_MODE ? "LOCALCUT_POSTIZ_REPAIR_OUTPUT" : "LOCALCUT_POSTIZ_CALENDAR_OUTPUT"] || "").trim();
        if (receiptPath) { await mkdir(dirname(receiptPath), { recursive: true }); await writeFile(receiptPath, `${JSON.stringify(result, null, 2)}\n`); }
        else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      const response = await fetch(`${apiUrl}/integrations`, { headers: { Authorization: key } });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload)) throw new Error(`Postiz integration check returned HTTP ${response.status}`);
      const connections = Object.entries(POSTIZ_PLATFORMS).map(([platform, details]) => {
        const id = process.env[details.env] || details.id; const integration = payload.find((item) => item.id === id);
        return { platform, id, provider: integration?.identifier || null, connected: Boolean(integration && !integration.disabled), disabled: Boolean(integration?.disabled) };
      });
      const output = { ok: connections.every((item) => item.connected), apiUrl, keyStoredWithWindowsEncryption: !process.env.POSTIZ_KEY && Boolean(config.encryptedKey), connections };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`); if (!output.ok) process.exitCode = 1;
    }
  } catch (error) {
    const receiptPath = POSTIZ_REPAIR_COVERS_MODE ? String(process.env.LOCALCUT_POSTIZ_REPAIR_OUTPUT || "").trim()
      : POSTIZ_CALENDAR_MODE ? String(process.env.LOCALCUT_POSTIZ_CALENDAR_OUTPUT || "").trim() : "";
    if (receiptPath) {
      try { await mkdir(dirname(receiptPath), { recursive: true }); await writeFile(receiptPath, `${JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), error: error.message || String(error) }, null, 2)}\n`); } catch { /* stderr remains the fallback */ }
    }
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`); process.exitCode = 1;
  } finally { const code = process.exitCode || 0; app.exit(code); process.exit(code); }
}

if (!PRIMARY_INSTANCE) {
  app.exit(0);
} else if (STANDALONE_MODE) {
  await runStandalonePostizTask();
} else if (MCP_MODE) {
  await app.whenReady();
  const credential = await loadStoredPostizCredential();
  if (!process.env.POSTIZ_KEY && credential.key) process.env.POSTIZ_KEY = credential.key;
  if (!process.env.POSTIZ_API_URL && credential.apiUrl) process.env.POSTIZ_API_URL = credential.apiUrl;
  process.env.LOCALCUT_DATA_DIR = DATA_DIR;
  await import("../src/server.mjs");
  app.exit(0);
} else {
  const pipelines = createPipelineManager({ dataDir: DATA_DIR });
  const editor = createEditorEngine({ dataDir: DATA_DIR });
  let mainWindow;
  let webTray;
  let webHost;
  const webHandlers = new Map();
  function browserLaunchUrl(hosted = webHost) {
    try { return new URL(AUTOEDITPOST_WEB_URL).href; }
    catch { return hosted?.launchUrl; }
  }
  app.on("second-instance", (_event, argv) => {
    if (WEB_MODE || argv.includes("--web")) {
      if (webHost?.launchUrl) shell.openExternal(browserLaunchUrl());
      return;
    }
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  const defaults = {
    autoEditRoot: DEFAULT_AEP,
    inputPath: join(DEFAULT_AEP, "Raw", "726_53192.MP4"),
    manifestPath: join(DEFAULT_AEP, "out", "yaps", "yap_cutlists.json"),
    outputDir: join(DEFAULT_AEP, "out", "yaps"),
  };

  const loadPostizCredential = loadStoredPostizCredential;

  async function savePostizCredential(request = {}) {
    let current = {};
    try { current = JSON.parse(await readFile(POSTIZ_CONFIG_PATH, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const apiUrl = String(request.apiUrl || current.apiUrl || DEFAULT_POSTIZ_API_URL).trim().replace(/\/$/, "");
    let parsed; try { parsed = new URL(apiUrl); } catch { throw new Error("Postiz API URL is not valid"); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Postiz API URL must use HTTP or HTTPS");
    const next = { schema: 1, apiUrl, encryptedKey: current.encryptedKey || null, updatedAt: new Date().toISOString() };
    if (request.clearKey === true) next.encryptedKey = null;
    else if (String(request.key || "").trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encrypted storage is unavailable; set POSTIZ_KEY in the environment instead");
      next.encryptedKey = safeStorage.encryptString(String(request.key).trim()).toString("base64");
    }
    await mkdir(DATA_DIR, { recursive: true }); await writeFile(POSTIZ_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
    const credential = await loadPostizCredential();
    return { configured: Boolean(credential.key), apiUrl: credential.apiUrl, source: credential.source, configPath: POSTIZ_CONFIG_PATH };
  }

  const publishing = createPublishingManager({ autoEditRoot: DEFAULT_AEP, dataDir: DATA_DIR, pipelineManager: pipelines, getCredential: loadPostizCredential });
  const podcast = createPodcastManager({ dataDir: DATA_DIR });

  function publicPodcast(receipt) {
    if (!receipt) return null;
    return { ...receipt,
      source: { ...receipt.source, url: pathToFileURL(receipt.source.inputPath).href },
      fileUrls: Object.fromEntries(Object.entries(receipt.files || {}).filter(([, path]) => Boolean(path)).map(([name, path]) => [name, pathToFileURL(path).href])) };
  }

  function publicPublishingSnapshot(snapshot) {
    return {
      ...snapshot,
      reels: snapshot.reels.map((item) => ({ ...item, coverUrl: item.coverReady ? pathToFileURL(item.cover).href : null })),
      carousels: snapshot.carousels.map((item) => ({ ...item, previewUrl: pathToFileURL(item.preview).href, slideUrls: item.slides.map((path) => pathToFileURL(path).href) })),
    };
  }

  function parseDotEnv(text) {
    const parsed = {};
    for (const line of String(text || "").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[1].startsWith("#")) continue;
      let content = match[2];
      if ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'"))) content = content.slice(1, -1);
      parsed[match[1]] = content;
    }
    return parsed;
  }

  async function discoverTalkingHeadBatch() {
    const rawDir = join(DEFAULT_AEP, "Raw");
    const entries = await readdir(rawDir, { withFileTypes: true });
    const media = [], specs = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(rawDir, entry.name); const info = await stat(path);
      if (/\.(mp4|mov|m4v|mkv|webm)$/i.test(entry.name)) media.push({ path, name: entry.name, mtimeMs: info.mtimeMs, bytes: info.size });
      if (/\.batch\.json$/i.test(entry.name)) specs.push({ path, name: entry.name, mtimeMs: info.mtimeMs });
    }
    media.sort((a, b) => b.mtimeMs - a.mtimeMs); specs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (!media.length) throw new Error(`No video found in ${rawDir}`);
    if (!specs.length) throw new Error(`No executable talking-head spec found in ${rawDir}. Add a *.batch.json spec derived from the teleprompter/edit sheet.`);
    const source = media[0], spec = specs[0];
    const slug = basename(source.name, "." + source.name.split(".").pop()).replace(/[^a-z0-9_-]+/gi, "_");
    const outputDir = join(DEFAULT_AEP, "out", "talking-heads", slug);
    return { autoEditRoot: DEFAULT_AEP, inputPath: source.path, inputName: source.name, inputBytes: source.bytes,
      specPath: spec.path, specName: spec.name, manifestPath: join(outputDir, "manifest.json"), outputDir,
      documents: entries.filter((entry) => entry.isFile() && /\.(pdf|md|txt)$/i.test(entry.name)).map((entry) => join(rawDir, entry.name)) };
  }

  async function runPreparation(event, batch) {
    let projectEnv = {};
    try { projectEnv = parseDotEnv(await readFile(join(DEFAULT_AEP, ".env"), "utf8")); } catch { /* surfaced by child if required */ }
    Object.assign(process.env, projectEnv);
    let fresh = false;
    try {
      const [manifestInfo, sourceInfo, specInfo] = await Promise.all([stat(batch.manifestPath), stat(batch.inputPath), stat(batch.specPath)]);
      fresh = manifestInfo.size > 100 && manifestInfo.mtimeMs >= Math.max(sourceInfo.mtimeMs, specInfo.mtimeMs);
    } catch { /* prepare */ }
    if (fresh) {
      event.sender.send("batch:progress", { stage: "match", status: "cached", manifestPath: batch.manifestPath });
      return;
    }
    const script = join(DEFAULT_AEP, "scripts", "prepare_talking_head_manifest.mjs");
    if (!existsSync(script)) throw new Error(`Talking-head analyzer is missing: ${script}`);
    await new Promise((resolveRun, reject) => {
      const env = { ...process.env, ...projectEnv, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
      const child = spawn(process.execPath, [script, "--input", batch.inputPath, "--spec", batch.specPath, "--out", batch.manifestPath], {
        cwd: DEFAULT_AEP, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const lines = stdout.split(/\r?\n/); stdout = lines.pop() || "";
        for (const line of lines) { try { event.sender.send("batch:progress", JSON.parse(line)); } catch { /* non-JSON diagnostic */ } }
      });
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error(`Talking-head analysis exited ${code}: ${stderr.slice(-3000)}`)));
    });
  }

  function mcpConfig() {
    const command = process.execPath;
    const serverPath = app.isPackaged
      ? join(process.resourcesPath, "app.asar", "src", "server.mjs")
      : join(app.getAppPath(), "src", "server.mjs");
    return {
      mcpServers: {
        localcut: {
          command,
          args: [serverPath],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            LOCALCUT_DATA_DIR: DATA_DIR,
            AUTOEDITPOST_ROOT: defaults.autoEditRoot,
          },
        },
      },
    };
  }

  async function enrichRun(run) {
    let manifest = [], batchSpec = null;
    try { manifest = JSON.parse(await readFile(run.config.manifestPath, "utf8")); } catch { /* job may still be preparing */ }
    const entryByReel = new Map((Array.isArray(manifest) ? manifest : []).map((entry) => [String(entry.id ?? entry.reel).padStart(2, "0"), entry]));
    const specPath = manifest[0]?.specPath || null;
    if (specPath) { try { batchSpec = JSON.parse(await readFile(specPath, "utf8")); } catch { /* optional display metadata */ } }
    const documentPaths = [];
    for (const document of batchSpec?.sourceDocuments || []) {
      const path = resolve(dirname(specPath), document);
      if (existsSync(path)) documentPaths.push(path);
    }
    const documents = [];
    for (const path of documentPaths) {
      const info = await stat(path);
      const name = basename(path); const upper = name.toUpperCase();
      const role = /EDIT/.test(upper) ? "Edit instructions" : /TALKING|TELEPROMPT/.test(upper) ? "Teleprompter" : "Source document";
      documents.push({ role, name, path, bytes: info.size });
    }
    if (specPath && existsSync(specPath)) documents.push({ role: "Execution spec", name: basename(specPath), path: specPath, bytes: (await stat(specPath)).size });
    if (run.config.manifestPath && existsSync(run.config.manifestPath)) documents.push({ role: "Cut manifest", name: basename(run.config.manifestPath), path: run.config.manifestPath, bytes: (await stat(run.config.manifestPath)).size });
    let source = { path: run.config.inputPath, name: basename(run.config.inputPath), bytes: 0 };
    try { source = { ...source, bytes: (await stat(run.config.inputPath)).size, url: pathToFileURL(run.config.inputPath).href }; } catch { /* preflight reports missing source */ }
    const artifacts = [];
    for (const artifact of run.artifacts || []) {
      let qa = null, review = null;
      try { qa = JSON.parse(await readFile(artifact.qa, "utf8")); } catch { /* incomplete job */ }
      const entry = entryByReel.get(String(artifact.reel).padStart(2, "0")) || {};
      const workDir = dirname(artifact.video);
      const caption = join(workDir, "cap.ass");
      const cover = join(workDir, `${artifact.label}_cover.jpg`);
      const seoPath = join(workDir, "seo-keywords.json");
      const reviewPath = join(workDir, "review-feedback.json");
      try { review = JSON.parse(await readFile(reviewPath, "utf8")); } catch { /* no review feedback yet */ }
      let videoInfo = null, coverInfo = null;
      try { videoInfo = await stat(artifact.video); } catch { /* incomplete job */ }
      try { coverInfo = await stat(cover); } catch { /* incomplete job */ }
      const approvalRevision = await computeReelApprovalRevision({ video: artifact.video, cover, captions: caption, seo: seoPath, qa: artifact.qa });
      const approval = resolveReelApproval(review, approvalRevision);
      artifacts.push({
        ...artifact,
        exists: Boolean(videoInfo),
        videoUrl: videoInfo ? `${pathToFileURL(artifact.video).href}?v=${videoInfo.mtimeMs}` : null,
        filename: basename(artifact.video),
        workDir, caption, captionExists: existsSync(caption), cover, coverExists: existsSync(cover), seoPath, seoExists: existsSync(seoPath),
        coverUrl: coverInfo ? `${pathToFileURL(cover).href}?v=${coverInfo.mtimeMs}` : null,
        brief: { title: entry.title || qa?.title || artifact.label, targetSeconds: entry.targetSeconds || null, segments: entry.segments || [],
          overlay: entry.overlay || qa?.effects?.faceFirstOverlay || null, postCaption: entry.postCaption || qa?.postCaption || null,
          keyword: entry.keyword || (qa?.effects?.keyword ? { word: qa.effects.keyword, pinnedComment: qa?.pinnedComment || null } : null),
          coverFrame: entry.coverFrame || null, captionCenterY: Number(review?.captions?.centerY ?? qa?.effects?.captionCenterY ?? entry.captions?.centerY ?? 1450),
          coverCopy: normalizeCoverCopy(review?.cover, entry.title || qa?.title || artifact.label, artifact.reel),
          seo: normalizeSeoPackage(review?.seo, entry.seo || qa?.seo),
          watchFor: entry.watchFor || null, confidence: entry.confidence ?? qa?.sourceMatchConfidence ?? null },
        reviewPath, review, approvalRevision, approval, qaPath: artifact.qa, qa,
      });
    }
    return { ...run, batch: { name: batchSpec?.name || run.name, source, documents, specPath, manifestPath: run.config.manifestPath, outputDir: run.config.outputDir }, artifacts };
  }

  function enrichProject(project) {
    if (!project?.assets) return project;
    return {
      ...project,
      assets: Object.fromEntries(Object.entries(project.assets).map(([id, asset]) => [id, {
        ...asset,
        url: existsSync(asset.path) ? pathToFileURL(asset.path).href : null,
        exists: existsSync(asset.path),
      }])),
    };
  }

  async function callEditor(name, args = {}) {
    const result = await editor.call(name, args);
    if (result?.assets) return enrichProject(result);
    if (result?.project?.assets) return { ...result, project: enrichProject(result.project) };
    return result;
  }

  async function publicUploadConfig() {
    const config = await loadUploadConfig({ dataDir: DATA_DIR });
    let host = null;
    try { host = config.url ? new URL(config.url).host : null; } catch { /* invalid URL fails during upload */ }
    return { enabled: config.enabled, url: config.url || null, host, configPath: config.configPath };
  }

  const cleanFeedback = (value) => String(value || "").trim().slice(0, 2000);
  async function saveReviewFeedback(run, reelCandidate, section, details) {
    const reel = String(reelCandidate).padStart(2, "0");
    const artifact = run.artifacts.find((item) => String(item.reel).padStart(2, "0") === reel);
    if (!artifact) throw new Error(`Pipeline ${run.id} has no reel ${reel}`);
    const current = artifact.review && typeof artifact.review === "object" ? artifact.review : {};
    const updatedAt = new Date().toISOString();
    const next = { ...current, [section]: { ...(current[section] || {}), ...details, updatedAt }, updatedAt };
    if (section !== "approval" && current.approval?.status === "approved") {
      next.approval = { ...current.approval, status: "pending", invalidatedAt: updatedAt, invalidatedBy: section, updatedAt };
    }
    await writeFile(artifact.reviewPath, `${JSON.stringify(next, null, 2)}\n`);
    artifact.review = next;
    return { artifact, review: next };
  }
  async function runBinary(command, args, cwd) {
    await new Promise((resolveRun, reject) => {
      const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error(`Media command exited ${code}: ${stderr.slice(-2000)}`)));
    });
  }

  async function runBinaryCapture(command, args, cwd) {
    return new Promise((resolveRun, reject) => {
      const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => stdout += chunk.toString());
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolveRun(stdout) : reject(new Error(`Media command exited ${code}: ${stderr.slice(-2000)}`)));
    });
  }

  async function attachSeoMetadata(artifact, seo, title, postCaption) {
    const { ffmpeg, ffprobe } = await prepareLocalMediaBinaries();
    const temporary = join(artifact.workDir, `.seo-metadata-${Date.now()}.mp4`);
    const description = `${String(postCaption || title || "").trim()}. ${seo.primaryPhrase}. ${seo.related.slice(0, 3).join(", ")}.`.replace(/\s+/g, " ").slice(0, 500);
    try {
      await runBinary(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-i", artifact.video, "-map", "0", "-c", "copy",
        "-metadata", `title=${title || artifact.label}`, "-metadata", `description=${description}`, "-metadata", `keywords=${seo.metadataKeywords}`,
        "-metadata", `comment=SEO: ${seo.metadataKeywords}`, "-movflags", "+faststart+use_metadata_tags", temporary], artifact.workDir);
      const probe = JSON.parse(await runBinaryCapture(ffprobe, ["-v", "error", "-show_format", "-of", "json", temporary], artifact.workDir));
      const embedded = Object.entries(probe.format?.tags || {}).find(([key]) => key.toLowerCase() === "keywords")?.[1] || "";
      if (embedded.trim().toLowerCase() !== seo.metadataKeywords.trim().toLowerCase()) throw new Error("MP4 keyword metadata verification failed");
      await copyFile(temporary, artifact.video);
      await writeFile(artifact.seoPath, `${JSON.stringify({ schema: 1, reel: String(artifact.reel).padStart(2, "0"), title, ...seo, postiz: { hashtags: seo.hashtags.join(" ") } }, null, 2)}\n`);
      if (artifact.qaPath && existsSync(artifact.qaPath)) {
        const qa = artifact.qa && typeof artifact.qa === "object" ? artifact.qa : JSON.parse(await readFile(artifact.qaPath, "utf8"));
        qa.seo = seo; qa.seoPath = artifact.seoPath; qa.media ||= {}; qa.media.metadataKeywords = embedded; qa.checkedAt = new Date().toISOString();
        await writeFile(artifact.qaPath, `${JSON.stringify(qa, null, 2)}\n`);
      }
      const info = await stat(artifact.video);
      return { videoUrl: `${pathToFileURL(artifact.video).href}?v=${info.mtimeMs}`, bytes: info.size, metadataKeywords: embedded };
    } finally {
      try { await unlink(temporary); } catch { /* already removed or never created */ }
    }
  }

  function plannedCoverTime(artifact) {
    const duration = Number(artifact.qa?.media?.duration || 0);
    const guide = String(artifact.brief?.coverFrame || "").toLowerCase();
    if (guide.includes("first second")) return Math.min(0.8, duration * 0.1);
    if (guide.includes("first six") || guide.includes("early")) return Math.min(4, duration * 0.15);
    if (guide.includes("middle")) return duration * 0.5;
    if (guide.includes("final")) return Math.max(0.1, duration - 0.2);
    if (guide.includes("last five")) return Math.max(0.1, duration - 2.5);
    return duration * 0.78;
  }

  async function renderReviewCover(run, artifact, atSeconds, coverCopy) {
    const duration = Number(artifact.qa?.media?.duration || 0);
    const at = Math.max(0, Math.min(Math.max(0, duration - 0.05), Number(atSeconds) || 0));
    const autoEditRoot = resolve(run.config.autoEditRoot || DEFAULT_AEP);
    const script = join(autoEditRoot, "scripts", "make_cover.py");
    if (!existsSync(script)) throw new Error(`AutoEditPost cover renderer is missing: ${script}`);
    const { ffmpeg } = await prepareLocalMediaBinaries();
    const baseFrame = join(artifact.workDir, ".cover-frame.jpg");
    // The review player shows artifact.video. Extracting the same timestamp from
    // base_fast.mp4 can select a different facial expression after edit timing changes.
    await runBinary(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-ss", at.toFixed(3), "-i", artifact.video, "-frames:v", "1", "-q:v", "2", baseFrame], artifact.workDir);
    const python = process.env.AEP_COVER_PYTHON || process.env.AEP_QA_PYTHON || (process.platform === "win32" ? "python" : "python3");
    await runBinary(python, [script, baseFrame, artifact.cover, coverCopy.kicker, coverCopy.accent, coverCopy.headline], autoEditRoot);
    const info = await stat(artifact.cover);
    if (info.size < 10 * 1024) throw new Error(`Cover renderer produced an unexpectedly small image for reel ${artifact.reel}`);
    return { at, info };
  }

  async function renderReviewCoverCandidates(artifact, requestedAt = null) {
    const duration = Number(artifact.qa?.media?.duration || 0);
    const selectedAt = Number.isFinite(Number(requestedAt))
      ? Number(requestedAt)
      : Number.isFinite(Number(artifact.review?.cover?.atSeconds))
      ? Number(artifact.review.cover.atSeconds)
      : plannedCoverTime(artifact);
    const source = artifact.video;
    const sourceInfo = await stat(source);
    const candidateDir = join(artifact.workDir, ".cover-candidates");
    await mkdir(candidateDir, { recursive: true });
    const { ffmpeg } = await prepareLocalMediaBinaries();
    const times = coverCandidateTimes(duration, selectedAt);
    const candidates = [];
    for (let offset = 0; offset < times.length; offset += 4) {
      const group = await Promise.all(times.slice(offset, offset + 4).map(async (at, groupIndex) => {
        const index = offset + groupIndex;
        const path = join(candidateDir, `frame-${String(Math.round(at * 1000)).padStart(7, "0")}.jpg`);
        let info = null;
        try { info = await stat(path); } catch { /* generate below */ }
        if (!info || info.size < 8 * 1024 || info.mtimeMs < sourceInfo.mtimeMs) {
          await runBinary(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-ss", at.toFixed(3), "-i", source, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "3", path], artifact.workDir);
          info = await stat(path);
        }
        const current = Math.abs(at - selectedAt) < 0.12;
        const nearEnd = duration - at <= 1.1;
        return {
          atSeconds: at,
          current,
          label: current ? "Current choice" : nearEnd ? `End choice ${Math.max(1, Math.round((duration - at) * 10))}` : `Frame ${index + 1}`,
          url: `${pathToFileURL(path).href}?v=${info.mtimeMs}`,
        };
      }));
      candidates.push(...group);
    }
    return { selectedAt, candidates };
  }

  function registerHandler(channel, handler) {
    webHandlers.set(channel, handler);
    ipcMain.handle(channel, handler);
  }

  function registerIpc() {
    registerHandler("system:bootstrap", async () => ({
      appName: app.getName(), version: app.getVersion(), packaged: app.isPackaged,
      dataDir: DATA_DIR, defaults: await discoverTalkingHeadBatch().catch(() => defaults), mcpConfig: mcpConfig(), upload: await publicUploadConfig(),
    }));
    registerHandler("dialog:file", async (_event, options = {}) => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: options.title || "Choose a file",
        defaultPath: options.defaultPath,
        properties: ["openFile"], filters: options.filters || [],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    registerHandler("dialog:directory", async (_event, options = {}) => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: options.title || "Choose a folder", defaultPath: options.defaultPath,
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    registerHandler("dialog:save", async (_event, options = {}) => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: options.title || "Export video", defaultPath: options.defaultPath,
        filters: options.filters || [{ name: "MP4 video", extensions: ["mp4"] }],
      });
      return result.canceled ? null : result.filePath;
    });
    registerHandler("editor:call", (_event, name, args) => callEditor(name, args));
    registerHandler("upload:health", async () => {
      const config = await loadUploadConfig({ dataDir: DATA_DIR });
      if (!config.enabled) return { ok: false, configured: false };
      return { ...(await checkUploadServer(config.url)), configured: true };
    });
    registerHandler("upload:file", async (event, filePath) => {
      const config = await loadUploadConfig({ dataDir: DATA_DIR });
      if (!config.enabled) throw new Error(`Upload server is not configured. Create ${config.configPath}`);
      return uploadFileToServer({
        filePath, url: config.url, token: config.token,
        onProgress: (progress) => event.sender.send("upload:progress", progress),
      });
    });
    registerHandler("pipeline:list", () => pipelines.call("list_talking_head_pipelines", {}));
    registerHandler("pipeline:read", async (_event, id) => enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: id })));
    registerHandler("pipeline:create", (_event, config) => pipelines.call("create_talking_head_pipeline", config));
    registerHandler("pipeline:start", (_event, id, force = false) => pipelines.call("run_talking_head_pipeline", { runId: id, force }));
    registerHandler("pipeline:retry", (_event, id) => pipelines.call("retry_talking_head_pipeline", { runId: id }));
    registerHandler("pipeline:cancel", (_event, id) => pipelines.call("cancel_talking_head_pipeline", { runId: id }));
    registerHandler("pipeline:rerun-reel", (_event, id, reel, fromStage = "cut") => pipelines.call("rerun_talking_head_reel", { runId: id, reel, fromStage, force: true }));
    registerHandler("pipeline:rebuild", (_event, id) => pipelines.call("rebuild_talking_head_pipeline", { runId: id, force: true }));
    registerHandler("review:save-seo", async (_event, id, reel, requestedSeo = {}) => {
      const run = await enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: id }));
      const artifact = run.artifacts.find((item) => String(item.reel).padStart(2, "0") === String(reel).padStart(2, "0"));
      if (!artifact?.exists) throw new Error(`Reel ${reel} is not rendered yet`);
      const seo = normalizeSeoPackage(requestedSeo, artifact.brief?.seo || artifact.qa?.seo);
      if (!seo.primaryPhrase || seo.related.length < 2 || seo.hashtags.length < 3) throw new Error("SEO package needs one primary phrase, at least two related terms, and at least three hashtags");
      const saved = await saveReviewFeedback(run, reel, "seo", seo);
      const attached = await attachSeoMetadata(artifact, seo, artifact.brief?.title || artifact.label, artifact.brief?.postCaption || artifact.qa?.postCaption);
      return { reel: String(reel).padStart(2, "0"), seo, seoPath: artifact.seoPath, review: saved.review, ...attached };
    });
    registerHandler("review:set-approval", async (_event, id, reel, approved = true) => {
      const run = await enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: id }));
      const artifact = run.artifacts.find((item) => String(item.reel).padStart(2, "0") === String(reel).padStart(2, "0"));
      if (!artifact) throw new Error(`Reel ${reel} does not exist`);
      if (approved && (!artifact.exists || !artifact.coverExists || !artifact.captionExists || !artifact.seoExists || !artifact.qa?.ok || !artifact.approvalRevision)) {
        throw new Error(`Reel ${String(reel).padStart(2, "0")} needs passing QA, final video, cover, captions, and SEO before approval`);
      }
      const approvedAt = approved ? new Date().toISOString() : null;
      const saved = await saveReviewFeedback(run, reel, "approval", approved
        ? { status: "approved", revision: artifact.approvalRevision, approvedAt, invalidatedAt: null, invalidatedBy: null }
        : { status: "pending", revision: null, approvedAt: null, invalidatedAt: new Date().toISOString(), invalidatedBy: "user" });
      return { reel: String(reel).padStart(2, "0"), review: saved.review,
        approval: resolveReelApproval(saved.review, artifact.approvalRevision) };
    });
    registerHandler("review:cover-candidates", async (_event, id, reel, atSeconds = null) => {
      const run = await enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: id }));
      const artifact = run.artifacts.find((item) => String(item.reel).padStart(2, "0") === String(reel).padStart(2, "0"));
      if (!artifact?.exists) throw new Error(`Reel ${reel} is not rendered yet`);
      return { reel: String(reel).padStart(2, "0"), ...(await renderReviewCoverCandidates(artifact, atSeconds)) };
    });
    registerHandler("review:regenerate-cover", async (_event, id, reel, atSeconds, feedback = "", requestedCopy = {}) => {
      const run = await enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: id }));
      const artifact = run.artifacts.find((item) => String(item.reel).padStart(2, "0") === String(reel).padStart(2, "0"));
      if (!artifact?.exists) throw new Error(`Reel ${reel} is not rendered yet`);
      const coverCopy = normalizeCoverCopy(requestedCopy, artifact.brief?.title || artifact.label, artifact.reel);
      const { at, info } = await renderReviewCover(run, artifact, atSeconds, coverCopy);
      const publish = await ensureExactCoverPublishMaster({ video: artifact.video, cover: artifact.cover });
      const publishProof = { publishVideo: publish.publishVideo, coverTimestampMs: publish.coverTimestampMs,
        coverSimilarity: publish.coverSimilarity, openingStartsAtZero: publish.openingStartsAtZero,
        openingFramesVerified: publish.openingFramesVerified, fingerprint: publish.fingerprint };
      const saved = await saveReviewFeedback(run, reel, "cover", { atSeconds: at, feedback: cleanFeedback(feedback), ...coverCopy, publishProof });
      return { reel: String(reel).padStart(2, "0"), cover: artifact.cover, coverUrl: `${pathToFileURL(artifact.cover).href}?v=${info.mtimeMs}`,
        publishProof, review: saved.review };
    });
    registerHandler("review:regenerate-all-covers", async (_event, id) => {
      const run = await enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: id }));
      const artifacts = run.artifacts.filter((artifact) => artifact.exists);
      for (let offset = 0; offset < artifacts.length; offset += 3) {
        await Promise.all(artifacts.slice(offset, offset + 3).map(async (artifact) => {
          const previous = artifact.review?.cover || {};
          const coverCopy = normalizeCoverCopy(previous, artifact.brief?.title || artifact.label, artifact.reel);
          const atSeconds = Number.isFinite(Number(previous.atSeconds)) ? Number(previous.atSeconds) : plannedCoverTime(artifact);
          const { at } = await renderReviewCover(run, artifact, atSeconds, coverCopy);
          const publish = await ensureExactCoverPublishMaster({ video: artifact.video, cover: artifact.cover });
          const publishProof = { publishVideo: publish.publishVideo, coverTimestampMs: publish.coverTimestampMs,
            coverSimilarity: publish.coverSimilarity, openingStartsAtZero: publish.openingStartsAtZero,
            openingFramesVerified: publish.openingFramesVerified, fingerprint: publish.fingerprint };
          await saveReviewFeedback(run, artifact.reel, "cover", { atSeconds: at, feedback: cleanFeedback(previous.feedback), ...coverCopy, publishProof });
        }));
      }
      return { regenerated: artifacts.length };
    });
    registerHandler("review:redo-captions", async (_event, id, reel, centerY, feedback = "") => {
      const run = await enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: id }));
      const y = Math.max(360, Math.min(1500, Math.round(Number(centerY) || 1450)));
      await saveReviewFeedback(run, reel, "captions", { centerY: y, feedback: cleanFeedback(feedback), faceSafe: isFaceSafeCaptionY(y) });
      return pipelines.call("rerun_talking_head_reel", { runId: id, reel, fromStage: "captions", force: true });
    });
    registerHandler("review:redo-all-captions", async (_event, id, centerY = 1450, feedback = "") => {
      const run = await enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: id }));
      const y = Math.max(360, Math.min(1500, Math.round(Number(centerY) || 1450)));
      for (const artifact of run.artifacts) await saveReviewFeedback(run, artifact.reel, "captions", { centerY: y, feedback: cleanFeedback(feedback), faceSafe: true });
      return pipelines.call("rerun_talking_head_batch_from_stage", { runId: id, fromStage: "captions", force: true });
    });
    registerHandler("review:set-framing", async (_event, id, reel, zoom, feedback = "") => {
      const run = await enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: id }));
      const z = Math.max(1, Math.min(1.6, Number(zoom) || 1));
      await saveReviewFeedback(run, reel, "framing", { zoom: z, feedback: cleanFeedback(feedback) });
      return pipelines.call("rerun_talking_head_reel", { runId: id, reel, fromStage: "cut", force: true });
    });
    registerHandler("pipeline:prepare-and-start", async (event) => {
      const batch = await discoverTalkingHeadBatch();
      event.sender.send("batch:progress", { stage: "discover", status: "completed", inputName: batch.inputName, specName: batch.specName });
      await runPreparation(event, batch);
      let selected = null;
      const listed = await pipelines.call("list_talking_head_pipelines", {});
      for (const candidate of listed.pipelines || []) {
        const current = await pipelines.call("read_talking_head_pipeline", { runId: candidate.id, includeNodes: false });
        if (current.config?.inputPath?.toLowerCase() === batch.inputPath.toLowerCase() && current.config?.manifestPath?.toLowerCase() === batch.manifestPath.toLowerCase()) { selected = current; break; }
      }
      if (!selected) {
        const created = await pipelines.call("create_talking_head_pipeline", { name: `Talking Heads — ${batch.inputName}`, inputPath: batch.inputPath,
          manifestPath: batch.manifestPath, outputDir: batch.outputDir, autoEditRoot: batch.autoEditRoot, concurrency: 3, retryLimit: 1 });
        selected = await pipelines.call("read_talking_head_pipeline", { runId: created.id });
      }
      if (selected.summary.status !== "completed") await pipelines.call("run_talking_head_pipeline", { runId: selected.id, force: false });
      return enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: selected.id }));
    });
    registerHandler("pipeline:sync-artifacts", async (_event, id) => {
      const run = await enrichRun(await pipelines.call("read_talking_head_pipeline", { runId: id }));
      const imported = [];
      for (const artifact of run.artifacts.filter((item) => item.exists && item.qa?.ok)) {
        imported.push(await callEditor("import_asset", { filePath: artifact.video, name: artifact.qa?.title || artifact.filename, kind: "talking-head" }));
      }
      return { imported: imported.length, project: await callEditor("read_project", {}) };
    });
    registerHandler("publishing:snapshot", async (_event, id) => publicPublishingSnapshot(await publishing.snapshot(id)));
    registerHandler("publishing:save-config", async (_event, config = {}) => savePostizCredential(config));
    registerHandler("publishing:test", async () => publishing.verifyConnection());
    registerHandler("publishing:active-schedule", async (_event, options = {}) => publishing.activeSchedule(options));
    registerHandler("publishing:build-plan", async (_event, id, options = {}) => publishing.savePlan(id, options));
    registerHandler("publishing:schedule-plan", async (event, planId, confirmation) => publishing.schedulePlan(planId, confirmation, (progress) => event.sender.send("publishing:progress", progress)));
    registerHandler("podcast:inspect", async (_event, inputPath) => { const source = await podcast.probe(inputPath); return { ...source, url: pathToFileURL(source.inputPath).href, outputRoot: podcast.outputRoot }; });
    registerHandler("podcast:process", async (event, inputPath, options = {}) => publicPodcast(await podcast.process(inputPath, options, (progress) => event.sender.send("podcast:progress", progress))));
    registerHandler("podcast:history", async () => (await podcast.history()).map(publicPodcast));
    registerHandler("podcast:cancel", () => podcast.cancel());
    registerHandler("shell:reveal", (_event, path) => shell.showItemInFolder(resolve(path)));
    registerHandler("shell:open", async (_event, path) => shell.openPath(resolve(path)));
    registerHandler("clipboard:write", (_event, text) => { clipboard.writeText(String(text)); return true; });
  }

  async function startWebControlRoom() {
    if (webHost) return webHost;
    webHost = await createLocalCutWebHost({
      rendererDir: join(HERE, "renderer"), assetsDir: join(HERE, "assets"), dataDir: DATA_DIR,
      rawDir: join(DEFAULT_AEP, "Raw"), allowedRoots: [DEFAULT_AEP], handlers: webHandlers,
    });
    return webHost;
  }

  async function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1480, height: 940, minWidth: 1080, minHeight: 720,
      backgroundColor: "#0b0d12", show: false,
      icon: join(HERE, "assets", "icon.png"),
      titleBarStyle: "hidden", titleBarOverlay: { color: "#0b0d12", symbolColor: "#d9deea", height: 42 },
      webPreferences: {
        preload: join(HERE, "preload.cjs"), contextIsolation: true,
        nodeIntegration: false, sandbox: true,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    if (!process.env.LOCALCUT_CAPTURE_PATH) {
      mainWindow.once("ready-to-show", () => mainWindow.show());
    }
    const captureView = process.env.LOCALCUT_CAPTURE_VIEW || (/automation/i.test(process.env.LOCALCUT_CAPTURE_PATH || "") ? "automation" : "");
    await mainWindow.loadFile(join(HERE, "renderer", "index.html"), captureView ? { query: { captureView } } : undefined);
    if (process.env.LOCALCUT_CAPTURE_PATH) {
      const captureDelay = Math.max(500, Math.min(30000, Number(process.env.LOCALCUT_CAPTURE_DELAY_MS) || 5500));
      await new Promise((done) => setTimeout(done, captureDelay));
      const capture = await mainWindow.webContents.capturePage();
      await writeFile(resolve(process.env.LOCALCUT_CAPTURE_PATH), capture.toPNG());
      app.quit();
    }
  }

  function createWebTray(hosted) {
    if (webTray) return webTray;
    webTray = new Tray(join(HERE, "assets", "icon.png"));
    webTray.setToolTip("LocalCut Web Control Room");
    webTray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open LocalCut on AutoEditPost", click: () => shell.openExternal(browserLaunchUrl(hosted)) },
      { type: "separator" },
      { label: "Stop LocalCut Web", click: () => app.quit() },
    ]));
    webTray.on("double-click", () => shell.openExternal(browserLaunchUrl(hosted)));
    return webTray;
  }

  app.setName("LocalCut");
  app.whenReady().then(async () => {
    registerIpc();
    const hosted = await startWebControlRoom();
    if (WEB_MODE) {
      createWebTray(hosted);
      if (process.env.LOCALCUT_WEB_NO_OPEN !== "1") await shell.openExternal(browserLaunchUrl(hosted));
    } else await createWindow();
    app.on("activate", () => { if (!WEB_MODE && BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on("window-all-closed", () => { if (!WEB_MODE && process.platform !== "darwin") app.quit(); });
}
