import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPipelineManager, pipelineToolDefinitions, prepareLocalMediaBinaries } from "./pipeline.mjs";
import { createEditorEngine, editorToolDefinitions } from "./editor-engine.mjs";
import { loadUploadConfig, uploadFileToServer } from "./upload-client.mjs";
import { createPublishingManager, DEFAULT_POSTIZ_API_URL, publishingToolDefinitions } from "./publishing.mjs";

const DATA_DIR = resolve(process.env.LOCALCUT_DATA_DIR || join(homedir(), ".localcut"));
const STATE_FILE = join(DATA_DIR, "state.json");
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const pipelines = createPipelineManager({ dataDir: DATA_DIR });
const editor = createEditorEngine({ dataDir: DATA_DIR });
const AUTOEDITPOST_ROOT = resolve(process.env.AUTOEDITPOST_ROOT || "C:\\AutoEditPost");
const publishing = createPublishingManager({ autoEditRoot: AUTOEDITPOST_ROOT, dataDir: DATA_DIR, pipelineManager: pipelines,
  getCredential: async () => ({ key: process.env.POSTIZ_KEY || "", apiUrl: process.env.POSTIZ_API_URL || DEFAULT_POSTIZ_API_URL }) });
const uploadToolDefinitions = [{
  name: "upload_media_to_server",
  description: "Stream a local media file to the configured LocalCut ingest server and verify the server byte count and SHA-256 receipt.",
  inputSchema: {
    type: "object",
    properties: { filePath: { type: "string", description: "Local file path to stream to the ingest server" } },
    required: ["filePath"], additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}];

const tools = [
  ...editorToolDefinitions,
  ...pipelineToolDefinitions,
  ...uploadToolDefinitions,
  ...publishingToolDefinitions,
];

function tool(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: ["list_projects", "get_active_project", "read_project"].includes(name) } };
}
function stringProp(description) { return { type: "string", description }; }
function numberProp(description, minimum) { return { type: "number", description, minimum }; }
function intProp(description, minimum) { return { type: "integer", description, minimum }; }
function arrayProp(description) { return { type: "array", description, items: {} }; }
function boolProp(description) { return { type: "boolean", description }; }

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, activeProjectId: null, projects: {} };
  }
}
async function saveState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, STATE_FILE);
}
function activeProject(state) {
  const project = state.projects[state.activeProjectId];
  if (!project) throw new Error("No active project. Call create_project or target_project first.");
  return project;
}
function id(prefix) { return `${prefix}_${randomUUID()}`; }
function resolveId(records, candidate) {
  if (records[candidate]) return candidate;
  const matches = Object.keys(records).filter((key) => key.startsWith(candidate));
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous id: ${candidate}` : `Unknown id: ${candidate}`);
  return matches[0];
}
async function run(command, args) {
  if (command === FFMPEG || command === FFPROBE) {
    const binaries = await prepareLocalMediaBinaries();
    command = command === FFMPEG ? binaries.ffmpeg : binaries.ffprobe;
  }
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)));
  });
}
async function probe(filePath) {
  const absolute = resolve(filePath);
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", absolute]);
  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  return { path: absolute, duration: Number(data.format?.duration || video?.duration || audio?.duration || 0),
    type: video ? "video" : audio ? "audio" : "unknown", width: video?.width || null, height: video?.height || null,
    hasAudio: Boolean(audio), videoCodec: video?.codec_name || null, audioCodec: audio?.codec_name || null };
}

async function callTool(name, args = {}) {
  if (name === "upload_media_to_server") {
    const config = await loadUploadConfig({ dataDir: DATA_DIR });
    if (!config.enabled) throw new Error(`Upload server is not configured. Create ${config.configPath}`);
    return uploadFileToServer({ filePath: args.filePath, url: config.url, token: config.token });
  }
  if (name === "inspect_postiz_publishing") return publishing.snapshot(args.runId);
  if (name === "inspect_postiz_calendar") return publishing.activeSchedule(args);
  if (name === "build_postiz_plan") { const { runId, ...options } = args; return publishing.savePlan(runId, options); }
  if (name === "schedule_postiz_plan") return publishing.schedulePlan(args.planId, args.confirmation);
  if (name === "repair_postiz_covers") return publishing.repairScheduledCovers(args);
  if (pipelineToolDefinitions.some((candidate) => candidate.name === name)) return pipelines.call(name, args);
  if (editorToolDefinitions.some((candidate) => candidate.name === name)) return editor.call(name, args);
  const state = await loadState();
  if (name === "create_project") {
    const projectId = id("project");
    state.projects[projectId] = { id: projectId, name: args.name, width: args.width || 1920, height: args.height || 1080,
      fps: args.fps || 30, createdAt: new Date().toISOString(), assets: {}, items: {} };
    state.activeProjectId = projectId; await saveState(state); return state.projects[projectId];
  }
  if (name === "list_projects") return { activeProjectId: state.activeProjectId,
    projects: Object.values(state.projects).map(({ assets, items, ...project }) => ({ ...project, assetCount: Object.keys(assets).length, itemCount: Object.keys(items).length })) };
  if (name === "target_project") {
    const projectId = resolveId(state.projects, args.projectId); state.activeProjectId = projectId; await saveState(state); return { projectId };
  }
  if (name === "get_active_project") return { projectId: state.activeProjectId };
  const project = activeProject(state);
  if (name === "import_asset") {
    const info = await probe(args.filePath); const assetId = id("asset");
    project.assets[assetId] = { id: assetId, name: args.name || info.path.split("/").at(-1), ...info };
    await saveState(state); return project.assets[assetId];
  }
  if (name === "read_project") return project;
  if (name === "edit_item") {
    const next = structuredClone(project.items);
    for (const candidate of args.deletes || []) delete next[resolveId(next, typeof candidate === "string" ? candidate : candidate.id)];
    for (const patch of args.updates || []) { const itemId = resolveId(next, patch.id); next[itemId] = { ...next[itemId], ...patch, id: itemId }; }
    for (const add of args.adds || []) {
      const assetId = resolveId(project.assets, add.assetId); const asset = project.assets[assetId]; const itemId = id("item");
      next[itemId] = { id: itemId, assetId, track: add.track || "V1", from: Number(add.from || 0),
        duration: Number(add.duration ?? asset.duration), sourceStart: Number(add.sourceStart || 0) };
    }
    validateTimeline(next, project.assets);
    if (!args.validateOnly) { project.items = next; await saveState(state); }
    return { committed: !args.validateOnly, items: Object.values(next).sort((a, b) => a.from - b.from) };
  }
  if (name === "split_item") {
    const itemId = resolveId(project.items, args.id); const item = project.items[itemId];
    const cuts = [...new Set(args.at.map(Number))].sort((a, b) => a - b);
    if (cuts.some((cut) => cut <= item.from || cut >= item.from + item.duration)) throw new Error("Every split time must be strictly inside the item.");
    const boundaries = [item.from, ...cuts, item.from + item.duration]; const newIds = [];
    delete project.items[itemId];
    for (let index = 0; index < boundaries.length - 1; index++) {
      const newId = id("item"); const offset = boundaries[index] - item.from;
      project.items[newId] = { ...item, id: newId, from: boundaries[index], duration: boundaries[index + 1] - boundaries[index], sourceStart: item.sourceStart + offset };
      newIds.push(newId);
    }
    await saveState(state); return { itemId, newIds };
  }
  if (name === "local_export") {
    const clips = Object.values(project.items).filter((item) => item.track === "V1").sort((a, b) => a.from - b.from);
    if (!clips.length) throw new Error("V1 has no clips to export.");
    const manifestPath = join(DATA_DIR, `export-${createHash("sha1").update(randomUUID()).digest("hex")}.ffconcat`);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const lines = ["ffconcat version 1.0"];
    for (const clip of clips) { const asset = project.assets[clip.assetId]; lines.push(`file ${quote(asset.path)}`, `inpoint ${clip.sourceStart}`, `outpoint ${clip.sourceStart + clip.duration}`); }
    await writeFile(manifestPath, `${lines.join("\n")}\n`); await mkdir(dirname(resolve(args.outputPath)), { recursive: true });
    await run(FFMPEG, ["-y", "-safe", "0", "-f", "concat", "-i", manifestPath, "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", resolve(args.outputPath)]);
    return { outputPath: resolve(args.outputPath), clips: clips.length };
  }
  throw new Error(`Unknown tool: ${name}`);
}
function validateTimeline(items, assets) {
  const tracks = new Map();
  for (const item of Object.values(items)) {
    if (!assets[item.assetId]) throw new Error(`Unknown asset: ${item.assetId}`);
    if (![item.from, item.duration, item.sourceStart].every(Number.isFinite) || item.from < 0 || item.duration <= 0 || item.sourceStart < 0) throw new Error(`Invalid timing for ${item.id}`);
    const track = tracks.get(item.track) || []; track.push(item); tracks.set(item.track, track);
  }
  for (const [trackName, track] of tracks) { track.sort((a, b) => a.from - b.from);
    for (let index = 1; index < track.length; index++) if (track[index].from < track[index - 1].from + track[index - 1].duration - 1e-6) throw new Error(`Overlap on ${trackName}: ${track[index - 1].id} and ${track[index].id}`); }
}
function response(idValue, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: idValue, result })}\n`); }
function errorResponse(idValue, error) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: idValue, error: { code: -32000, message: error.message || String(error) } })}\n`); }
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const cleanLine = line.replace(/^\uFEFF/, "");
  if (!cleanLine.trim()) continue;
  let request;
  try {
    request = JSON.parse(cleanLine);
    if (request.method === "initialize") response(request.id, { protocolVersion: request.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "localcut", version: "0.8.6" } });
    else if (request.method === "notifications/initialized") continue;
    else if (request.method === "ping") response(request.id, {});
    else if (request.method === "tools/list") response(request.id, { tools });
    else if (request.method === "tools/call") { const result = await callTool(request.params?.name, request.params?.arguments || {}); response(request.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result }); }
    else errorResponse(request.id, new Error(`Unknown method: ${request.method}`));
  } catch (error) { errorResponse(request?.id ?? null, error); }
}
