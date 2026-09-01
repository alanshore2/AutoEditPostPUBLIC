import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const STAGES = ["cut", "clean", "tighten", "speed", "captions", "render", "qa"];
const TERMINAL_OK = new Set(["completed", "skipped"]);
const DEFAULT_AEP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "AutoEditPost");
const RUNTIME_BIN_DIR = resolve(process.env.LOCALCUT_RUNTIME_DIR || join(process.env.LOCALAPPDATA || homedir(), "LocalCut", "bin"));

const stringProp = (description) => ({ type: "string", description });
const intProp = (description, minimum = 0, maximum) => ({ type: "integer", description, minimum, ...(maximum ? { maximum } : {}) });
const boolProp = (description) => ({ type: "boolean", description });

export const pipelineToolDefinitions = [
  {
    name: "create_talking_head_pipeline",
    description: "Create a durable local graph that turns one long recording and a segment manifest into multiple edited talking-head videos.",
    inputSchema: {
      type: "object",
      properties: {
        name: stringProp("Job name"), inputPath: stringProp("Source video path"), manifestPath: stringProp("JSON cut-list manifest path"),
        outputDir: stringProp("Output directory"), autoEditRoot: stringProp("AutoEditPost project root; normally auto-detected"),
        concurrency: intProp("Maximum reel stages to run at once", 1, 8), retryLimit: intProp("Retries after the first failed attempt", 0, 5),
      },
      required: ["name", "inputPath", "manifestPath", "outputDir"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "run_talking_head_pipeline",
    description: "Start or resume a talking-head graph in the background. Fresh artifacts are reused.",
    inputSchema: { type: "object", properties: { runId: stringProp("Pipeline id or unique prefix"), force: boolProp("Rebuild even fresh media artifacts") }, required: ["runId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "read_talking_head_pipeline",
    description: "Read pipeline status, graph nodes, QA warnings, and final artifact paths.",
    inputSchema: { type: "object", properties: { runId: stringProp("Pipeline id or unique prefix"), includeNodes: boolProp("Include every graph node; defaults true") }, required: ["runId"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_talking_head_pipelines",
    description: "List local talking-head jobs and compact progress summaries.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "retry_talking_head_pipeline",
    description: "Reset failed graph nodes and downstream dependants, then resume the job.",
    inputSchema: { type: "object", properties: { runId: stringProp("Pipeline id or unique prefix") }, required: ["runId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "cancel_talking_head_pipeline",
    description: "Cancel a running local job and stop its active stage processes. Completed artifacts remain resumable.",
    inputSchema: { type: "object", properties: { runId: stringProp("Pipeline id or unique prefix") }, required: ["runId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function reelId(entry) {
  const raw = entry.id ?? entry.reel;
  if (raw === undefined || raw === null || raw === "") throw new Error("Every manifest entry needs id or reel");
  return String(raw).padStart(2, "0");
}

export function buildPipelineGraph(entries) {
  const nodes = [{ id: "preflight", kind: "preflight", deps: [], status: "pending", attempts: 0 }];
  for (const entry of entries) {
    const reel = reelId(entry);
    let dep = "preflight";
    for (const stage of STAGES) {
      const id = `${reel}:${stage}`;
      nodes.push({ id, kind: "stage", reel, stage, deps: [dep], status: "pending", attempts: 0 });
      dep = id;
    }
  }
  nodes.push({ id: "finalize", kind: "finalize", deps: entries.map((entry) => `${reelId(entry)}:qa`), status: "pending", attempts: 0 });
  return nodes;
}

function summary(run) {
  const counts = {};
  for (const node of run.nodes) counts[node.status] = (counts[node.status] || 0) + 1;
  const completed = (counts.completed || 0) + (counts.skipped || 0);
  return { status: run.status, nodes: run.nodes.length, completed, counts, progress: run.nodes.length ? Number((completed / run.nodes.length).toFixed(3)) : 0 };
}

export function resetReelNodes(run, reelCandidate, fromStage = "cut") {
  const reel = String(reelCandidate).padStart(2, "0");
  if (!run.reels.includes(reel)) throw new Error(`Pipeline ${run.id} has no reel ${reel}`);
  const stageIndex = STAGES.indexOf(fromStage);
  if (stageIndex < 0) throw new Error(`Unknown talking-head stage: ${fromStage}`);
  const reset = [];
  for (const node of run.nodes) {
    const shouldReset = (node.reel === reel && STAGES.indexOf(node.stage) >= stageIndex) || node.kind === "finalize";
    if (!shouldReset) continue;
    node.status = "pending";
    node.attempts = 0;
    delete node.error;
    delete node.result;
    delete node.startedAt;
    delete node.finishedAt;
    reset.push(node.id);
  }
  run.cancelRequested = false;
  run.status = "ready";
  return reset;
}

export function resetBatchNodes(run, fromStage = "cut") {
  const stageIndex = STAGES.indexOf(fromStage);
  if (stageIndex < 0) throw new Error(`Unknown talking-head stage: ${fromStage}`);
  const reset = [];
  for (const node of run.nodes) {
    const shouldReset = node.kind === "finalize" || (node.reel && STAGES.indexOf(node.stage) >= stageIndex);
    if (!shouldReset) continue;
    node.status = "pending";
    node.attempts = 0;
    delete node.error;
    delete node.result;
    delete node.startedAt;
    delete node.finishedAt;
    reset.push(node.id);
  }
  run.cancelRequested = false;
  run.status = "ready";
  return reset;
}

function packagedBinaryPaths() {
  let ffmpeg, ffprobe;
  try { ffmpeg = require("ffmpeg-static"); } catch { /* preflight reports it */ }
  try { ffprobe = require("ffprobe-static").path; } catch { /* preflight reports it */ }
  return { ffmpeg, ffprobe };
}

function binaryPaths() {
  const extension = process.platform === "win32" ? ".exe" : "";
  return {
    ffmpeg: process.env.FFMPEG_PATH || (existsSync(join(RUNTIME_BIN_DIR, `ffmpeg${extension}`)) ? join(RUNTIME_BIN_DIR, `ffmpeg${extension}`) : "ffmpeg"),
    ffprobe: process.env.FFPROBE_PATH || (existsSync(join(RUNTIME_BIN_DIR, `ffprobe${extension}`)) ? join(RUNTIME_BIN_DIR, `ffprobe${extension}`) : "ffprobe"),
  };
}

export async function prepareLocalMediaBinaries() {
  if (process.env.FFMPEG_PATH && process.env.FFPROBE_PATH) return binaryPaths();
  const packaged = packagedBinaryPaths();
  if (!packaged.ffmpeg || !packaged.ffprobe) throw new Error("Bundled FFmpeg packages are missing; run npm install in LocalCut");
  const extension = process.platform === "win32" ? ".exe" : "";
  await mkdir(RUNTIME_BIN_DIR, { recursive: true });
  for (const [name, source] of Object.entries(packaged)) {
    if (process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"]) continue;
    const destination = join(RUNTIME_BIN_DIR, `${name}${extension}`);
    const sourceStat = await stat(source);
    const currentSize = existsSync(destination) ? (await stat(destination)).size : -1;
    if (currentSize !== sourceStat.size) await copyFile(source, destination);
    if (process.platform !== "win32") await chmod(destination, 0o755);
  }
  return binaryPaths();
}

function resolveByPrefix(values, candidate) {
  if (values.includes(candidate)) return candidate;
  const matches = values.filter((value) => value.startsWith(candidate));
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous pipeline id: ${candidate}` : `Unknown pipeline id: ${candidate}`);
  return matches[0];
}

function nodeRuntimeEnv(env = process.env) {
  return process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
}

function parseProjectEnv(text) {
  const parsed = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    parsed[match[1]] = value;
  }
  return parsed;
}

function commandOk(command, args, env = process.env) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => error += chunk);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveCommand() : reject(new Error(`${command} exited ${code}: ${error.slice(-1000)}`)));
  });
}

export function createPipelineManager({ dataDir }) {
  const root = join(dataDir, "pipelines");
  const active = new Map();
  // Cancellation must mutate the same run object used by the scheduler.
  // Loading a second copy here allows a concurrent node checkpoint to write
  // cancelRequested=false over the cancellation acknowledgement.
  const activeRuns = new Map();
  const children = new Map();
  let writeQueue = Promise.resolve();

  async function ensureRoot() { await mkdir(root, { recursive: true }); }
  const fileFor = (id) => join(root, `${id}.json`);
  function save(run) {
    const operation = async () => {
      await ensureRoot();
      run.updatedAt = new Date().toISOString();
      // Concurrent reel nodes checkpoint in parallel, so serialize writes.
      // Windows can reject rename-over-existing while a fast status poll has
      // just opened the destination; a serialized local write avoids that
      // platform race while still keeping every state transition ordered.
      await writeFile(fileFor(run.id), JSON.stringify(run, null, 2) + "\n");
    };
    writeQueue = writeQueue.then(operation, operation);
    return writeQueue;
  }
  async function ids() {
    await ensureRoot();
    return (await readdir(root)).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
  }
  async function load(candidate) {
    const id = resolveByPrefix(await ids(), candidate);
    let lastError;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { return JSON.parse(await readFile(fileFor(id), "utf8")); }
      catch (error) {
        lastError = error;
        // A status poll can land in the few milliseconds of a serialized
        // Windows write. Retry the transient partial read; persistent corrupt
        // state still surfaces after the bounded loop.
        if (!(error instanceof SyntaxError)) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    throw lastError;
  }

  async function create(args) {
    const inputPath = resolve(args.inputPath);
    const manifestPath = resolve(args.manifestPath);
    const outputDir = resolve(args.outputDir);
    const autoEditRoot = resolve(args.autoEditRoot || process.env.AUTOEDITPOST_ROOT || DEFAULT_AEP_ROOT);
    if (!existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);
    if (!existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);
    const entries = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!Array.isArray(entries) || !entries.length) throw new Error("Manifest must be a non-empty JSON array");
    const seen = new Set();
    for (const entry of entries) {
      const id = reelId(entry);
      if (seen.has(id)) throw new Error(`Duplicate manifest id: ${id}`);
      seen.add(id);
      if (!Array.isArray(entry.segments) || !entry.segments.length) throw new Error(`Manifest ${id} has no segments`);
    }
    const id = `pipeline_${randomUUID()}`;
    const now = new Date().toISOString();
    const run = {
      version: 1, id, name: args.name, status: "ready", createdAt: now, updatedAt: now, cancelRequested: false,
      config: { inputPath, manifestPath, outputDir, autoEditRoot, concurrency: args.concurrency || 2, retryLimit: args.retryLimit ?? 2, force: false },
      reels: entries.map((entry) => reelId(entry)),
      labels: Object.fromEntries(entries.map((entry) => { const reel = reelId(entry); return [reel, entry.outputName || `y_0${reel}`]; })),
      nodes: buildPipelineGraph(entries),
    };
    await mkdir(outputDir, { recursive: true });
    await save(run);
    return { id, name: run.name, reels: run.reels.length, summary: summary(run) };
  }

  async function preflight(run) {
    const { ffmpeg, ffprobe } = await prepareLocalMediaBinaries();
    const required = [
      run.config.inputPath, run.config.manifestPath,
      join(run.config.autoEditRoot, "dist", "cli.js"),
      join(run.config.autoEditRoot, "scripts", "talking_head_stage.mjs"),
      join(run.config.autoEditRoot, "scripts", "verify_talking_head_batch.mjs"),
    ];
    for (const path of required) if (!existsSync(path)) throw new Error(`Preflight missing: ${path}`);
    await commandOk(process.execPath, ["--version"], nodeRuntimeEnv());
    await commandOk(ffmpeg, ["-version"]);
    await commandOk(ffprobe, ["-version"]);
    return { ffmpeg, ffprobe };
  }

  function executionEnv(projectEnv = {}) {
    const { ffmpeg, ffprobe } = binaryPaths();
    const bins = [...new Set([dirname(ffmpeg), dirname(ffprobe)])];
    const merged = { ...projectEnv, ...process.env };
    // Empty inherited values must not erase credentials intentionally stored
    // in AutoEditPost's project-local .env file.
    for (const [key, value] of Object.entries(projectEnv)) if (!merged[key]) merged[key] = value;
    return nodeRuntimeEnv({
      ...merged,
      FFMPEG_PATH: ffmpeg,
      FFPROBE_PATH: ffprobe,
      PATH: `${bins.join(delimiter)}${delimiter}${process.env.PATH || ""}`,
    });
  }

  async function executeStage(run, node) {
    const logDir = join(run.config.outputDir, "_pipeline", "logs");
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, `${node.id.replaceAll(":", "_")}.log`);
    node.logPath = logPath;
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`\n[${new Date().toISOString()}] attempt ${node.attempts}\n`);
    const script = join(run.config.autoEditRoot, "scripts", "talking_head_stage.mjs");
    const args = [script, node.stage, "--id", node.reel, "--input", run.config.inputPath, "--manifest", run.config.manifestPath, "--out", run.config.outputDir];
    if (run.config.force) args.push("--force");
    let projectEnv = {};
    try { projectEnv = parseProjectEnv(await readFile(join(run.config.autoEditRoot, ".env"), "utf8")); } catch { /* optional project environment */ }
    await new Promise((resolveStage, reject) => {
      const child = spawn(process.execPath, args, { cwd: run.config.autoEditRoot, env: executionEnv(projectEnv), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      if (!children.has(run.id)) children.set(run.id, new Set());
      children.get(run.id).add(child);
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        children.get(run.id)?.delete(child);
        if (code === 0) resolveStage();
        else reject(new Error(`stage ${node.id} exited ${code ?? signal}; see ${logPath}`));
      });
    }).finally(() => log.end());
  }

  async function executeFinalize(run, node) {
    const logDir = join(run.config.outputDir, "_pipeline", "logs");
    const proofDir = join(run.config.outputDir, "_pipeline", "proof");
    await mkdir(logDir, { recursive: true });
    await mkdir(proofDir, { recursive: true });
    const logPath = join(logDir, "finalize.log");
    node.logPath = logPath;
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`\n[${new Date().toISOString()}] independent batch acceptance attempt ${node.attempts}\n`);
    const script = join(run.config.autoEditRoot, "scripts", "verify_talking_head_batch.mjs");
    const args = [script, "--out", run.config.outputDir, "--manifest", run.config.manifestPath, "--proof", proofDir];
    let projectEnv = {};
    try { projectEnv = parseProjectEnv(await readFile(join(run.config.autoEditRoot, ".env"), "utf8")); } catch { /* optional project environment */ }
    await new Promise((resolveFinalize, reject) => {
      const child = spawn(process.execPath, args, { cwd: run.config.autoEditRoot, env: executionEnv(projectEnv), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      if (!children.has(run.id)) children.set(run.id, new Set());
      children.get(run.id).add(child);
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        children.get(run.id)?.delete(child);
        if (code === 0) resolveFinalize();
        else reject(new Error(`independent batch acceptance exited ${code ?? signal}; see ${logPath}`));
      });
    }).finally(() => log.end());
    return {
      artifacts: run.reels.map((reel) => { const label = run.labels?.[reel] || `y_0${reel}`; return join(run.config.outputDir, label, `${label}_FINAL.mp4`); }),
      proof: join(proofDir, "proof.json"),
    };
  }

  async function executeNode(run, node) {
    node.status = "running";
    node.startedAt = new Date().toISOString();
    node.attempts += 1;
    delete node.error;
    await save(run);
    try {
      if (node.kind === "preflight") node.result = await preflight(run);
      else if (node.kind === "finalize") node.result = await executeFinalize(run, node);
      else await executeStage(run, node);
      node.status = "completed";
      node.finishedAt = new Date().toISOString();
    } catch (error) {
      node.error = error.message || String(error);
      node.finishedAt = new Date().toISOString();
      node.status = node.attempts <= run.config.retryLimit ? "pending" : "failed";
    }
    await save(run);
  }

  async function scheduler(run) {
    try {
      run.status = "running";
      await save(run);
      while (true) {
        if (run.cancelRequested) {
          for (const node of run.nodes) if (node.status === "pending" || node.status === "running") node.status = "cancelled";
          run.status = "cancelled";
          await save(run);
          return;
        }
        const byId = new Map(run.nodes.map((node) => [node.id, node]));
        const ready = run.nodes.filter((node) => node.status === "pending" && node.deps.every((dep) => TERMINAL_OK.has(byId.get(dep)?.status)));
        if (!ready.length) {
          const running = run.nodes.some((node) => node.status === "running");
          if (running) continue;
          const failed = run.nodes.filter((node) => node.status === "failed");
          if (failed.length) run.status = "failed";
          else if (run.nodes.every((node) => TERMINAL_OK.has(node.status))) run.status = "completed";
          else {
            run.status = "failed";
            for (const node of run.nodes.filter((item) => item.status === "pending")) node.error ||= "blocked by a failed dependency";
          }
          await save(run);
          return;
        }
        await Promise.all(ready.slice(0, run.config.concurrency).map((node) => executeNode(run, node)));
      }
    } finally {
      active.delete(run.id);
      activeRuns.delete(run.id);
      children.delete(run.id);
    }
  }

  async function start(args) {
    const run = await load(args.runId);
    if (active.has(run.id)) return { id: run.id, alreadyRunning: true, summary: summary(run) };
    for (const node of run.nodes) if (node.status === "running" || node.status === "cancelled") node.status = "pending";
    run.cancelRequested = false;
    run.config.force = Boolean(args.force);
    run.status = "running";
    delete run.schedulerError;
    // Persist the transition before returning. CLI/MCP pollers must never see
    // the previous terminal status after a successful resume request.
    await save(run);
    const promise = scheduler(run).catch(async (error) => {
      run.status = "failed";
      run.schedulerError = error.message || String(error);
      await save(run);
    });
    activeRuns.set(run.id, run);
    active.set(run.id, promise);
    return { id: run.id, started: true, summary: summary(run) };
  }

  async function read(args) {
    const run = await load(args.runId);
    const result = { id: run.id, name: run.name, createdAt: run.createdAt, updatedAt: run.updatedAt, summary: summary(run), config: run.config, reels: run.reels };
    if (args.includeNodes !== false) result.nodes = run.nodes;
    result.artifacts = run.reels.map((reel) => { const label = run.labels?.[reel] || `y_0${reel}`; return { reel, label, video: join(run.config.outputDir, label, `${label}_FINAL.mp4`), qa: join(run.config.outputDir, label, "qa.json") }; });
    return result;
  }

  async function list() {
    const runs = [];
    for (const id of await ids()) {
      const run = await load(id);
      runs.push({ id: run.id, name: run.name, updatedAt: run.updatedAt, reels: run.reels.length, summary: summary(run),
        inputPath: run.config?.inputPath || null, outputDir: run.config?.outputDir || null });
    }
    return { pipelines: runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }

  async function retry(args) {
    const run = await load(args.runId);
    if (active.has(run.id)) throw new Error("Pipeline is already running");
    const reset = new Set(run.nodes.filter((node) => node.status === "failed").map((node) => node.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of run.nodes) if (!reset.has(node.id) && node.deps.some((dep) => reset.has(dep))) { reset.add(node.id); changed = true; }
    }
    for (const node of run.nodes) if (reset.has(node.id)) {
      node.status = "pending";
      node.attempts = 0;
      delete node.error;
    }
    await save(run);
    return start({ runId: run.id, force: false });
  }

  async function rerunReel(args) {
    const run = await load(args.runId);
    if (active.has(run.id)) throw new Error("Pipeline is already running");
    const reset = resetReelNodes(run, args.reel, args.fromStage || "cut");
    await save(run);
    const started = await start({ runId: run.id, force: args.force !== false });
    return { ...started, reel: String(args.reel).padStart(2, "0"), fromStage: args.fromStage || "cut", reset };
  }

  async function rebuild(args) {
    const run = await load(args.runId);
    if (active.has(run.id)) throw new Error("Pipeline is already running");
    const reset = resetBatchNodes(run);
    await save(run);
    const started = await start({ runId: run.id, force: args.force !== false });
    return { ...started, reset };
  }

  async function rerunBatchFromStage(args) {
    const run = await load(args.runId);
    if (active.has(run.id)) throw new Error("Pipeline is already running");
    const fromStage = args.fromStage || "cut";
    const reset = resetBatchNodes(run, fromStage);
    await save(run);
    const started = await start({ runId: run.id, force: args.force !== false });
    return { ...started, fromStage, reset };
  }

  async function cancel(args) {
    const loaded = await load(args.runId);
    const run = activeRuns.get(loaded.id) || loaded;
    run.cancelRequested = true;
    for (const child of children.get(run.id) || []) child.kill();
    if (!active.has(run.id)) {
      for (const node of run.nodes) if (node.status === "pending" || node.status === "running") node.status = "cancelled";
      run.status = "cancelled";
    }
    await save(run);
    return { id: run.id, cancelled: true, summary: summary(run) };
  }

  return {
    async call(name, args = {}) {
      if (name === "create_talking_head_pipeline") return create(args);
      if (name === "run_talking_head_pipeline") return start(args);
      if (name === "read_talking_head_pipeline") return read(args);
      if (name === "list_talking_head_pipelines") return list();
      if (name === "retry_talking_head_pipeline") return retry(args);
      if (name === "rerun_talking_head_reel") return rerunReel(args);
      if (name === "rebuild_talking_head_pipeline") return rebuild(args);
      if (name === "rerun_talking_head_batch_from_stage") return rerunBatchFromStage(args);
      if (name === "cancel_talking_head_pipeline") return cancel(args);
      throw new Error(`Unknown pipeline tool: ${name}`);
    },
  };
}
