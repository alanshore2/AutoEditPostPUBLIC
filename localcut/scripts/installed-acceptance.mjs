import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(name);

const installedExe = resolve(value("--installed-exe", join(process.env.LOCALAPPDATA || "", "Programs", "LocalCut", "LocalCut.exe")));
const autoEditRoot = resolve(value("--autoedit-root", join(process.cwd(), "..", "..", "AutoEditPost")));
const proofRoot = resolve(value("--proof-root", join(autoEditRoot, "out", `localcut-proof-${Date.now()}`)));
const fullPipeline = flag("--full-pipeline");
const sourceVideo = resolve(value("--source-video", join(autoEditRoot, "Raw", "726_53192.MP4")));
const manifestPath = join(autoEditRoot, "out", "yaps", "yap_cutlists.json");
const installedServer = join(dirname(installedExe), "resources", "app.asar", "src", "server.mjs");
const installedArchive = join(dirname(installedExe), "resources", "app.asar");
const dataDir = resolve(value("--data-dir", join(process.env.LOCALAPPDATA || dirname(proofRoot), "LocalCutAcceptance", basename(proofRoot))));
const uploadConfig = resolve(value("--upload-config", process.env.LOCALCUT_UPLOAD_CONFIG || join(process.env.USERPROFILE || "", ".localcut", "upload.json")));
const editorExport = join(proofRoot, "editor-export.mp4");
const reelOutput = join(proofRoot, "reels");
const frameDir = join(proofRoot, "caption-frames");
const ffmpeg = join(process.env.LOCALAPPDATA || "", "LocalCut", "bin", "ffmpeg.exe");
const ffprobe = join(process.env.LOCALAPPDATA || "", "LocalCut", "bin", "ffprobe.exe");

// A regular Node process cannot stat a virtual path inside app.asar. The
// installed Electron runtime resolves installedServer when it starts.
for (const required of [installedExe, installedArchive, sourceVideo, manifestPath, uploadConfig]) {
  assert.ok(existsSync(required), `Required acceptance input is missing: ${required}`);
}
await mkdir(proofRoot, { recursive: true });
await mkdir(frameDir, { recursive: true });

function parseDotEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    let content = match[2];
    if ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'"))) content = content.slice(1, -1);
    result[match[1]] = content;
  }
  return result;
}

let projectEnv = {};
try { projectEnv = parseDotEnv(await readFile(join(autoEditRoot, ".env"), "utf8")); } catch { /* optional */ }
const childEnv = {
  ...process.env,
  ...projectEnv,
  ELECTRON_RUN_AS_NODE: "1",
  LOCALCUT_DATA_DIR: dataDir,
  AUTOEDITPOST_ROOT: autoEditRoot,
  LOCALCUT_UPLOAD_CONFIG: uploadConfig,
  TIGHTEN_MODE: process.env.TIGHTEN_MODE || "copy",
};

const startedAt = new Date();
const report = {
  schema: 1,
  startedAt: startedAt.toISOString(),
  finishedAt: null,
  installedExe,
  installedServer,
  autoEditRoot,
  proofRoot,
  dataDir,
  fullPipeline,
  server: null,
  advertisedTools: [],
  exercisedTools: [],
  checks: [],
  progress: [],
  source: null,
  editorExport: null,
  upload: null,
  pipeline: null,
  artifacts: [],
};
const exercised = new Set();

function log(message) {
  process.stdout.write(`[acceptance] ${new Date().toISOString()} ${message}\n`);
}

async function check(name, operation, summarize = () => ({})) {
  const began = Date.now();
  try {
    const result = await operation();
    report.checks.push({ name, status: "passed", durationMs: Date.now() - began, ...summarize(result) });
    log(`PASS ${name}`);
    return result;
  } catch (error) {
    report.checks.push({ name, status: "failed", durationMs: Date.now() - began, error: error.message || String(error) });
    log(`FAIL ${name}: ${error.message || error}`);
    throw error;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || autoEditRoot,
      env: options.env || childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolveRun({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stderr.slice(-3000)}`)));
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function probe(path) {
  const result = await run(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path]);
  const data = JSON.parse(result.stdout);
  const video = data.streams.find((stream) => stream.codec_type === "video");
  const audio = data.streams.find((stream) => stream.codec_type === "audio");
  return {
    path,
    bytes: Number(data.format?.size || (await stat(path)).size),
    duration: Number(data.format?.duration || video?.duration || 0),
    width: video?.width || 0,
    height: video?.height || 0,
    fps: video?.avg_frame_rate || null,
    videoCodec: video?.codec_name || null,
    pixelFormat: video?.pix_fmt || null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name || null,
    sampleRate: Number(audio?.sample_rate || 0),
    channels: audio?.channels || 0,
  };
}

const mcp = spawn(installedExe, [installedServer], {
  cwd: proofRoot,
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const pending = new Map();
let requestId = 0;
let mcpStderr = "";
mcp.stderr.on("data", (chunk) => mcpStderr += chunk);
mcp.on("error", (error) => {
  for (const item of pending.values()) item.reject(error);
  pending.clear();
});
mcp.on("close", (code) => {
  if (pending.size) {
    const error = new Error(`Installed MCP server exited ${code}: ${mcpStderr.slice(-2000)}`);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }
});
const lines = createInterface({ input: mcp.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const item = pending.get(message.id);
  if (!item) return;
  clearTimeout(item.timer);
  pending.delete(message.id);
  if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
  else item.resolve(message.result);
});

function rpc(method, params = {}, timeoutMs = 120_000) {
  const id = ++requestId;
  return new Promise((resolveRpc, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve: resolveRpc, reject, timer });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function tool(name, args = {}, timeoutMs = 120_000) {
  exercised.add(name);
  const result = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text || "null");
}

let primaryProject;
let duplicateProject;
let seededProject;
let fullRun;
try {
  const initialized = await check("installed MCP initializes", () => rpc("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "localcut-installed-acceptance", version: "1" },
  }), (result) => ({ serverVersion: result.serverInfo?.version }));
  report.server = initialized.serverInfo;
  assert.equal(initialized.serverInfo?.version, "0.8.6");
  await check("installed MCP responds to ping", () => rpc("ping"));

  const listed = await check("installed MCP advertises tools", () => rpc("tools/list"), (result) => ({ count: result.tools.length }));
  report.advertisedTools = listed.tools.map((item) => item.name).sort();
  assert.equal(report.advertisedTools.length, 30, "Installed MCP must expose exactly 30 tools");

  primaryProject = await check("create_project", () => tool("create_project", { name: "Installed acceptance", width: 1080, height: 1920, fps: 30 }));
  await check("list_projects", async () => {
    const result = await tool("list_projects");
    assert.ok(result.projects.some((item) => item.id === primaryProject.id));
    return result;
  });
  await check("target_project", () => tool("target_project", { projectId: primaryProject.id.slice(0, 20) }));
  await check("get_active_project", async () => {
    const result = await tool("get_active_project");
    assert.equal(result.projectId, primaryProject.id);
    return result;
  });
  await check("read_project", async () => {
    const result = await tool("read_project");
    assert.equal(result.id, primaryProject.id);
    return result;
  });
  await check("update_project", async () => {
    const result = await tool("update_project", { name: "Installed acceptance updated", settings: { snapping: false } });
    assert.equal(result.name, "Installed acceptance updated");
    assert.equal(result.settings.snapping, false);
    return result;
  });

  const reelOne = join(autoEditRoot, "out", "yaps", "y_001", "y_001_FINAL.mp4");
  const reelTwo = join(autoEditRoot, "out", "yaps", "y_002", "y_002_FINAL.mp4");
  const firstAsset = await check("import_asset", () => tool("import_asset", { filePath: reelOne, name: "Acceptance reel", kind: "proof" }), (result) => ({ duration: result.duration }));
  await check("edit_item validate only", async () => {
    const result = await tool("edit_item", { adds: [{ assetId: firstAsset.id, track: "V1", from: 0, duration: 4, sourceStart: 1 }], validateOnly: true });
    assert.equal(result.committed, false);
    return result;
  });
  const edited = await check("edit_item commit", () => tool("edit_item", { adds: [{ assetId: firstAsset.id, track: "V1", from: 0, duration: 4, sourceStart: 1 }] }));
  assert.equal(edited.items.length, 1);
  await check("split_item", async () => {
    const result = await tool("split_item", { id: edited.items[0].id, at: [2] });
    assert.equal(result.newIds.length, 2);
    return result;
  });
  await check("undo_project", async () => {
    const result = await tool("undo_project");
    assert.equal(result.changed, true);
    return result;
  });
  await check("redo_project", async () => {
    const result = await tool("redo_project");
    assert.equal(result.changed, true);
    return result;
  });
  const version = await check("save_project_version", () => tool("save_project_version", { name: "Acceptance checkpoint" }));
  await check("list_project_versions", async () => {
    const result = await tool("list_project_versions");
    assert.ok(result.versions.some((item) => item.id === version.id));
    return result;
  });
  await tool("update_project", { name: "Temporary acceptance name" });
  await check("restore_project_version", async () => {
    const result = await tool("restore_project_version", { versionId: version.id.slice(0, 20) });
    assert.equal(result.name, "Installed acceptance updated");
    return result;
  });
  await check("read_transcript", async () => {
    const result = await tool("read_transcript", { assetId: firstAsset.id.slice(0, 20) });
    assert.ok(result.source?.endsWith("cap.ass"));
    assert.ok(result.lines.length > 0);
    return result;
  }, (result) => ({ lines: result.lines.length }));
  await check("local_export", async () => {
    const result = await tool("local_export", { outputPath: editorExport }, 10 * 60_000);
    assert.ok(existsSync(result.outputPath));
    return result;
  });
  report.editorExport = await check("editor export media validates", async () => {
    const media = await probe(editorExport);
    assert.equal(media.videoCodec, "h264");
    assert.equal(media.audioCodec, "aac");
    assert.ok(media.duration > 3 && media.duration < 7);
    await run(ffmpeg, ["-v", "error", "-i", editorExport, "-f", "null", "-"]);
    media.sha256 = await sha256(editorExport);
    return media;
  }, (media) => ({ duration: media.duration, bytes: media.bytes }));

  report.upload = await check("upload_media_to_server verifies remote bytes and hash", async () => {
    const receipt = await tool("upload_media_to_server", { filePath: editorExport }, 10 * 60_000);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.bytes, report.editorExport.bytes);
    assert.equal(receipt.sha256, report.editorExport.sha256);
    return receipt;
  }, (receipt) => ({ host: receipt.host, bytes: receipt.bytes, sha256: receipt.sha256, storedName: receipt.storedName }));

  duplicateProject = await check("duplicate_project", async () => {
    const result = await tool("duplicate_project", { name: "Acceptance duplicate" });
    assert.notEqual(result.id, primaryProject.id);
    return result;
  });
  await tool("target_project", { projectId: primaryProject.id });
  const removableAsset = await tool("import_asset", { filePath: reelTwo, name: "Disposable acceptance asset" });
  await check("remove_asset", async () => {
    const result = await tool("remove_asset", { assetId: removableAsset.id.slice(0, 20) });
    assert.equal(result.removed, removableAsset.id);
    return result;
  });
  seededProject = await check("seed_autoeditpost_project", async () => {
    const result = await tool("seed_autoeditpost_project", { autoEditRoot, sourceVideo });
    assert.ok(Object.keys(result.assets).length >= 13);
    assert.ok(Object.keys(result.items).length >= 1);
    return result;
  }, (result) => ({ assets: Object.keys(result.assets).length, items: Object.keys(result.items).length }));
  await tool("target_project", { projectId: primaryProject.id });
  await check("delete_project duplicate", () => tool("delete_project", { projectId: duplicateProject.id }));
  await check("delete_project seeded project", () => tool("delete_project", { projectId: seededProject.id }));

  const cancelled = await tool("create_talking_head_pipeline", {
    name: "Cancellation contract proof", inputPath: sourceVideo, manifestPath,
    outputDir: join(proofRoot, "cancelled-run"), autoEditRoot, concurrency: 1, retryLimit: 0,
  });
  await check("run_talking_head_pipeline cancellation graph", () => tool("run_talking_head_pipeline", { runId: cancelled.id, force: false }));
  await check("cancel_talking_head_pipeline", async () => {
    const result = await tool("cancel_talking_head_pipeline", { runId: cancelled.id });
    assert.equal(result.cancelled, true);
    for (let attempt = 0; attempt < 40; attempt++) {
      const settled = await tool("read_talking_head_pipeline", { runId: cancelled.id, includeNodes: false });
      if (settled.summary.status === "cancelled") return settled;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error("Pipeline acknowledged cancellation but did not settle as cancelled");
  });

  if (fullPipeline) {
    fullRun = await check("create_talking_head_pipeline", () => tool("create_talking_head_pipeline", {
      name: "Installed full 17-minute acceptance", inputPath: sourceVideo, manifestPath,
      outputDir: reelOutput, autoEditRoot, concurrency: 3, retryLimit: 1,
    }));
    assert.equal(fullRun.reels, 12);
    await check("run_talking_head_pipeline", () => tool("run_talking_head_pipeline", { runId: fullRun.id, force: false }));
    let lastProgress = -1;
    const deadline = Date.now() + 90 * 60_000;
    while (Date.now() < deadline) {
      const status = await tool("read_talking_head_pipeline", { runId: fullRun.id, includeNodes: false });
      if (status.summary.progress !== lastProgress) {
        lastProgress = status.summary.progress;
        report.progress.push({ at: new Date().toISOString(), ...status.summary });
        log(`PIPELINE ${status.summary.status} ${status.summary.completed}/${status.summary.nodes} (${Math.round(status.summary.progress * 100)}%)`);
      }
      if (["completed", "failed", "cancelled"].includes(status.summary.status)) {
        assert.equal(status.summary.status, "completed", `Full pipeline ended ${status.summary.status}`);
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
    }
    const completed = await tool("read_talking_head_pipeline", { runId: fullRun.id, includeNodes: true });
    assert.equal(completed.summary.status, "completed");
    assert.equal(completed.summary.nodes, 86);
    assert.equal(completed.summary.completed, 86);
    assert.ok(completed.nodes.every((node) => ["completed", "skipped"].includes(node.status)));
    report.pipeline = { id: fullRun.id, name: completed.name, summary: completed.summary, nodeAttempts: completed.nodes.map((node) => ({ id: node.id, attempts: node.attempts, status: node.status })) };

    await check("retry_talking_head_pipeline completed graph", async () => {
      const result = await tool("retry_talking_head_pipeline", { runId: fullRun.id });
      assert.equal(result.started, true);
      for (let attempt = 0; attempt < 20; attempt++) {
        const status = await tool("read_talking_head_pipeline", { runId: fullRun.id, includeNodes: false });
        if (status.summary.status === "completed") return status;
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      throw new Error("Completed graph did not settle after retry");
    });
    await check("list_talking_head_pipelines", async () => {
      const result = await tool("list_talking_head_pipelines");
      assert.ok(result.pipelines.some((item) => item.id === fullRun.id));
      return result;
    });

    report.source = await check("17-minute source validates", async () => {
      const media = await probe(sourceVideo);
      assert.ok(media.duration > 900 && media.duration < 1200, `Unexpected source duration ${media.duration}`);
      assert.ok(media.hasAudio && media.width > 0 && media.height > 0);
      media.sha256 = await sha256(sourceVideo);
      return media;
    }, (media) => ({ duration: media.duration, bytes: media.bytes }));

    for (let index = 1; index <= 12; index++) {
      const label = `y_${String(index).padStart(3, "0")}`;
      const dir = join(reelOutput, label);
      const videoPath = join(dir, `${label}_FINAL.mp4`);
      const captionPath = join(dir, "cap.ass");
      const qaPath = join(dir, "qa.json");
      const artifact = await check(`${label} complete media validation`, async () => {
        assert.ok(existsSync(videoPath), `${label} final video is missing`);
        assert.ok(existsSync(captionPath), `${label} caption source is missing`);
        assert.ok(existsSync(qaPath), `${label} QA report is missing`);
        const media = await probe(videoPath);
        assert.equal(media.width, 1080);
        assert.equal(media.height, 1920);
        assert.equal(media.videoCodec, "h264");
        assert.equal(media.audioCodec, "aac");
        assert.ok(media.duration >= 8 && media.duration <= 75);
        assert.ok(media.bytes >= 512 * 1024);
        const qa = JSON.parse(await readFile(qaPath, "utf8"));
        assert.equal(qa.ok, true, `${label} QA failed: ${(qa.errors || []).join(", ")}`);
        assert.ok(Number.isFinite(qa.media?.openingSilenceSeconds), `${label} QA is missing opening-silence measurement`);
        assert.ok(qa.media.openingSilenceSeconds <= (qa.media.maxOpeningSilenceSeconds ?? 0.15),
          `${label} opens with ${qa.media.openingSilenceSeconds}s of silence`);
        assert.ok(Number.isFinite(qa.effects?.captionMaxCharsPerLine), `${label} QA is missing the caption safe-box limit`);
        const ass = await readFile(captionPath, "utf8");
        const dialogue = ass.split(/\r?\n/).filter((line) => line.startsWith("Dialogue:"));
        assert.ok(dialogue.length > 0, `${label} has no caption events`);
        const overwide = [];
        for (const line of dialogue) {
          const match = line.match(/^Dialogue:\s*\d+,[^,]+,[^,]+,Cap,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/);
          if (!match) continue;
          for (const row of match[1].split("\\N")) {
            const visible = row.replace(/\{[^}]*\}/g, "").trim();
            if (visible.length > qa.effects.captionMaxCharsPerLine) overwide.push(visible);
          }
        }
        assert.deepEqual([...new Set(overwide)], [], `${label} has caption rows outside the safe box`);
        await run(ffmpeg, ["-v", "error", "-i", videoPath, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"]);
        const first = dialogue[0].split(",");
        const parseTime = (text) => {
          const match = text.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
          return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 1;
        };
        const frameAt = Math.max(0.1, (parseTime(first[1]) + parseTime(first[2])) / 2);
        const framePath = join(frameDir, `${label}.jpg`);
        await run(ffmpeg, ["-y", "-v", "error", "-ss", frameAt.toFixed(3), "-i", videoPath, "-frames:v", "1", "-vf", "scale=270:480", framePath]);
        return { ...media, qa, captionEvents: dialogue.length, framePath, sha256: await sha256(videoPath) };
      }, (item) => ({ duration: item.duration, bytes: item.bytes, captionEvents: item.captionEvents }));
      report.artifacts.push(artifact);
    }

    const contactInputs = report.artifacts.flatMap((item) => ["-i", item.framePath]);
    const filters = report.artifacts.map((_, index) => `[${index}:v]scale=270:480[s${index}]`);
    const layout = report.artifacts.map((_, index) => `${(index % 4) * 270}_${Math.floor(index / 4) * 480}`).join("|");
    const stacks = `${report.artifacts.map((_, index) => `[s${index}]`).join("")}xstack=inputs=12:layout=${layout}:fill=black[out]`;
    const contactSheet = join(proofRoot, "caption-contact-sheet.png");
    await check("caption contact sheet renders", () => run(ffmpeg, ["-y", "-v", "error", ...contactInputs, "-filter_complex", `${filters.join(";")};${stacks}`, "-map", "[out]", "-frames:v", "1", contactSheet]));
    report.captionContactSheet = contactSheet;
  } else {
    await check("list_talking_head_pipelines", () => tool("list_talking_head_pipelines"));
    await check("read_talking_head_pipeline cancelled graph", () => tool("read_talking_head_pipeline", { runId: cancelled.id }));
    await check("retry_talking_head_pipeline cancelled graph", () => tool("retry_talking_head_pipeline", { runId: cancelled.id }));
    await check("cancel retried graph", () => tool("cancel_talking_head_pipeline", { runId: cancelled.id }));
  }

  await check("inspect_postiz_publishing is local and exposes carousels", async () => {
    const result = await tool("inspect_postiz_publishing", { runId: (fullRun || cancelled).id });
    assert.equal(result.carousels.length, 50); assert.equal(result.carousels.reduce((sum, item) => sum + item.slideCount, 0), 300);
    return { carouselDecks: result.carousels.length, slides: result.carousels.reduce((sum, item) => sum + item.slideCount, 0) };
  });
  await check("build_postiz_plan refuses an empty incomplete selection", async () => {
    await assert.rejects(tool("build_postiz_plan", { runId: cancelled.id, startDate: "2026-08-12", platforms: ["instagram"], reelIds: [], carouselIds: [] }), /Select at least one ready reel or carousel/);
    return { gated: true };
  });
  await check("schedule_postiz_plan requires the exact live confirmation", async () => {
    await assert.rejects(tool("schedule_postiz_plan", { planId: "missing-plan", confirmation: "NO" }), /exact confirmation/);
    return { gated: true };
  });

  report.exercisedTools = [...exercised].sort();
  assert.deepEqual(report.exercisedTools, report.advertisedTools, `Tool coverage mismatch. Missing: ${report.advertisedTools.filter((name) => !exercised.has(name)).join(", ")}`);
  await check("all advertised MCP tools exercised", async () => ({ count: exercised.size }), (result) => result);
} finally {
  report.exercisedTools = [...exercised].sort();
  report.finishedAt = new Date().toISOString();
  report.elapsedSeconds = Number(((new Date(report.finishedAt) - startedAt) / 1000).toFixed(3));
  report.passed = report.checks.length > 0 && report.checks.every((item) => item.status === "passed");
  await writeFile(join(proofRoot, "acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const summary = [
    "# LocalCut installed acceptance proof",
    "",
    `- Result: **${report.passed ? "PASS" : "FAIL"}**`,
    `- Installed server: ${report.server?.name || "unknown"} ${report.server?.version || "unknown"}`,
    `- Elapsed: ${report.elapsedSeconds}s`,
    `- Checks passed: ${report.checks.filter((item) => item.status === "passed").length}/${report.checks.length}`,
    `- MCP tools exercised: ${report.exercisedTools.length}/${report.advertisedTools.length}`,
    `- Server upload: ${report.upload?.verified ? `verified ${report.upload.bytes} bytes (${report.upload.sha256})` : "not verified"}`,
    `- Full graph: ${report.pipeline ? `${report.pipeline.summary.completed}/${report.pipeline.summary.nodes} nodes` : "not requested"}`,
    `- Validated reels: ${report.artifacts.length}`,
    "",
    "The JSON report in this folder contains the per-check timings, source and output hashes, media stream data, graph node attempts, QA results, and artifact paths.",
    "",
  ].join("\n");
  await writeFile(join(proofRoot, "PROOF.md"), summary);
  mcp.stdin.end();
  if (!mcp.killed) setTimeout(() => mcp.kill(), 1000).unref();
}

log(`COMPLETE ${report.passed ? "PASS" : "FAIL"} report=${join(proofRoot, "acceptance-report.json")}`);
