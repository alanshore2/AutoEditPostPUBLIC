import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { prepareLocalMediaBinaries } from "./pipeline.mjs";

const stringProp = (description) => ({ type: "string", description });
const numberProp = (description, minimum) => ({ type: "number", description, minimum });
const intProp = (description, minimum) => ({ type: "integer", description, minimum });
const arrayProp = (description) => ({ type: "array", description, items: {} });
const boolProp = (description) => ({ type: "boolean", description });
const tool = (name, description, properties = {}, required = [], readOnly = false) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: ["delete_project", "remove_asset"].includes(name) },
});

export const editorToolDefinitions = [
  tool("create_project", "Create a local video project and make it active.", {
    name: stringProp("Project name"), width: intProp("Canvas width", 16),
    height: intProp("Canvas height", 16), fps: numberProp("Frames per second", 1),
  }, ["name"]),
  tool("list_projects", "List all local editor projects.", {}, [], true),
  tool("target_project", "Make a project active.", { projectId: stringProp("Project id") }, ["projectId"]),
  tool("get_active_project", "Return the active project id.", {}, [], true),
  tool("read_project", "Read the active project, assets, settings, and timeline.", {}, [], true),
  tool("update_project", "Rename a project or change canvas and editor settings.", {
    name: stringProp("Project name"), width: intProp("Canvas width", 16), height: intProp("Canvas height", 16),
    fps: numberProp("Frames per second", 1), settings: { type: "object", description: "Editor settings patch" },
  }),
  tool("duplicate_project", "Duplicate the active project.", { name: stringProp("Optional copy name") }),
  tool("delete_project", "Delete a local project.", { projectId: stringProp("Project id") }, ["projectId"]),
  tool("import_asset", "Probe and import a local video or audio asset.", {
    filePath: stringProp("Local media path"), name: stringProp("Optional display name"), kind: stringProp("Asset grouping"),
  }, ["filePath"]),
  tool("remove_asset", "Remove an asset and its timeline items.", { assetId: stringProp("Asset id") }, ["assetId"]),
  tool("edit_item", "Atomically add, update, or delete timeline clips. Times are seconds.", {
    adds: arrayProp("Items: {assetId, from, duration?, sourceStart?, track?}"),
    updates: arrayProp("Patches containing an item id"), deletes: arrayProp("Item ids"),
    validateOnly: boolProp("Validate without saving"),
  }),
  tool("split_item", "Split a timeline clip at one or more timeline times.", {
    id: stringProp("Timeline item id"), at: arrayProp("Timeline times in seconds"),
  }, ["id", "at"]),
  tool("undo_project", "Undo the last local project mutation."),
  tool("redo_project", "Redo the last undone project mutation."),
  tool("save_project_version", "Save a named restorable project version.", { name: stringProp("Version name") }),
  tool("list_project_versions", "List saved versions for the active project.", {}, [], true),
  tool("restore_project_version", "Restore a saved project version.", { versionId: stringProp("Version id") }, ["versionId"]),
  tool("read_transcript", "Read an imported asset's local ASS caption transcript.", { assetId: stringProp("Asset id") }, [], true),
  tool("seed_autoeditpost_project", "Create or reopen the local AutoEditPost production project.", {
    autoEditRoot: stringProp("AutoEditPost root folder"),
    sourceVideo: stringProp("Optional source video path; defaults to the first media file in AutoEditPost/Raw"),
  }, ["autoEditRoot"]),
  tool("local_export", "Render sequential V1 clips locally to H.264/AAC MP4.", {
    outputPath: stringProp("Output MP4 path"),
  }, ["outputPath"]),
];

export function createEditorEngine({ dataDir, ffmpegPath, ffprobePath } = {}) {
  const root = resolve(dataDir || process.env.LOCALCUT_DATA_DIR || ".localcut");
  const stateFile = join(root, "state.json");
  const configuredFfmpeg = ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
  const configuredFfprobe = ffprobePath || process.env.FFPROBE_PATH || "ffprobe";

  async function loadState() {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      state.version ||= 2; state.projects ||= {}; state.activeProjectId ||= null;
      return state;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { version: 2, activeProjectId: null, projects: {} };
    }
  }

  async function saveState(state) {
    await mkdir(root, { recursive: true });
    const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, stateFile);
  }

  function resolveId(records, candidate) {
    if (records[candidate]) return candidate;
    const matches = Object.keys(records).filter((key) => key.startsWith(candidate || ""));
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous id: ${candidate}` : `Unknown id: ${candidate}`);
    return matches[0];
  }

  function activeProject(state) {
    const project = state.projects[state.activeProjectId];
    if (!project) throw new Error("No active project. Create or select a project first.");
    hydrateProject(project);
    return project;
  }

  function hydrateProject(project) {
    project.assets ||= {}; project.items ||= {}; project.versions ||= [];
    project._undo ||= []; project._redo ||= [];
    project.settings ||= { aspectRatio: "9:16", captions: true, snapping: true, workspace: "default" };
    project.updatedAt ||= project.createdAt || new Date().toISOString();
    return project;
  }

  function snapshot(project) {
    const { _undo, _redo, versions, ...content } = project;
    return structuredClone(content);
  }

  function checkpoint(project) {
    project._undo.push(snapshot(project));
    if (project._undo.length > 30) project._undo.shift();
    project._redo = [];
  }

  function restoreSnapshot(project, content, stacks = {}) {
    const versions = project.versions || [];
    for (const key of Object.keys(project)) delete project[key];
    Object.assign(project, structuredClone(content), { versions, _undo: stacks.undo || [], _redo: stacks.redo || [] });
    hydrateProject(project);
  }

  async function run(command, args) {
    if (command === configuredFfmpeg || command === configuredFfprobe) {
      const binaries = await prepareLocalMediaBinaries();
      command = command === configuredFfmpeg ? binaries.ffmpeg : binaries.ffprobe;
    }
    return await new Promise((resolveRun, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => stdout += chunk);
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.on("error", reject);
      child.on("close", (code) => code === 0
        ? resolveRun({ stdout, stderr })
        : reject(new Error(`${basename(command)} exited ${code}: ${stderr.slice(-1800)}`)));
    });
  }

  async function probe(filePath) {
    const absolute = resolve(filePath);
    if (!existsSync(absolute)) throw new Error(`Media file not found: ${absolute}`);
    const { stdout } = await run(configuredFfprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", absolute]);
    const data = JSON.parse(stdout);
    const video = data.streams?.find((stream) => stream.codec_type === "video");
    const audio = data.streams?.find((stream) => stream.codec_type === "audio");
    return {
      path: absolute, duration: Number(data.format?.duration || video?.duration || audio?.duration || 0),
      bytes: Number(data.format?.size || 0), type: video ? "video" : audio ? "audio" : "unknown",
      width: video?.width || null, height: video?.height || null, hasAudio: Boolean(audio),
      videoCodec: video?.codec_name || null, audioCodec: audio?.codec_name || null,
    };
  }

  function validateTimeline(items, assets) {
    const tracks = new Map();
    for (const item of Object.values(items)) {
      if (!assets[item.assetId]) throw new Error(`Unknown asset: ${item.assetId}`);
      if (![item.from, item.duration, item.sourceStart].every(Number.isFinite) || item.from < 0 || item.duration <= 0 || item.sourceStart < 0) {
        throw new Error(`Invalid timing for ${item.id}`);
      }
      if (item.sourceStart + item.duration > assets[item.assetId].duration + 0.05) throw new Error(`Clip exceeds source duration: ${item.id}`);
      const track = tracks.get(item.track) || []; track.push(item); tracks.set(item.track, track);
    }
    for (const [trackName, track] of tracks) {
      track.sort((a, b) => a.from - b.from);
      for (let index = 1; index < track.length; index++) {
        if (track[index].from < track[index - 1].from + track[index - 1].duration - 1e-6) {
          throw new Error(`Overlap on ${trackName}: ${track[index - 1].id} and ${track[index].id}`);
        }
      }
    }
  }

  function parseAssTime(value) {
    const match = String(value).trim().match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  }

  async function readTranscript(project, assetId) {
    const resolvedAssetId = assetId ? resolveId(project.assets, assetId) : Object.keys(project.assets)[0];
    const asset = project.assets[resolvedAssetId];
    if (!asset) return { assetId: null, source: null, lines: [] };
    const candidates = [join(dirname(asset.path), "cap.ass"), asset.path.replace(/\.[^.]+$/, ".ass"), asset.path.replace(/\.[^.]+$/, ".captions.ass")];
    const source = candidates.find((candidate) => existsSync(candidate));
    if (!source) return { assetId: resolvedAssetId, source: null, lines: [] };
    const lines = (await readFile(source, "utf8")).split(/\r?\n/).filter((line) => line.startsWith("Dialogue:"))
      .map((line, index) => {
        const fields = line.replace(/^Dialogue:\s*/, "").split(",");
        const text = fields.slice(9).join(",").replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, " ").replace(/\\h/g, " ").trim();
        return { id: `line_${index + 1}`, start: parseAssTime(fields[1]), end: parseAssTime(fields[2]), text };
      }).filter((line) => line.text);
    return { assetId: resolvedAssetId, source, lines };
  }

  async function call(name, args = {}) {
    const state = await loadState();
    if (name === "create_project") {
      const projectId = `project_${randomUUID()}`;
      const now = new Date().toISOString();
      state.projects[projectId] = hydrateProject({
        id: projectId, name: args.name || "Untitled Project", width: args.width || 1080,
        height: args.height || 1920, fps: args.fps || 30, createdAt: now, updatedAt: now,
        assets: {}, items: {}, versions: [], settings: { aspectRatio: "9:16", captions: true, snapping: true, workspace: "default" },
      });
      state.activeProjectId = projectId; await saveState(state); return state.projects[projectId];
    }
    if (name === "list_projects") return {
      activeProjectId: state.activeProjectId,
      projects: Object.values(state.projects).map((raw) => {
        const project = hydrateProject(raw); const { assets, items, versions, _undo, _redo, ...summary } = project;
        return { ...summary, assetCount: Object.keys(assets).length, itemCount: Object.keys(items).length, versionCount: versions.length };
      }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    };
    if (name === "target_project") {
      const projectId = resolveId(state.projects, args.projectId); state.activeProjectId = projectId;
      await saveState(state); return hydrateProject(state.projects[projectId]);
    }
    if (name === "get_active_project") return { projectId: state.activeProjectId };
    if (name === "delete_project") {
      const projectId = resolveId(state.projects, args.projectId); delete state.projects[projectId];
      if (state.activeProjectId === projectId) state.activeProjectId = Object.keys(state.projects)[0] || null;
      await saveState(state); return { deleted: projectId, activeProjectId: state.activeProjectId };
    }
    if (name === "seed_autoeditpost_project") {
      const existing = Object.values(state.projects).find((project) => project.seedKey === "autoeditpost");
      if (existing) { state.activeProjectId = existing.id; await saveState(state); return hydrateProject(existing); }
      const now = new Date().toISOString(); const projectId = `project_${randomUUID()}`;
      const project = hydrateProject({
        id: projectId, seedKey: "autoeditpost", name: "AutoEditPost — Talking Head Studio", width: 1080, height: 1920,
        fps: 30, createdAt: now, updatedAt: now, assets: {}, items: {}, versions: [],
        settings: { aspectRatio: "9:16", captions: true, snapping: true, workspace: "default", designStyle: "Modern Editorial" },
      });
      const autoEditRoot = resolve(args.autoEditRoot);
      const legacySource = join(autoEditRoot, "Raw", "726_53192.MP4");
      let sourcePath = args.sourceVideo ? resolve(args.sourceVideo) : (existsSync(legacySource) ? legacySource : null);
      if (!sourcePath) {
        const rawDir = join(autoEditRoot, "Raw");
        try {
          const candidates = (await readdir(rawDir, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && /\.(mp4|mov|mkv|m4v|webm)$/i.test(entry.name))
            .map((entry) => join(rawDir, entry.name)).sort();
          sourcePath = candidates[0] || null;
        } catch { sourcePath = null; }
      }
      if (sourcePath && !existsSync(sourcePath)) throw new Error(`AutoEditPost source video does not exist: ${sourcePath}`);
      const paths = [...(sourcePath ? [sourcePath] : []), ...Array.from({ length: 12 }, (_, index) => {
        const reel = String(index + 1).padStart(3, "0");
        return join(autoEditRoot, "out", "yaps", `y_${reel}`, `y_${reel}_FINAL.mp4`);
      })].filter((candidate) => existsSync(candidate));
      for (const filePath of paths) {
        const info = await probe(filePath); const assetId = `asset_${randomUUID()}`;
        const isSource = filePath === sourcePath;
        project.assets[assetId] = { id: assetId, name: isSource ? `${basename(filePath).replace(/\.[^.]+$/, "")} — Source` : basename(filePath, ".mp4").replace("_FINAL", ""), kind: isSource ? "source" : "finished", ...info };
      }
      const firstFinished = Object.values(project.assets).find((asset) => asset.kind === "finished");
      if (firstFinished) {
        const itemId = `item_${randomUUID()}`;
        project.items[itemId] = { id: itemId, assetId: firstFinished.id, track: "V1", from: 0, duration: firstFinished.duration, sourceStart: 0 };
      }
      state.projects[projectId] = project; state.activeProjectId = projectId; await saveState(state); return project;
    }

    const project = activeProject(state);
    if (name === "read_project") return project;
    if (name === "update_project") {
      checkpoint(project);
      if (args.name !== undefined) project.name = String(args.name).trim() || project.name;
      if (args.width) project.width = Number(args.width); if (args.height) project.height = Number(args.height); if (args.fps) project.fps = Number(args.fps);
      if (args.settings) project.settings = { ...project.settings, ...args.settings };
      project.updatedAt = new Date().toISOString(); await saveState(state); return project;
    }
    if (name === "duplicate_project") {
      const copy = snapshot(project); const projectId = `project_${randomUUID()}`; const now = new Date().toISOString();
      copy.id = projectId; copy.name = args.name || `${project.name} Copy`; copy.createdAt = now; copy.updatedAt = now; copy.seedKey = null;
      copy.items = Object.fromEntries(Object.values(copy.items).map((item) => { const id = `item_${randomUUID()}`; return [id, { ...item, id }]; }));
      copy.assets = Object.fromEntries(Object.values(copy.assets).map((asset) => { const id = `asset_${randomUUID()}`; const old = asset.id; for (const item of Object.values(copy.items)) if (item.assetId === old) item.assetId = id; return [id, { ...asset, id }]; }));
      state.projects[projectId] = hydrateProject(copy); state.activeProjectId = projectId; await saveState(state); return state.projects[projectId];
    }
    if (name === "import_asset") {
      const absolute = resolve(args.filePath);
      const existing = Object.values(project.assets).find((asset) => asset.path.toLowerCase() === absolute.toLowerCase());
      if (existing) return existing;
      const info = await probe(absolute); checkpoint(project); const assetId = `asset_${randomUUID()}`;
      project.assets[assetId] = { id: assetId, name: args.name || basename(info.path), kind: args.kind || "imported", ...info };
      project.updatedAt = new Date().toISOString(); await saveState(state); return project.assets[assetId];
    }
    if (name === "remove_asset") {
      const assetId = resolveId(project.assets, args.assetId); checkpoint(project); delete project.assets[assetId];
      for (const item of Object.values(project.items)) if (item.assetId === assetId) delete project.items[item.id];
      project.updatedAt = new Date().toISOString(); await saveState(state); return { removed: assetId };
    }
    if (name === "edit_item") {
      const next = structuredClone(project.items);
      for (const candidate of args.deletes || []) delete next[resolveId(next, typeof candidate === "string" ? candidate : candidate.id)];
      for (const patch of args.updates || []) { const itemId = resolveId(next, patch.id); next[itemId] = { ...next[itemId], ...patch, id: itemId }; }
      for (const add of args.adds || []) {
        const assetId = resolveId(project.assets, add.assetId); const asset = project.assets[assetId]; const itemId = `item_${randomUUID()}`;
        next[itemId] = { id: itemId, assetId, track: add.track || (asset.type === "audio" ? "A1" : "V1"), from: Number(add.from || 0), duration: Number(add.duration ?? asset.duration), sourceStart: Number(add.sourceStart || 0) };
      }
      validateTimeline(next, project.assets);
      if (!args.validateOnly) { checkpoint(project); project.items = next; project.updatedAt = new Date().toISOString(); await saveState(state); }
      return { committed: !args.validateOnly, items: Object.values(next).sort((a, b) => a.from - b.from) };
    }
    if (name === "split_item") {
      const itemId = resolveId(project.items, args.id); const item = project.items[itemId];
      const cuts = [...new Set(args.at.map(Number))].sort((a, b) => a - b);
      if (cuts.some((cut) => cut <= item.from || cut >= item.from + item.duration)) throw new Error("Every split time must be inside the selected clip.");
      checkpoint(project); const boundaries = [item.from, ...cuts, item.from + item.duration]; const newIds = []; delete project.items[itemId];
      for (let index = 0; index < boundaries.length - 1; index++) {
        const id = `item_${randomUUID()}`; const offset = boundaries[index] - item.from;
        project.items[id] = { ...item, id, from: boundaries[index], duration: boundaries[index + 1] - boundaries[index], sourceStart: item.sourceStart + offset }; newIds.push(id);
      }
      project.updatedAt = new Date().toISOString(); await saveState(state); return { itemId, newIds };
    }
    if (name === "undo_project") {
      if (!project._undo.length) return { changed: false, project };
      const previous = project._undo.pop(); const undo = project._undo; const redo = [...project._redo, snapshot(project)];
      restoreSnapshot(project, previous, { undo, redo }); project.updatedAt = new Date().toISOString(); await saveState(state); return { changed: true, project };
    }
    if (name === "redo_project") {
      if (!project._redo.length) return { changed: false, project };
      const next = project._redo.pop(); const redo = project._redo; const undo = [...project._undo, snapshot(project)];
      restoreSnapshot(project, next, { undo, redo }); project.updatedAt = new Date().toISOString(); await saveState(state); return { changed: true, project };
    }
    if (name === "save_project_version") {
      const version = { id: `version_${randomUUID()}`, name: args.name || `Version ${project.versions.length + 1}`, createdAt: new Date().toISOString(), snapshot: snapshot(project) };
      project.versions.unshift(version); if (project.versions.length > 25) project.versions.length = 25; await saveState(state);
      return { id: version.id, name: version.name, createdAt: version.createdAt };
    }
    if (name === "list_project_versions") return { versions: project.versions.map(({ snapshot: omitted, ...version }) => version) };
    if (name === "restore_project_version") {
      const version = project.versions.find((candidate) => candidate.id === resolveId(Object.fromEntries(project.versions.map((item) => [item.id, item])), args.versionId));
      checkpoint(project); const undo = project._undo; restoreSnapshot(project, version.snapshot, { undo, redo: [] }); project.updatedAt = new Date().toISOString(); await saveState(state); return project;
    }
    if (name === "read_transcript") return readTranscript(project, args.assetId);
    if (name === "local_export") {
      const clips = Object.values(project.items).filter((item) => item.track === "V1").sort((a, b) => a.from - b.from);
      if (!clips.length) throw new Error("V1 has no clips to export.");
      const manifestPath = join(root, `export-${createHash("sha1").update(randomUUID()).digest("hex")}.ffconcat`);
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      const lines = ["ffconcat version 1.0"];
      for (const clip of clips) {
        const asset = project.assets[clip.assetId]; lines.push(`file ${quote(asset.path)}`, `inpoint ${clip.sourceStart}`, `outpoint ${clip.sourceStart + clip.duration}`);
      }
      const outputPath = resolve(args.outputPath); await writeFile(manifestPath, `${lines.join("\n")}\n`); await mkdir(dirname(outputPath), { recursive: true });
      await run(configuredFfmpeg, ["-y", "-safe", "0", "-f", "concat", "-i", manifestPath, "-c:v", "libx264", "-preset", "medium", "-c:a", "aac", "-movflags", "+faststart", outputPath]);
      return { outputPath, clips: clips.length };
    }
    throw new Error(`Unknown editor tool: ${name}`);
  }

  return { call, dataDir: root, stateFile };
}
