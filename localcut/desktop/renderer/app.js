const api = window.localcut;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

const state = {
  bootstrap: null, project: null, projects: [], pipelines: [], pipeline: null,
  selectedAssetId: null, selectedItemId: null, playhead: 0, zoom: 70,
  editMode: "select", activeMediaTab: "assets", transcript: null,
  pipelineTimer: null, renameTimer: null, popoverAnchor: null, syncedPipelineIds: new Set(), batchStarting: false,
  reviewReel: null, reviewRerendering: null, reviewCoverAt: null, reviewCoverCandidates: [], reviewCoverRequest: 0,
  publishSnapshot: null, publishPlan: null, publishingBusy: false, activeSchedule: null, activeScheduleFilter: "all", activeScheduleLoading: false,
  podcastSource: null, podcastResult: null, podcastBusy: false, podcastProgress: null, podcastClearRequested: false,
  executionGraphHidden: false,
};
const pipelineStages = ["cut", "clean", "tighten", "speed", "captions", "render", "qa"];
const libraryTemplates = {
  motion: ["Active Number", "Editorial Quote", "Stack Chart", "Pointer Callout", "Chapter Card", "Lower Third"],
  sound: ["Soft Impact", "UI Click", "Riser", "Whoosh", "Page Turn", "Success Tone"],
  transition: ["Smooth Push", "Whip Pan", "Light Leak", "Film Burn", "Dip to Black", "Match Cut"],
  fx: ["Vignette", "Glow Edge", "Grain", "Chromatic Split", "Soft Bloom", "Focus Pull"],
  zoom: ["Punch In", "Slow Push", "Bounce Zoom", "Face Focus", "Ease Out", "Beat Zoom"],
  lut: ["Modern Clean", "Warm Editorial", "Cool Contrast", "Natural Skin", "Soft Film", "Monochrome"],
  audio: ["Voice Clarity", "Room Cleanup", "Warm Podcast", "Broadcast", "Light Compression", "Music Duck"],
};
const platformLabels = { instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", tiktok: "TikTok", youtube: "YouTube" };

function toast(message, type = "") {
  const element = $("#toast"); element.textContent = message; element.className = `toast show ${type}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.className = "toast", 2800);
}
function fmtTime(seconds = 0, frames = false) {
  seconds = Math.max(0, Number(seconds) || 0); const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60); const whole = Math.floor(seconds % 60);
  const hundredths = Math.floor((seconds % 1) * 100);
  return hours ? `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(whole).padStart(2,"0")}`
    : `${String(minutes).padStart(2,"0")}:${String(whole).padStart(2,"0")}${frames ? `.${String(hundredths).padStart(2,"0")}` : ""}`;
}
function fmtDuration(seconds) { return Number(seconds) >= 60 ? fmtTime(seconds) : `${Number(seconds || 0).toFixed(1)}s`; }
function fmtBytes(bytes) { const value = Number(bytes || 0); if (value < 1048576) return `${Math.max(0.1, value / 1024).toFixed(1)} KB`; const mb = value / 1048576; return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`; }
function currentAsset() { return state.project?.assets?.[state.selectedAssetId] || null; }
function currentItem() { return state.project?.items?.[state.selectedItemId] || null; }
function timelineEnd(track) {
  return Math.max(0, ...Object.values(state.project?.items || {}).filter((item) => !track || item.track === track).map((item) => item.from + item.duration));
}
function pixelsPerSecond() { return Math.max(3.5, state.zoom / 7); }

async function refreshProject(render = true) {
  state.project = await api.editorCall("read_project", {});
  if (state.selectedAssetId && !state.project.assets[state.selectedAssetId]) state.selectedAssetId = null;
  if (state.selectedItemId && !state.project.items[state.selectedItemId]) state.selectedItemId = null;
  if (!state.selectedAssetId) {
    const firstItem = Object.values(state.project.items)[0];
    state.selectedAssetId = firstItem?.assetId || Object.values(state.project.assets).find((asset) => asset.kind === "finished")?.id || Object.keys(state.project.assets)[0] || null;
  }
  if (render) renderProject();
}
async function refreshProjects() {
  const result = await api.editorCall("list_projects", {}); state.projects = result.projects || []; renderProjectLibrary();
}
async function mutate(name, args = {}, message) {
  const result = await api.editorCall(name, args); await refreshProject(); await refreshProjects();
  if (message) toast(message, "success"); return result;
}

function renderProject() {
  const project = state.project; if (!project) return;
  $("#projectName").value = project.name; $("#undoButton").disabled = !project._undo?.length; $("#redoButton").disabled = !project._redo?.length;
  $("#exportButton").disabled = !Object.values(project.items).some((item) => item.track === "V1");
  $("#exportCanvas").textContent = `${project.width} × ${project.height} · ${project.fps} fps`;
  const ratio = project.settings?.aspectRatio || "9:16"; $("#aspectButton").textContent = ratio;
  $("#viewerStage").className = `viewer-stage ratio-${ratio.replace(":","-")}`;
  const captions = project.settings?.captions !== false; $("#captionsButton").classList.toggle("active", captions); $("#captionsButton span").textContent = captions ? "On" : "Off";
  $("#snapButton").classList.toggle("active", project.settings?.snapping !== false);
  renderAssets(); renderViewer(); renderTimeline();
  if (state.activeMediaTab === "transcript") loadTranscript();
}

function assetCard(asset) {
  const selected = asset.id === state.selectedAssetId; const media = asset.type === "video" && asset.url
    ? `<video muted preload="metadata" src="${esc(asset.url)}#t=1"></video>` : "";
  return `<article class="asset-card${selected ? " selected" : ""}" data-asset="${esc(asset.id)}" draggable="true">
    <div class="asset-thumb ${esc(asset.type)}">${media}<span class="asset-kind">${esc(asset.kind || asset.type)}</span>${asset.kind === "finished" ? '<i class="asset-ready"></i>' : ""}</div>
    <div class="asset-meta"><strong>${esc(asset.name)}</strong><span>${fmtDuration(asset.duration)} · ${asset.width ? `${asset.width}×${asset.height}` : asset.type} · ${fmtBytes(asset.bytes)}</span></div>
    <button class="asset-add" data-add-asset="${esc(asset.id)}" title="Add to timeline">＋</button></article>`;
}
function renderAssets() {
  const query = $("#assetSearch").value.trim().toLowerCase();
  const assets = Object.values(state.project.assets).filter((asset) => !query || `${asset.name} ${asset.kind}`.toLowerCase().includes(query));
  $("#assetCount").textContent = `${assets.length} asset${assets.length === 1 ? "" : "s"}`;
  $("#assetGrid").innerHTML = assets.map(assetCard).join("") || `<div class="transcript-empty">No local media yet.<br>Import a video to begin editing.</div>`;
  $$('[data-asset]').forEach((card) => {
    card.onclick = (event) => { if (!event.target.closest("[data-add-asset]")) selectAsset(card.dataset.asset); };
    card.ondblclick = () => addAssetToTimeline(card.dataset.asset);
    card.ondragstart = (event) => { event.dataTransfer.setData("text/localcut-asset", card.dataset.asset); event.dataTransfer.effectAllowed = "copy"; };
  });
  $$('[data-add-asset]').forEach((button) => button.onclick = (event) => { event.stopPropagation(); addAssetToTimeline(button.dataset.addAsset); });
}

async function selectAsset(assetId, seek = null) {
  state.selectedAssetId = assetId; const asset = currentAsset(); if (!asset) return;
  $("#viewerAssetName").textContent = asset.name; const video = $("#viewerVideo");
  if (video.dataset.asset !== asset.id) { video.pause(); video.src = asset.url || ""; video.dataset.asset = asset.id; }
  if (seek !== null) { const applySeek = () => { video.currentTime = Math.max(0, Math.min(Number(seek), asset.duration || seek)); }; video.readyState ? applySeek() : video.addEventListener("loadedmetadata", applySeek, { once: true }); }
  renderAssets(); renderViewer(); if (state.activeMediaTab === "transcript") await loadTranscript();
}
function renderViewer() {
  const asset = currentAsset(); $("#viewerEmpty").classList.toggle("hidden", Boolean(asset));
  $("#viewerAssetName").textContent = asset?.name || "No media selected";
}

async function addAssetToTimeline(assetId, track) {
  const asset = state.project.assets[assetId]; if (!asset) return;
  const targetTrack = track || (asset.type === "audio" ? "A1" : "V1"); const from = timelineEnd(targetTrack);
  await mutate("edit_item", { adds: [{ assetId, track: targetTrack, from, duration: asset.duration, sourceStart: 0 }] }, `${asset.name} added to ${targetTrack}`);
  const added = Object.values(state.project.items).filter((item) => item.assetId === assetId && item.track === targetTrack).sort((a,b) => b.from - a.from)[0];
  state.selectedItemId = added?.id || null; state.playhead = added?.from || 0; renderTimeline(); await selectAsset(assetId, 0);
}

function renderTimeline() {
  const project = state.project; const total = Math.max(30, timelineEnd()); const pps = pixelsPerSecond();
  const width = Math.max($("#timelineScroll").clientWidth || 500, total * pps + 90);
  $("#timelineDuration").textContent = fmtTime(timelineEnd()); $("#zoomValue").textContent = `${state.zoom}%`;
  const ruler = $("#timeRuler"); ruler.style.width = `${width}px`;
  const step = total > 900 ? 120 : total > 300 ? 60 : total > 90 ? 15 : 5;
  ruler.innerHTML = Array.from({ length: Math.ceil(total / step) + 1 }, (_, index) => `<span class="ruler-mark" style="left:${index * step * pps}px">${fmtTime(index * step)}</span>`).join("");
  $$(".track-lane").forEach((lane) => { lane.style.width = `${width}px`; lane.innerHTML = ""; });
  Object.values(project.items).sort((a,b) => a.from - b.from).forEach((item) => {
    const asset = project.assets[item.assetId]; const lane = $(`.track-lane[data-track="${item.track}"]`); if (!lane || !asset) return;
    const clip = document.createElement("div"); clip.className = `timeline-clip${asset.type === "audio" ? " audio" : ""}${item.id === state.selectedItemId ? " selected" : ""}`;
    clip.dataset.item = item.id; clip.style.left = `${item.from * pps}px`; clip.style.width = `${Math.max(18,item.duration * pps)}px`;
    clip.innerHTML = `<span class="clip-name">${esc(asset.name)}</span><i class="wave"></i><i class="trim-handle left"></i><i class="trim-handle right"></i>`;
    clip.onclick = (event) => { event.stopPropagation(); selectTimelineItem(item.id); };
    clip.ondblclick = (event) => { event.stopPropagation(); state.playhead = item.from + item.duration / 2; splitSelected(); };
    lane.appendChild(clip);
  });
  $("#playhead").style.left = `${state.playhead * pps}px`; $("#playhead").style.height = `${29 + 58 * 3}px`;
}

async function selectTimelineItem(itemId) {
  state.selectedItemId = itemId; const item = currentItem(); if (!item) return;
  state.playhead = Math.max(item.from, Math.min(state.playhead, item.from + item.duration));
  renderTimeline(); await selectAsset(item.assetId, item.sourceStart + (state.playhead - item.from));
}
async function splitSelected() {
  const item = currentItem(); if (!item) return toast("Select a timeline clip first", "error");
  const at = state.playhead > item.from && state.playhead < item.from + item.duration ? state.playhead : item.from + item.duration / 2;
  try { await mutate("split_item", { id: item.id, at: [at] }, "Clip split at playhead"); state.selectedItemId = null; renderTimeline(); }
  catch (error) { toast(error.message || String(error), "error"); }
}
async function deleteSelectedItem() {
  if (!state.selectedItemId) return;
  await mutate("edit_item", { deletes: [state.selectedItemId] }, "Clip removed"); state.selectedItemId = null; renderTimeline();
}

async function uploadAndImport(path) {
  let receipt = null;
  try {
    if (state.bootstrap.upload?.enabled) {
      $("#uploadAssetButton").disabled = true;
      toast(`Uploading ${path.split(/[\\/]/).pop()} to ${state.bootstrap.upload.host}…`);
      receipt = await api.uploadFile(path);
    } else toast("Inspecting local media…");
    const asset = await api.editorCall("import_asset", { filePath: path });
    await refreshProject(); state.selectedAssetId = asset.id; renderProject(); await selectAsset(asset.id);
    if (receipt) {
      toast(`Server verified ${fmtBytes(receipt.bytes)} · SHA-256 matched`, "success");
      addAgentMessage(`<strong>SERVER RECEIVED</strong>${esc(receipt.originalName)} reached ${esc(state.bootstrap.upload.host)} intact. The server verified ${fmtBytes(receipt.bytes)} and SHA-256 <code>${esc(receipt.sha256.slice(0, 12))}…</code>. Its ingest id is <code>${esc(receipt.id)}</code>.`);
    } else toast("Media imported locally", "success");
    return { asset, receipt };
  } catch (error) {
    toast(error.message || String(error), "error");
    throw error;
  } finally { $("#uploadAssetButton").disabled = false; }
}

async function importMedia() {
  const path = await api.chooseFile({ title: state.bootstrap.upload?.enabled ? `Upload media to ${state.bootstrap.upload.host}` : "Import local media", defaultPath: state.bootstrap.defaults.inputPath, filters: [
    { name: "Video and audio", extensions: ["mp4","mov","m4v","mkv","webm","mp3","wav","m4a","aac"] },
  ] });
  if (!path) return;
  await uploadAndImport(path).catch(() => {});
}

async function loadTranscript() {
  const asset = currentAsset(); if (!asset) { renderTranscript({ lines: [] }); return; }
  try { state.transcript = await api.editorCall("read_transcript", { assetId: asset.id }); renderTranscript(state.transcript); }
  catch { renderTranscript({ lines: [] }); }
}
function renderTranscript(transcript) {
  const asset = currentAsset(); $("#transcriptSource").textContent = transcript?.source ? `${asset?.name} · local captions` : asset ? `${asset.name} · no caption sidecar` : "Choose an asset with captions";
  $("#transcriptLines").innerHTML = transcript?.lines?.length ? transcript.lines.map((line) => `<div class="transcript-line" data-transcript-time="${line.start}"><time>${fmtTime(line.start)}</time><p>${esc(line.text)}</p></div>`).join("")
    : `<div class="transcript-empty">No local transcript is available for this asset.<br>Run the caption stage or select a finished reel.</div>`;
  $$('[data-transcript-time]').forEach((line) => line.onclick = () => { selectAsset(state.selectedAssetId, Number(line.dataset.transcriptTime)); $$(".transcript-line").forEach((row) => row.classList.remove("active")); line.classList.add("active"); });
}

function switchMediaTab(tab) {
  state.activeMediaTab = tab; $$('[data-media-tab]').forEach((button) => button.classList.toggle("active", button.dataset.mediaTab === tab));
  $$(".media-view").forEach((view) => view.classList.toggle("active", view.id === `media-${tab}`)); if (tab === "transcript") loadTranscript();
}
function renderTemplates(category = "motion") {
  const colors = ["#7f78ee","#55a3dc","#d58c5b","#55b48c","#d76eaa","#8090ad"];
  $("#templateGrid").innerHTML = (libraryTemplates[category] || []).map((name,index) => `<article class="template-card" data-template="${esc(name)}"><div class="template-art" style="--template:${colors[index % colors.length]}"></div><strong>${esc(name)}</strong><span>${esc(category)} · local preset</span></article>`).join("");
  $$('[data-template]').forEach((card) => card.onclick = () => { addAgentMessage(`<strong>PRESET READY</strong>${esc(card.dataset.template)} is selected. Add a V2 graphics layer or ask the local agent to place it at a specific moment.`); toast(`${card.dataset.template} selected`); });
}

function addUserMessage(text) { $("#assistantWelcome").classList.add("compact"); $("#chatThread").insertAdjacentHTML("beforeend", `<div class="chat-message user">${esc(text)}</div>`); scrollChat(); }
function addAgentMessage(html) { $("#assistantWelcome").classList.add("compact"); $("#chatThread").insertAdjacentHTML("beforeend", `<div class="chat-message agent">${html}</div>`); bindMessageActions(); scrollChat(); }
function scrollChat() { $("#assistantScroll").scrollTop = $("#assistantScroll").scrollHeight; }
function bindMessageActions() {
  $$('[data-message-action]').forEach((button) => { if (button.dataset.bound) return; button.dataset.bound = "1"; button.onclick = () => {
    const action = button.dataset.messageAction; if (action === "automation") openAutomation(); if (action === "import") importMedia(); if (action === "podcast") openPodcast(); if (action === "transcript") switchMediaTab("transcript"); if (action === "export") openModal("exportModal");
  }; });
}
function setWorkflow(name) {
  const prompts = {
    talking: "Guide me through turning this talking-head footage into a polished edit using cleanup, tight pacing, captions, graphics, and local QA.",
    reels: "Build the complete 12-reel AutoEditPost batch and show me the resumable execution graph.",
    captions: "Turn on dynamic captions and inspect the local transcript for the selected reel.",
    review: "Open the completed batch and show every finished reel with QA warnings.",
    motion: "Help me add restrained motion graphics, callouts, and B-roll to the selected timeline.",
    publish: "Prepare covers, platform copy, and a local publishing checklist for the finished reels.",
  };
  $("#promptInput").value = prompts[name] || ""; $("#promptInput").focus();
  if (name === "review" || name === "reels") openAutomation();
}
async function runPrompt() {
  const input = $("#promptInput"); const text = input.value.trim(); if (!text) return; input.value = ""; addUserMessage(text);
  const lower = text.toLowerCase();
  if (/podcast|deep voice|clean.?up audio|isolate (the )?audio|dead space/.test(lower)) { addAgentMessage(`<strong>LOCAL PODCAST STUDIO</strong>Choose an audio or video recording. I will isolate the speech, add natural low-end depth, remove only major dead sections, master to podcast loudness, and keep video synchronized.<div class="message-actions"><button data-message-action="podcast">Open Podcast Studio</button></div>`); openPodcast(); return; }
  if (/import|upload|add media/.test(lower)) { const target = state.bootstrap.upload?.enabled ? `streamed to ${esc(state.bootstrap.upload.host)}, verified by byte count and SHA-256, then added to the local editor` : "probed with local FFmpeg and added to this project"; addAgentMessage(`<strong>MEDIA INGEST</strong>Choose a video or audio file. It will be ${target}.<div class="message-actions"><button data-message-action="import">Choose media</button></div>`); return; }
  if (/reel|talking.?head|batch|pipeline|autoedit/.test(lower)) { addAgentMessage(`<strong>TALKING-HEAD GRAPH</strong>Your production recipe is wired as seven resumable stages for every reel: cut, clean, tighten, speed, captions, render, and QA. The current 12-reel batch is available now.<div class="message-actions"><button data-message-action="automation">Open execution graph</button><button data-message-action="import">Import another source</button></div>`); return; }
  if (/caption|transcript|subtitle/.test(lower)) { await mutate("update_project", { settings: { captions: true } }); switchMediaTab("transcript"); addAgentMessage(`<strong>CAPTIONS ENABLED</strong>I turned on caption preview and opened text-based editing. Finished AutoEditPost reels load their local ASS dialogue here.<div class="message-actions"><button data-message-action="transcript">View transcript</button></div>`); return; }
  if (/export|render|deliver/.test(lower)) { addAgentMessage(`<strong>LOCAL EXPORT</strong>The V1 timeline is ready for H.264/AAC rendering with your bundled FFmpeg.<div class="message-actions"><button data-message-action="export">Open export</button></div>`); openModal("exportModal"); return; }
  if (/style|graphic|b.?roll|motion/.test(lower)) { showStylePopover($("#styleButton")); addAgentMessage(`<strong>DESIGN SYSTEM</strong>Choose a local style preset. It will be saved with the project and used as direction for cards, captions, and motion graphics.`); return; }
  addAgentMessage(`<strong>LOCAL EDITOR</strong>I can import media, edit the timeline, split clips, read local captions, manage versions, run the AutoEditPost graph, review QA, and export without sending footage to a hosted editor.`);
}

function openModal(id) { $("#contextPopover").hidden = true; $(`#${id}`).hidden = false; if (id === "projectModal") refreshProjects(); if (id === "versionsModal") renderVersions(); }
function closeModal(id) { $(`#${id}`).hidden = true; }
function renderProjectLibrary() {
  const target = $("#projectGrid"); if (!target) return; const query = $("#projectSearch")?.value?.trim().toLowerCase() || "";
  const projects = state.projects.filter((project) => !query || project.name.toLowerCase().includes(query));
  target.innerHTML = `<article class="project-card" id="createProjectCard"><div class="project-preview create"></div><div class="project-card-info"><strong>Create new project</strong><span>Blank local timeline</span></div></article>` + projects.map((project) => `<article class="project-card${project.id === state.project?.id ? " active" : ""}" data-project="${esc(project.id)}"><div class="project-preview"></div><div class="project-card-info"><strong>${esc(project.name)}</strong><span>${project.assetCount} assets · ${project.itemCount} clips</span></div><button class="project-actions" data-project-actions="${esc(project.id)}">⋮</button></article>`).join("");
  $("#createProjectCard").onclick = async () => { state.project = await api.editorCall("create_project", { name: "Untitled Project", width: 1080, height: 1920, fps: 30 }); await refreshProjects(); closeModal("projectModal"); state.selectedAssetId = null; state.selectedItemId = null; renderProject(); toast("New local project created", "success"); };
  $$('[data-project]').forEach((card) => card.onclick = async (event) => { if (event.target.closest("[data-project-actions]")) return; state.project = await api.editorCall("target_project", { projectId: card.dataset.project }); state.selectedAssetId = null; state.selectedItemId = null; await refreshProject(); closeModal("projectModal"); toast(`Opened ${state.project.name}`); });
  $$('[data-project-actions]').forEach((button) => button.onclick = (event) => { event.stopPropagation(); showProjectActions(button, button.dataset.projectActions); });
}
function showProjectActions(anchor, projectId) {
  showPopover(anchor, `<button class="popover-item" data-project-command="duplicate">Duplicate <small>local copy</small></button><button class="popover-item" data-project-command="delete">Delete <small>permanent</small></button>`);
  $$('[data-project-command]').forEach((button) => button.onclick = async () => {
    if (button.dataset.projectCommand === "duplicate") { await api.editorCall("target_project", { projectId }); state.project = await api.editorCall("duplicate_project", {}); await refreshProjects(); renderProject(); toast("Project duplicated", "success"); }
    else if (confirm("Delete this local project? Media files will not be deleted.")) { await api.editorCall("delete_project", { projectId }); const result = await api.editorCall("list_projects", {}); if (result.activeProjectId) await api.editorCall("target_project", { projectId: result.activeProjectId }); else state.project = await api.editorCall("create_project", { name: "Untitled Project" }); await refreshProject(); await refreshProjects(); }
    $("#contextPopover").hidden = true;
  });
}

async function renderVersions() {
  const result = await api.editorCall("list_project_versions", {}); const versions = result.versions || [];
  $("#versionsList").innerHTML = versions.length ? versions.map((version) => `<div class="version-row"><div><strong>${esc(version.name)}</strong><span>${new Date(version.createdAt).toLocaleString()}</span></div><button data-restore-version="${esc(version.id)}">Restore</button></div>`).join("") : `<div class="versions-empty">No saved versions yet.<br>Save a checkpoint before a major edit.</div>`;
  $$('[data-restore-version]').forEach((button) => button.onclick = async () => { await mutate("restore_project_version", { versionId: button.dataset.restoreVersion }, "Version restored"); closeModal("versionsModal"); });
}

function showPopover(anchor, html, width) {
  const popover = $("#contextPopover"); popover.innerHTML = html; if (width) popover.style.width = `${width}px`; else popover.style.removeProperty("width");
  popover.hidden = false; const rect = anchor.getBoundingClientRect(); const desiredLeft = Math.min(window.innerWidth - (width || 230) - 10, Math.max(8, rect.left));
  popover.style.left = `${desiredLeft}px`; popover.style.top = `${Math.min(window.innerHeight - popover.offsetHeight - 10, rect.bottom + 6)}px`; state.popoverAnchor = anchor;
}
function showWorkspacePopover(anchor) {
  const active = state.project.settings?.workspace || "default";
  showPopover(anchor, `<div class="popover-title">Panels & layout</div><div class="workspace-grid">${[["default","Default"],["text","Text Editing"],["nle","NLE"],["portrait","Portrait"]].map(([id,label]) => `<button class="${active === id ? "active" : ""}" data-workspace="${id}">${label}</button>`).join("")}</div><div class="popover-divider"></div><button class="popover-item" data-media-jump="assets">My Assets <small>panel</small></button><button class="popover-item" data-media-jump="library">Library <small>panel</small></button><button class="popover-item" data-media-jump="transcript">Transcript <small>panel</small></button>`, 250);
  $$('[data-workspace]').forEach((button) => button.onclick = async () => { await mutate("update_project", { settings: { workspace: button.dataset.workspace } }); applyWorkspace(button.dataset.workspace); $("#contextPopover").hidden = true; });
  $$('[data-media-jump]').forEach((button) => button.onclick = () => { switchMediaTab(button.dataset.mediaJump); $("#contextPopover").hidden = true; });
}
function applyWorkspace(workspace) { document.body.classList.remove("workspace-text","workspace-nle","workspace-portrait"); if (workspace !== "default") document.body.classList.add(`workspace-${workspace}`); setTimeout(renderTimeline, 50); }
function showAspectPopover(anchor) {
  const active = state.project.settings?.aspectRatio || "9:16";
  showPopover(anchor, `<div class="popover-title">Canvas aspect ratio</div>${["16:9","9:16","1:1","4:3","3:4"].map((ratio) => `<button class="popover-item${active === ratio ? " active" : ""}" data-ratio="${ratio}">${ratio}<small>${ratio === "9:16" ? "Reels / Shorts" : ratio === "16:9" ? "Landscape" : "Social"}</small></button>`).join("")}`);
  $$('[data-ratio]').forEach((button) => button.onclick = async () => { const [w,h] = button.dataset.ratio.split(":").map(Number); const height = w < h ? 1920 : w === h ? 1080 : Math.round(1080 * h / w); const width = w < h ? Math.round(1920 * w / h) : w === h ? 1080 : 1920; await mutate("update_project", { width, height, settings: { aspectRatio: button.dataset.ratio } }); $("#contextPopover").hidden = true; });
}
function showAgentSettings(anchor) {
  showPopover(anchor, `<div class="popover-title">Local agent settings</div><div class="switch-row"><span>Thinking mode</span><i class="fake-switch on" data-toggle-switch></i></div><button class="popover-item">Motion graphics quality <small>Balanced</small></button><button class="popover-item">Generation approval <small>Ask first</small></button><div class="popover-divider"></div><button class="popover-item" data-copy-mcp>Copy MCP configuration</button>`, 260);
  $("[data-toggle-switch]").onclick = (event) => event.currentTarget.classList.toggle("on"); $("[data-copy-mcp]").onclick = async () => { await api.copy(JSON.stringify(state.bootstrap.mcpConfig,null,2)); toast("MCP configuration copied", "success"); $("#contextPopover").hidden = true; };
}
function showStylePopover(anchor) {
  const styles = [["Modern Editorial","linear-gradient(135deg,#111827,#6d70e8)"],["Warm Paper","linear-gradient(135deg,#6c4834,#e4b277)"],["Violet Aura","linear-gradient(135deg,#31215d,#a16fe4)"],["Clean Mono","linear-gradient(135deg,#151515,#b8b8b8)"],["Signal Blue","linear-gradient(135deg,#153553,#4ba5dc)"],["High Contrast","linear-gradient(135deg,#050505,#f3cf4f)"]];
  showPopover(anchor, `<div class="popover-title">Design style</div><div class="style-swatches">${styles.map(([name,color]) => `<button class="style-swatch" data-style="${esc(name)}"><i style="--swatch:${color}"></i>${esc(name)}</button>`).join("")}</div>`, 290);
  $$('[data-style]').forEach((button) => button.onclick = async () => { await mutate("update_project", { settings: { designStyle: button.dataset.style } }, `${button.dataset.style} saved`); $("#contextPopover").hidden = true; });
}
function showSkillsPopover(anchor) {
  showPopover(anchor, `<div class="popover-title">AutoEditPost skills</div><button class="popover-item" data-skill="talking">Talking-head guide <small>7 stages</small></button><button class="popover-item" data-skill="captions">Dynamic captions <small>ASS styling</small></button><button class="popover-item" data-skill="motion">Motion graphics <small>V2 layers</small></button><button class="popover-item" data-skill="review">QA reviewer <small>local checks</small></button><div class="popover-divider"></div><button class="popover-item">Save this process as a skill <small>coming next</small></button>`, 270);
  $$('[data-skill]').forEach((button) => button.onclick = () => { setWorkflow(button.dataset.skill); $("#contextPopover").hidden = true; });
}
function showRecordSettings(anchor) {
  showPopover(anchor, `<div class="popover-title">Record</div><button class="popover-item active">Voiceover <small>microphone</small></button><button class="popover-item">Camera <small>video</small></button><button class="popover-item">Screen <small>desktop</small></button><div class="popover-divider"></div><div class="switch-row"><span>3-second countdown</span><i class="fake-switch on"></i></div>`);
}

const fileName = (path = "") => String(path).split(/[\\/]/).pop() || "";
const normalizedPath = (path = "") => String(path).replace(/\\/g, "/").toLowerCase();
const statusName = (value = "ready") => `${String(value).charAt(0).toUpperCase()}${String(value).slice(1)}`;
const hostedNavigation = () => location.protocol === "http:" || location.protocol === "https:";
function parseAppRoute() {
  const parts = location.pathname.split("/").filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
  if (parts[0] === "podcast") return { view: "podcast" };
  if (parts[0] === "batches") return {
    view: "batches", batchId: parts[1] || null,
    reel: parts[2] === "reels" && parts[3] ? String(parts[3]).padStart(2, "0") : null,
    publishing: parts[2] === "publishing",
  };
  return { view: "editor" };
}
function batchUrl(id, suffix = "") { return id ? `/batches/${encodeURIComponent(id)}${suffix}` : "/batches"; }
function setAppUrl(path, { replace = false } = {}) {
  if (!hostedNavigation()) return;
  const target = new URL(path, location.origin);
  if (`${location.pathname}${location.search}` === `${target.pathname}${target.search}`) return;
  history[replace ? "replaceState" : "pushState"]({}, "", `${target.pathname}${target.search}`);
}
function setExecutionGraphHidden(hidden, persist = true) {
  state.executionGraphHidden = Boolean(hidden);
  const section = $("#executionGraphSection"), button = $("#toggleExecutionGraph");
  section?.classList.toggle("collapsed", state.executionGraphHidden);
  if (button) { button.textContent = state.executionGraphHidden ? "Show graph" : "Hide graph"; button.setAttribute("aria-expanded", String(!state.executionGraphHidden)); }
  if (persist) try { localStorage.setItem("localcut:execution-graph-hidden", state.executionGraphHidden ? "1" : "0"); } catch { /* storage can be disabled */ }
}
function renderBatchHistory() {
  const history = $("#batchHistory");
  history.innerHTML = state.pipelines.length ? state.pipelines.map((item) => {
    const progress = Math.round((item.summary?.progress || 0) * 100); const active = item.id === state.pipeline?.id;
    return `<a class="batch-history-card${active ? " active" : ""}" href="${esc(batchUrl(item.id))}" data-pipeline-id="${esc(item.id)}" title="Open this batch at its own URL"><strong>${esc(fileName(item.inputPath) || item.name)}</strong><small>${item.reels} reels · ${new Date(item.updatedAt).toLocaleDateString()}</small><em class="${item.summary?.status === "failed" ? "failed" : ""}">${progress}%</em></a>`;
  }).join("") : `<span class="batch-history-empty">No processed videos yet — the newest Raw video will appear here.</span>`;
  $$('[data-pipeline-id]', history).forEach((button) => button.onclick = async (event) => {
    event.preventDefault(); closeReelReviewer(false); closePublishing(false);
    if (button.dataset.pipelineId !== state.pipeline?.id) state.pipeline = await api.readPipeline(button.dataset.pipelineId);
    renderAutomation(); setAppUrl(batchUrl(button.dataset.pipelineId));
    if (state.pipeline.summary?.status === "running") startPipelinePoll();
  });
}
async function syncCompletedPipeline(run) {
  if (run?.summary?.status !== "completed" || state.syncedPipelineIds.has(run.id)) return;
  const synced = await api.syncPipelineArtifacts(run.id); state.syncedPipelineIds.add(run.id); await refreshProject();
  addAgentMessage(`<strong>TALKING HEADS READY</strong>${synced.imported} source-matched reels are grouped in the Batches workspace with covers, captions, post copy, QA, and editor actions.<div class="message-actions"><button data-message-action="automation">Review finished reels</button></div>`);
}
async function refreshAutomation(preferredId = null) {
  const route = parseAppRoute(); const routedId = hostedNavigation() && route.view === "batches" ? route.batchId : null;
  const selectedId = preferredId || routedId || state.pipeline?.id; const result = await api.listPipelines(); state.pipelines = result.pipelines || [];
  const selected = state.pipelines.find((item) => item.id === selectedId) || (selectedId ? null : state.pipelines[0]);
  state.pipeline = selected ? await api.readPipeline(selected.id) : null; renderAutomation(); await syncCompletedPipeline(state.pipeline);
}
function artifactForReel(reel) { return state.pipeline?.artifacts?.find((item) => String(item.reel).padStart(2,"0") === String(reel).padStart(2,"0")) || null; }
function setReviewGuideVisible(visible) {
  const guide = $("#reviewCaptionGuide"), button = $("#toggleCaptionGuide");
  guide.hidden = !visible; button.classList.toggle("active", visible);
  button.textContent = visible ? "Hide placement preview" : "Preview caption placement";
}
function setReviewCaptionPosition(centerY) {
  const y = Math.max(360, Math.min(1500, Math.round(Number(centerY) || 1450)));
  $("#captionPosition").value = String(y); $("#captionPositionValue").textContent = `${y}px`;
  $("#reviewCaptionGuide").style.top = `${(y / 1920) * 100}%`;
  $$('[data-caption-y]').forEach((button) => button.classList.toggle("active", Number(button.dataset.captionY) === y));
  $("#captionFeedbackState").textContent = y >= 1200 ? "Face-safe lower third" : y <= 600 ? "Upper safe zone" : "Custom position";
}
function setReviewFraming(zoom) {
  const z = Math.max(1, Math.min(1.6, Number(zoom) || 1));
  $("#framingZoom").value = String(z); $("#framingZoomValue").textContent = `${z.toFixed(2)}x`;
  $$('[data-frame-zoom]').forEach((button) => button.classList.toggle("active", Math.abs(Number(button.dataset.frameZoom) - z) < 0.001));
  $("#framingState").textContent = z <= 1 ? "Full frame" : `Punched in ${z.toFixed(2)}x, headroom cropped`;
}
function renderCoverCandidates() {
  const selectedAt = Number(state.reviewCoverAt);
  $("#coverCandidateGrid").innerHTML = state.reviewCoverCandidates.map((candidate) => {
    const active = Number.isFinite(selectedAt) && Math.abs(Number(candidate.atSeconds) - selectedAt) < 0.12;
    return `<button type="button" class="cover-candidate${active ? " active" : ""}" data-cover-at="${Number(candidate.atSeconds)}" aria-label="Choose ${esc(candidate.label)} at ${esc(fmtTime(candidate.atSeconds,true))}"><img src="${esc(candidate.url)}" alt="${esc(candidate.label)}"><span>${esc(candidate.label)} · ${esc(fmtTime(candidate.atSeconds,true))}</span>${candidate.current ? "<em>Current</em>" : ""}</button>`;
  }).join("");
  $$('[data-cover-at]').forEach((button) => button.onclick = () => {
    const at = Number(button.dataset.coverAt); const candidate = state.reviewCoverCandidates.find((item) => Math.abs(Number(item.atSeconds) - at) < 0.01);
    state.reviewCoverAt = at; renderCoverCandidates();
    if (candidate?.url) $("#reviewCover").src = candidate.url;
    const video = $("#reviewVideo"); video.pause(); if (Number.isFinite(video.duration)) video.currentTime = Math.min(at, Math.max(0, video.duration - 0.05));
    $("#coverFeedbackState").textContent = `Selected ${fmtTime(at,true)} · add lettering below`;
  });
}
async function loadCoverCandidates(item, selectedAt = null) {
  const request = ++state.reviewCoverRequest; const reel = state.reviewReel;
  $("#coverCandidatesState").textContent = "Finding clean, caption-free frames…"; $("#coverCandidateGrid").innerHTML = "";
  try {
    const result = await api.getCoverCandidates(state.pipeline.id, reel, selectedAt);
    if (request !== state.reviewCoverRequest || reel !== state.reviewReel) return;
    state.reviewCoverAt = Number(result.selectedAt); state.reviewCoverCandidates = result.candidates || [];
    $("#coverCandidatesState").textContent = `${state.reviewCoverCandidates.length} clean choices · click the smile or expression you want`;
    renderCoverCandidates();
  } catch (error) {
    if (request !== state.reviewCoverRequest) return;
    state.reviewCoverCandidates = []; $("#coverCandidatesState").textContent = `Frame choices unavailable: ${error.message || String(error)}`;
  }
}
function seoFromFields() {
  const split = (value) => String(value || "").split(/[,\n]+/).map((item) => item.trim()).filter(Boolean);
  return { primaryPhrase: $("#seoPrimary").value.trim(), related: split($("#seoRelated").value), hashtags: String($("#seoHashtags").value || "").split(/[\s,]+/).filter(Boolean) };
}
function updateSeoPreview() {
  const seo = seoFromFields();
  $("#seoKeywordPreview").innerHTML = [seo.primaryPhrase, ...seo.related].filter(Boolean).map((keyword, index) => `<span class="${index === 0 ? "primary" : ""}">${esc(keyword)}</span>`).join("");
}
function setReviewSeo(seo = {}) {
  $("#seoPrimary").value = seo.primaryPhrase || ""; $("#seoRelated").value = (seo.related || []).join(", "); $("#seoHashtags").value = (seo.hashtags || []).join(" ");
  $("#seoFeedbackState").textContent = seo.primaryPhrase ? `${(seo.keywords || [seo.primaryPhrase, ...(seo.related || [])]).length} attached terms` : "Needs keywords";
  updateSeoPreview();
}
function technicalApprovalReady(item) { return Boolean(item?.exists && item?.coverExists && item?.captionExists && item?.seoExists && item?.qa?.ok && item?.approvalRevision); }
function markApprovalPending(item, invalidatedBy) {
  if (!item) return;
  item.approval = { ...(item.approval || {}), status: "pending", approved: false, stale: false, approvedAt: null, invalidatedAt: new Date().toISOString(), invalidatedBy };
  if (item.review?.approval) item.review.approval = { ...item.review.approval, status: "pending", approvedAt: null, invalidatedAt: item.approval.invalidatedAt, invalidatedBy };
  if (state.reviewReel === String(item.reel).padStart(2, "0")) renderReviewApproval(item);
}
function renderReviewApproval(item) {
  const approval = item?.approval || {}; const bar = $("#reviewApprovalBar"), button = $("#approveReviewReel");
  bar.className = `review-approval-bar${approval.approved ? " approved" : approval.stale || approval.status === "expired" ? " expired" : ""}`;
  if (approval.approved) {
    $("#reviewApprovalState").textContent = "Approved for Postiz";
    $("#reviewApprovalDetail").textContent = `This exact video, cover, captions, and SEO package is approved${approval.approvedAt ? ` · ${new Date(approval.approvedAt).toLocaleString()}` : ""}.`;
    button.textContent = "Revoke approval";
  } else if (approval.stale || approval.status === "expired") {
    $("#reviewApprovalState").textContent = "Approval expired after a change";
    $("#reviewApprovalDetail").textContent = "Review the updated reel and approve the new version before scheduling.";
    button.textContent = "Approve updated reel";
  } else {
    $("#reviewApprovalState").textContent = "Approval required";
    $("#reviewApprovalDetail").textContent = technicalApprovalReady(item) ? "Watch the reel, check the cover and captions, then approve this exact version." : "Passing QA, final video, cover, captions, and SEO are required first.";
    button.textContent = "Approve reel for scheduling";
  }
  button.disabled = state.pipeline?.summary?.status === "running" || (!approval.approved && !technicalApprovalReady(item));
}
function openReelReviewer(reel, forceReload = false, updateUrl = true) {
  const item = artifactForReel(reel); if (!item?.exists) return toast(`Reel ${reel} is not rendered yet`, "error");
  state.reviewReel = String(reel).padStart(2,"0"); const qa = item.qa || {}; const brief = item.brief || {}; const review = item.review || {};
  if (updateUrl && state.pipeline?.id) setAppUrl(batchUrl(state.pipeline.id, `/reels/${encodeURIComponent(state.reviewReel)}`));
  $("#reelReviewer").hidden = false; $("#reviewerTitle").textContent = `${state.reviewReel} · ${brief.title || item.label}`;
  $("#reviewerMeta").textContent = `${fmtDuration(qa.media?.duration)} · ${qa.ok ? "QA passed" : "Needs review"} · play the finished reel below`;
  const video = $("#reviewVideo");
  setReviewGuideVisible(false);
  if (forceReload || video.dataset.reel !== state.reviewReel || video.src !== item.videoUrl) { video.pause(); video.src = item.videoUrl; video.dataset.reel = state.reviewReel; video.load(); }
  $("#reviewCover").src = item.coverUrl || ""; $("#coverFeedback").value = review.cover?.feedback || "";
  const coverCopy = brief.coverCopy || {}; $("#coverKicker").value = coverCopy.kicker || ""; $("#coverAccent").value = coverCopy.accent || ""; $("#coverHeadline").value = coverCopy.headline || "";
  const defaultCoverAt = Number(review.cover?.atSeconds ?? Number(qa.media?.duration || 0) * .78); state.reviewCoverAt = Number.isFinite(defaultCoverAt) ? defaultCoverAt : 0; state.reviewCoverCandidates = [];
  $("#coverFeedbackState").textContent = Number.isFinite(Number(review.cover?.atSeconds)) ? `Frame at ${fmtTime(review.cover.atSeconds,true)}` : "Current cover";
  loadCoverCandidates(item, state.reviewCoverAt);
  setReviewSeo(brief.seo || qa.seo || {});
  $("#captionFeedback").value = review.captions?.feedback || ""; setReviewCaptionPosition(review.captions?.centerY ?? 1450);
  $("#framingFeedback").value = review.framing?.feedback || ""; setReviewFraming(review.framing?.zoom ?? brief.frameZoom ?? 1);
  const sample = String(brief.title || "Readable captions").toUpperCase().split(/\s+/).slice(0,3); $("#reviewCaptionGuide").innerHTML = sample.map((word,index) => index === sample.length - 1 ? `<b>${esc(word)}</b>` : `<span>${esc(word)}</span>`).join(" ");
  const index = state.pipeline.reels.indexOf(state.reviewReel); const slider = $("#reviewReelSlider");
  slider.min = "1"; slider.max = String(Math.max(1, state.pipeline.reels.length)); slider.value = String(Math.max(1, index + 1)); slider.disabled = state.pipeline.reels.length < 2;
  $("#reviewReelTicks").innerHTML = state.pipeline.reels.map((candidate, reelIndex) => `<option value="${reelIndex + 1}" label="${esc(candidate)}"></option>`).join("");
  $("#reviewReelSliderValue").textContent = `Reel ${state.reviewReel} of ${state.pipeline.reels.length}`;
  $("#previousReviewReel").disabled = index <= 0; $("#nextReviewReel").disabled = index < 0 || index >= state.pipeline.reels.length - 1;
  const running = state.pipeline.summary?.status === "running"; $("#regenerateCover").disabled = running; $("#saveSeoPackage").disabled = running; $("#redoCaptions").disabled = running; $("#applyFraming").disabled = running;
  renderReviewApproval(item);
  $("#redoCaptions").textContent = state.reviewRerendering === state.reviewReel ? "Rendering face-safe captions…" : "Redo captions and final video";
  if (state.reviewRerendering !== state.reviewReel) $("#applyFraming").textContent = "Apply framing and rebuild reel";
}
function closeReelReviewer(updateUrl = true) {
  const wasOpen = !$("#reelReviewer").hidden; $("#reviewVideo").pause(); setReviewGuideVisible(false); $("#reelReviewer").hidden = true; state.reviewReel = null; state.reviewRerendering = null; state.reviewCoverAt = null; state.reviewCoverCandidates = []; state.reviewCoverRequest += 1;
  if (updateUrl && wasOpen && state.pipeline?.id) setAppUrl(batchUrl(state.pipeline.id));
}
async function ensureReelAsset(reel) {
  const artifact = artifactForReel(reel); if (!artifact?.exists) throw new Error(`Reel ${reel} is not rendered yet`);
  let asset = Object.values(state.project.assets).find((candidate) => normalizedPath(candidate.path) === normalizedPath(artifact.video));
  if (!asset) { asset = await api.editorCall("import_asset", { filePath: artifact.video, name: artifact.brief?.title || artifact.filename, kind: "talking-head" }); await refreshProject(); }
  return state.project.assets[asset.id] || asset;
}
async function reviewReel(reel, addToTimeline = false) {
  if (!addToTimeline) return openReelReviewer(reel);
  try { const asset = await ensureReelAsset(reel); await addAssetToTimeline(asset.id); closeAutomation(); }
  catch (error) { toast(error.message || String(error), "error"); }
}
function renderAutomation() {
  const run = state.pipeline; const status = $("#automationStatus"), graph = $("#automationGraph"), gallery = $("#qaGallery"), sourceStrip = $("#batchSourceStrip");
  renderBatchHistory();
  if (!run) {
    status.innerHTML = `<div><h3>No video batch selected</h3><p>Add one source video, teleprompter, and edit sheet to Raw, then process it.</p></div><strong class="pipeline-percent">0%</strong>`;
    sourceStrip.innerHTML = `<span class="batch-source-empty">Source video + teleprompter + edit instructions will be grouped here.</span>`;
    graph.innerHTML = `<div class="transcript-empty">Process the latest Raw batch to create its resumable graph.</div>`; gallery.innerHTML = ""; $("#qaSummary").textContent = "Local technical QA";
  } else {
    const percent = Math.round((run.summary?.progress || 0) * 100); const batch = run.batch || {}; const source = batch.source || {};
    status.innerHTML = `<div><h3>${esc(batch.name || run.name)}</h3><p>${esc(source.name || fileName(run.config?.inputPath))} · ${run.reels.length} reels · ${run.summary.completed}/${run.summary.nodes} nodes · ${statusName(run.summary.status)}</p></div><strong class="pipeline-percent">${percent}%</strong>`;
    const documentChips = (batch.documents || []).map((document,index) => `<button class="batch-file-chip ${/manifest|spec/i.test(document.role) ? "manifest" : "document"}" data-batch-document="${index}" title="Open ${esc(document.path)}"><i>${/manifest|spec/i.test(document.role) ? "JSON" : "DOC"}</i><strong>${esc(document.role)}</strong><span>${esc(document.name)} · ${fmtBytes(document.bytes)}</span></button>`).join("");
    sourceStrip.innerHTML = `<button class="batch-file-chip source" data-batch-source title="Show source video"><i>MP4</i><strong>Source video</strong><span>${esc(source.name)} · ${fmtBytes(source.bytes)}</span></button>${documentChips}`;
    const byId = new Map(run.nodes.map((node) => [node.id,node]));
    graph.innerHTML = `<div class="pipeline-grid"><div class="pipeline-row head"><span>Reel</span>${pipelineStages.map((stage) => `<span>${stage.slice(0,3)}</span>`).join("")}</div>${run.reels.map((reel) => `<div class="pipeline-row"><span>${esc(reel)}</span>${pipelineStages.map((stage) => { const node = byId.get(`${reel}:${stage}`) || {status:"pending"}; return `<span class="pipeline-cell ${esc(node.status)}" title="${esc(`${statusName(stage)}: ${node.error || statusName(node.status)}`)}"><i></i></span>`; }).join("")}</div>`).join("")}</div>`;
    const artifacts = run.artifacts || []; const passed = artifacts.filter((item) => item.exists && item.qa?.ok).length; const approved = artifacts.filter((item) => item.approval?.approved).length;
    $("#qaSummary").textContent = `${passed}/${run.reels.length} passed QA · ${approved}/${run.reels.length} approved · ${artifacts.filter((item) => item.coverExists).length} covers · ${artifacts.filter((item) => item.seoExists).length} SEO packages`;
    gallery.innerHTML = run.reels.map((reel) => {
      const item = artifacts.find((artifact) => String(artifact.reel).padStart(2,"0") === String(reel).padStart(2,"0")); const qa = item?.qa; const brief = item?.brief || {}; const warnings = qa?.warnings || []; const errors = qa?.errors || [];
      const nodes = pipelineStages.map((stage) => byId.get(`${reel}:${stage}`) || { status: "pending" }); const reelStatus = nodes.find((node) => node.status === "failed") ? "failed" : nodes.find((node) => node.status === "running") ? "running" : qa?.ok ? "completed" : "pending";
      const postCaption = brief.postCaption || qa?.postCaption || "Post caption is prepared after analysis"; const pinned = brief.keyword?.pinnedComment || qa?.pinnedComment || "Pinned comment is prepared after analysis"; const confidence = Number(brief.confidence ?? qa?.sourceMatchConfidence); const seo = brief.seo || qa?.seo || {};
      const approval = item?.approval || {}; const readyForPostiz = Boolean(item?.exists && item?.coverExists && item?.captionExists && item?.seoExists && qa?.ok && postCaption && seo.primaryPhrase && approval.approved);
      return `<article class="batch-reel-row ${reelStatus === "failed" ? "failed" : ""}${approval.approved ? " approved" : approval.stale ? " approval-expired" : ""}" data-reel-row="${esc(reel)}">
        <div class="reel-cover">${item?.coverExists ? `<img src="${esc(item.coverUrl)}" alt="Cover for reel ${esc(reel)}">` : item?.exists ? `<video muted preload="metadata" src="${esc(item.videoUrl)}#t=4"></video>` : `<b>…</b>`}<span>REEL ${esc(reel)}</span></div>
        <div class="reel-summary"><h3>${esc(brief.title || item?.label || `Reel ${reel}`)}</h3><div class="reel-meta"><span>${fmtDuration(qa?.media?.duration || brief.targetSeconds)}</span><span class="${qa?.ok ? "pass" : errors.length ? "fail" : "warn"}">${qa?.ok ? "QA pass" : errors.length ? `${errors.length} errors` : statusName(reelStatus)}</span>${Number.isFinite(confidence) ? `<span>${Math.round(confidence * 100)}% source match</span>` : ""}${readyForPostiz ? `<span class="pass">Approved · Postiz ready</span>` : `<span class="${approval.stale ? "fail" : "warn"}">${approval.stale ? "Approval expired" : "Approval required"}</span>`}</div><p>${esc(brief.watchFor || warnings[0] || "Source-matched talking-head edit with local technical checks.")}</p></div>
        <div class="reel-creative"><label>Creative brief</label><strong>${esc(brief.overlay || "Overlay appears after analysis")}</strong><p>${esc(brief.keyword?.word ? `Engagement gate: ${brief.keyword.word}` : "No engagement keyword specified")}</p><div class="reel-stage-strip">${pipelineStages.map((stage,index) => `<span class="reel-stage ${esc(nodes[index].status)}" title="${esc(`${statusName(stage)}: ${nodes[index].error || statusName(nodes[index].status)}`)}">${stage.slice(0,3)}</span>`).join("")}</div></div>
        <div class="reel-deliverables"><label>Deliverables</label><div class="deliverable-grid"><button class="deliverable-chip ${item?.captionExists ? "ready" : "missing"}" data-deliverable="captions" data-reel="${esc(reel)}" ${item?.captionExists ? "" : "disabled"}>Captions</button><button class="deliverable-chip ${item?.coverExists ? "ready" : "missing"}" data-deliverable="cover" data-reel="${esc(reel)}" ${item?.coverExists ? "" : "disabled"}>Cover photo</button><button class="deliverable-chip ${item?.seoExists ? "ready" : "missing"}" data-deliverable="seo" data-reel="${esc(reel)}" ${item?.seoExists ? "" : "disabled"}>SEO</button><button class="deliverable-chip ${item?.exists ? "ready" : "missing"}" data-deliverable="final" data-reel="${esc(reel)}" ${item?.exists ? "" : "disabled"}>Final reel</button></div><div class="reel-seo"><b>SEO:</b> ${esc([seo.primaryPhrase, ...(seo.related || [])].filter(Boolean).join(" · ") || "Open Review reel to prepare keywords")}</div><div class="post-copy"><b>Post:</b> ${esc(postCaption)} ${esc((seo.hashtags || []).join(" "))}</div><div class="post-copy"><b>Pinned:</b> ${esc(pinned)}</div></div>
        <div class="reel-actions"><button class="review-reel ${approval.approved ? "approval-complete" : "approval-needed"}" data-review-reel="${esc(reel)}" ${item?.exists ? "" : "disabled"}>${approval.approved ? "Approved · review again" : "Review & approve"}</button><button data-edit-reel="${esc(reel)}" ${item?.exists ? "" : "disabled"}>Edit on timeline</button><div><button data-reveal-reel="${esc(reel)}" ${item?.exists ? "" : "disabled"}>Folder</button><button data-copy-post="${esc(reel)}">Copy post</button></div><select aria-label="Rerun reel ${esc(reel)} from stage">${pipelineStages.map((stage) => `<option value="${stage}">${statusName(stage)}</option>`).join("")}</select><button class="rerun-reel" data-rerun-reel="${esc(reel)}" ${run.summary.status === "running" ? "disabled" : ""}>Rerun from stage</button></div>
      </article>`;
    }).join("") || `<div class="transcript-empty">Reels appear here as soon as the batch is analyzed.</div>`;
    $("[data-batch-source]")?.addEventListener("click", () => source.path && api.reveal(source.path));
    $$('[data-batch-document]').forEach((button) => button.onclick = () => api.open(batch.documents[Number(button.dataset.batchDocument)].path));
  }
  if (hostedNavigation() && parseAppRoute().view === "batches") document.title = `${run?.batch?.name || run?.name || "Batches"} — LocalCut`;
  const runStatus = run?.summary?.status; $("#retryBatch").hidden = runStatus !== "failed"; $("#cancelBatch").hidden = runStatus !== "running"; $("#rebuildBatch").disabled = !run || runStatus === "running"; $("#regenerateAllCovers").disabled = !run || runStatus === "running"; $("#redoAllCaptions").disabled = !run || runStatus === "running"; $("#openBatchFolder").disabled = !run; $("#copyBatchLink").disabled = !run; $("#openPublishing").disabled = !run; $("#runDefaultBatch").disabled = runStatus === "running" || state.batchStarting;
  $$('[data-review-reel]').forEach((button) => button.onclick = () => reviewReel(button.dataset.reviewReel));
  $$('[data-edit-reel]').forEach((button) => button.onclick = () => reviewReel(button.dataset.editReel, true));
  $$('[data-reveal-reel]').forEach((button) => button.onclick = () => { const item = artifactForReel(button.dataset.revealReel); if (item?.workDir) api.open(item.workDir); });
  $$('[data-copy-post]').forEach((button) => button.onclick = async () => { const item = artifactForReel(button.dataset.copyPost); const post = item?.brief?.postCaption || item?.qa?.postCaption || ""; const pinned = item?.brief?.keyword?.pinnedComment || item?.qa?.pinnedComment || ""; const seo = item?.brief?.seo || item?.qa?.seo || {}; const hashtags = (seo.hashtags || []).join(" "); await api.copy(`${post}${hashtags ? `\n\n${hashtags}` : ""}${pinned ? `\n\nPinned comment: ${pinned}` : ""}`); toast(`Reel ${button.dataset.copyPost} Postiz package copied`, "success"); });
  $$('[data-deliverable]').forEach((button) => button.onclick = () => { const item = artifactForReel(button.dataset.reel); if (!item) return; if (button.dataset.deliverable === "final") reviewReel(button.dataset.reel); else api.open(button.dataset.deliverable === "cover" ? item.cover : button.dataset.deliverable === "seo" ? item.seoPath : item.caption); });
  $$('[data-rerun-reel]').forEach((button) => button.onclick = async () => { const stage = button.previousElementSibling.value; try { button.disabled = true; await api.rerunReel(run.id, button.dataset.rerunReel, stage); toast(`Reel ${button.dataset.rerunReel} restarting at ${stage}`, "success"); await refreshAutomation(); startPipelinePoll(); } catch (error) { toast(error.message || String(error), "error"); button.disabled = false; } });
}
function selectedPublishValues(selector, attribute) { return $$(selector).filter((input) => input.checked && !input.disabled).map((input) => input.dataset[attribute]); }
function publishOptionsFromFields() {
  return {
    startDate: $("#publishStartDate").value,
    reelTimes: $("#publishReelTimes").value.split(",").map((value) => value.trim()).filter(Boolean),
    carouselTime: $("#publishCarouselTime").value.trim(), timeZone: $("#publishTimeZone").value,
    platforms: selectedPublishValues("[data-publish-platform]", "publishPlatform"),
    reelIds: selectedPublishValues("[data-publish-reel]", "publishReel"),
    carouselIds: selectedPublishValues("[data-publish-carousel]", "publishCarousel"),
    allowPreviouslyScheduled: $("#allowScheduledCarousels").checked,
  };
}
function renderPublishingConnection() {
  const connection = state.publishSnapshot?.connection || {}; const element = $("#publishingConnection");
  element.classList.toggle("connected", Boolean(connection.configured));
  element.innerHTML = `<i></i><span>${connection.configured ? "Postiz connected" : "Postiz connection required"}</span>`;
  $("#postizApiUrl").value = connection.apiUrl || "https://api.postiz.com/public/v1";
  $("#postizApiKey").placeholder = connection.configured ? "Encrypted key saved; leave blank to keep it" : "Paste once; Windows stores it encrypted";
  $("#postizConnectionNote").textContent = connection.configured ? "The API key is encrypted and hidden." : "Add the API key once; it is never written as plain text.";
}
function renderPublishingPlan(plan = state.publishPlan) {
  state.publishPlan = plan || null; const rows = $("#publishQueueRows"), summary = $("#publishQueueSummary");
  if (!plan) {
    rows.innerHTML = `<tr><td colspan="5" class="queue-empty">No plan built yet.</td></tr>`;
    summary.innerHTML = `<div><span>LOCAL PREVIEW</span><h3>Build the exact queue</h3><p>Select reels, carousel decks, platforms, and a start date. The preview does not publish.</p></div><strong>0 posts</strong>`;
  } else {
    const itemRows = plan.items.map((item) => {
      const times = uniqueStrings(item.deliveries.map((delivery) => delivery.platform === "tiktok"
        ? `TikTok ${delivery.localTime} ET (1h lead)`
        : `${new Date(delivery.scheduledAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: item.timeZone })} ET`));
      const packageProof = item.kind === "carousel" ? "Native carousel" : item.assets?.exactReviewedCover
        ? `Exact reviewed cover applied · ${(Number(item.assets.coverProof?.coverSimilarity || 0) * 100).toFixed(1)}% verified · video starts at 0:00`
        : "Cover required";
      return `<tr><td><strong>${esc(item.title)}</strong><span>${esc(item.kind === "carousel" ? item.id.toUpperCase() : `Reel ${item.id}`)}</span></td><td><strong>${item.assetCount} ${item.kind === "carousel" ? "slides" : "video"}</strong><span>${esc(packageProof)}</span></td><td><strong>${esc(item.date)} ${esc(item.time)}</strong><span>${esc(times.join(" · "))} ET</span></td><td><div class="queue-platforms">${item.platforms.map((platform) => `<i>${esc(platformLabels[platform] || platform)}</i>`).join("")}</div></td><td><strong class="queue-status">Ready</strong><span>${item.kind === "reel" ? "Exact cover locked" : "Local plan only"}</span></td></tr>`;
    }).join("");
    rows.innerHTML = itemRows;
    summary.innerHTML = `<div><span>SAVED LOCAL PREVIEW</span><h3>${plan.summary.items} publishing packages</h3><p>${plan.summary.reels} reels · ${plan.summary.carousels} carousels · ${plan.summary.platforms.map((platform) => platformLabels[platform] || platform).join(", ")}</p></div><strong>${plan.summary.posts} posts</strong>`;
  }
  const configured = Boolean(state.publishSnapshot?.connection?.configured); $("#commitPostizPlan").disabled = !plan || !configured || state.publishingBusy; $("#revealPostizPlan").disabled = !plan;
}
function uniqueStrings(values) { return [...new Set(values)]; }
function renderPublishingAssets() {
  const snapshot = state.publishSnapshot; if (!snapshot) return;
  const defaults = snapshot.defaults || {}; if (!$("#publishStartDate").value) $("#publishStartDate").value = defaults.startDate || "";
  $("#publishReelTimes").value = (defaults.reelTimes || ["09:00","18:00"]).join(", "); $("#publishCarouselTime").value = defaults.carouselTime || "13:00";
  $("#publishPlatforms").innerHTML = (snapshot.connection?.platforms || []).map((platform) => `<label><input type="checkbox" data-publish-platform="${esc(platform.id)}" ${defaults.platforms?.includes(platform.id) ? "checked" : ""}><span>${esc(platform.label)}</span></label>`).join("");
  const readyReels = snapshot.reels.filter((item) => item.ready).length; const technicalReels = snapshot.reels.filter((item) => item.technicalReady).length;
  $("#publishReelCount").textContent = `${readyReels}/${snapshot.reels.length} approved · ${technicalReels} technically ready`;
  $("#publishReelList").innerHTML = snapshot.reels.map((item) => {
    const status = item.ready ? "Approved · video · cover · captions · SEO" : item.technicalReady ? item.approval?.stale ? "Approval expired after changes" : "Approval required in Review reel" : "Package incomplete";
    const title = item.ready ? "Include this approved reel in the schedule" : item.technicalReady ? "Review and approve this reel before scheduling" : "This reel is missing a required deliverable";
    return `<label class="publish-asset${item.ready ? "" : " not-ready"}${item.technicalReady && !item.ready ? " approval-required" : ""}" title="${esc(title)}"><input type="checkbox" data-publish-reel="${esc(item.id)}" ${item.ready ? "checked" : "disabled"}><img src="${esc(item.coverUrl || "")}" alt=""><div><strong>${esc(item.id)} · ${esc(item.title)}</strong><span class="${item.ready ? "" : "approval-label"}">${esc(status)}</span></div></label>`;
  }).join("");
  renderPublishingCarousels();
}
function renderPublishingCarousels() {
  const snapshot = state.publishSnapshot; if (!snapshot) return; const allow = $("#allowScheduledCarousels").checked;
  const previously = snapshot.carousels.filter((item) => item.scheduledBefore).length; const available = snapshot.carousels.filter((item) => item.ready && (allow || !item.scheduledBefore)).length;
  $("#publishCarouselCount").textContent = `${snapshot.carousels.length} local carousel decks`;
  $("#carouselLibrarySummary").textContent = `${snapshot.carousels.reduce((sum,item) => sum + item.slideCount, 0)} rendered slides · ${previously} decks have prior Postiz records · ${available} selectable now`;
  $("#publishCarouselList").innerHTML = snapshot.carousels.map((item) => {
    const blocked = item.scheduledBefore && !allow; return `<label class="carousel-choice${item.scheduledBefore ? " scheduled" : ""}" title="${esc(item.title)}"><input type="checkbox" data-publish-carousel="${esc(item.id)}" ${blocked || !item.ready ? "disabled" : ""}><img src="${esc(item.previewUrl)}" alt="Carousel ${esc(item.id)} preview"><div><strong>${esc(item.id.toUpperCase())}</strong><span>${item.slideCount} slides</span></div>${item.scheduledBefore ? "<em>Prior record</em>" : ""}</label>`;
  }).join("");
}
function renderActiveSchedule() {
  const schedule = state.activeSchedule; const rows = $("#activeScheduleRows"), summary = $("#activeScheduleSummary");
  $$("[data-schedule-filter]").forEach((button) => button.classList.toggle("active", button.dataset.scheduleFilter === state.activeScheduleFilter));
  if (!schedule) {
    summary.innerHTML = `<div><strong>&mdash;</strong><span>Scheduled</span></div><div><strong>&mdash;</strong><span>Reels</span></div><div><strong>&mdash;</strong><span>Carousels</span></div><div><strong>&mdash;</strong><span>Unmatched</span></div>`;
    rows.innerHTML = `<tr><td colspan="5" class="active-schedule-empty">Connect Postiz and refresh to see the live calendar.</td></tr>`; return;
  }
  const data = schedule.summary || {};
  summary.innerHTML = `<div><strong>${Number(data.scheduled || 0)}</strong><span>Scheduled posts</span></div><div><strong>${Number(data.scheduledReels || 0)}</strong><span>Scheduled reels</span></div><div><strong>${Number(data.scheduledCarousels || 0)}</strong><span>Scheduled carousels</span></div><div><strong>${Number(data.scheduledOther || 0)}</strong><span>Other / unmatched</span></div>`;
  const zone = schedule.timeZone || "America/New_York", checked = new Date(schedule.checkedAt);
  const next = data.nextAt ? new Date(data.nextAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone }) : null;
  $("#activeScheduleNote").textContent = `${data.tracked || 0}/${data.total || 0} posts matched to local reel or carousel records \u00b7 checked ${checked.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${next ? ` \u00b7 next ${next} ET` : " \u00b7 no future posts in this window"}`;
  const filtered = (schedule.posts || []).filter((item) => state.activeScheduleFilter === "all" || item.kind === state.activeScheduleFilter);
  if (!filtered.length) { rows.innerHTML = `<tr><td colspan="5" class="active-schedule-empty">No ${state.activeScheduleFilter === "all" ? "posts" : `${state.activeScheduleFilter} posts`} in this calendar window.</td></tr>`; return; }
  const stateLabel = { scheduled: "Scheduled", published: "Published", "past-unverified": "Past / check" };
  rows.innerHTML = filtered.map((item) => {
    const at = new Date(item.publishDate); const day = at.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: zone });
    const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: zone });
    const identity = item.itemId ? `${item.kind === "reel" ? "Reel" : "Carousel"} ${String(item.itemId).toUpperCase()}` : item.tracked ? "Matched locally" : "Postiz-only item";
    return `<tr><td class="active-schedule-time"><strong>${esc(day)}</strong><span>${esc(time)} ET</span></td><td class="active-schedule-content"><strong>${esc(item.title)}</strong><span>${esc(identity)}${item.batchName ? ` &middot; ${esc(item.batchName)}` : ""}</span></td><td><span class="schedule-kind ${esc(item.kind)}">${esc(item.kind === "other" ? "Other" : item.kind)}</span></td><td class="active-schedule-channel"><strong>${esc(item.platformLabel || item.platform)}</strong><span>${esc(item.channel || "Connected channel")}</span></td><td><span class="schedule-state ${esc(item.status)}">${esc(stateLabel[item.status] || item.status)}</span></td></tr>`;
  }).join("");
}
async function refreshActiveSchedule(showToast = true) {
  if (state.activeScheduleLoading) return; const button = $("#refreshActiveSchedule");
  if (!state.publishSnapshot?.connection?.configured) { state.activeSchedule = null; $("#activeScheduleNote").textContent = "Connect Postiz to pull the live calendar."; return renderActiveSchedule(); }
  state.activeScheduleLoading = true; button.disabled = true; button.textContent = "Pulling schedule..."; $("#activeScheduleNote").textContent = "Reading the live Postiz calendar without changing anything...";
  try {
    state.activeSchedule = await api.getActivePostizSchedule({ daysBefore: 2, daysAhead: Number($("#activeScheduleRange").value || 30) }); renderActiveSchedule();
    if (showToast) toast(`${state.activeSchedule.summary.scheduled} scheduled posts pulled from Postiz`, "success");
  } catch (error) {
    $("#activeScheduleNote").textContent = `Live calendar unavailable: ${error.message || String(error)}`;
    $("#activeScheduleRows").innerHTML = `<tr><td colspan="5" class="active-schedule-empty">${esc(error.message || String(error))}</td></tr>`;
    if (showToast) toast(error.message || String(error), "error");
  } finally { state.activeScheduleLoading = false; button.disabled = false; button.textContent = "Refresh schedule"; }
}
async function refreshPublishing() {
  if (!state.pipeline) throw new Error("Choose a video batch first");
  state.publishSnapshot = await api.getPublishing(state.pipeline.id); state.publishPlan = state.publishSnapshot.savedPlan || null;
  renderPublishingConnection(); renderPublishingAssets(); renderPublishingPlan();
}
async function openPublishing(updateUrl = true) {
  if (!state.pipeline) return toast("Choose a video batch first", "error");
  closeReelReviewer(false); if (updateUrl) setAppUrl(batchUrl(state.pipeline.id, "/publishing")); $("#publishingHub").hidden = false; $("#publishingProof").className = "publishing-proof"; $("#publishingProof").innerHTML = `<strong>Loading local packages...</strong><span>Scanning reels, carousel slides, and prior schedule records.</span>`;
  try { await refreshPublishing(); $("#publishingProof").innerHTML = `<strong>Nothing has been sent.</strong><span>${state.publishSnapshot.reels.length} reels and ${state.publishSnapshot.carousels.length} carousel decks were inspected locally.</span>`; await refreshActiveSchedule(false); }
  catch (error) { $("#publishingProof").classList.add("error"); $("#publishingProof").innerHTML = `<strong>Publishing workspace could not load.</strong><span>${esc(error.message || String(error))}</span>`; toast(error.message || String(error), "error"); }
}
function closePublishing(updateUrl = true) { const wasOpen = !$("#publishingHub").hidden; closeScheduleConfirmation(); $("#publishingHub").hidden = true; if (updateUrl && wasOpen && state.pipeline?.id) setAppUrl(batchUrl(state.pipeline.id)); }
async function buildPostizPreview() {
  const button = $("#buildPostizPlan"); button.disabled = true; button.textContent = "Building local preview...";
  try { const plan = await api.buildPostizPlan(state.pipeline.id, publishOptionsFromFields()); renderPublishingPlan(plan); $("#publishingProof").className = "publishing-proof"; $("#publishingProof").innerHTML = `<strong>Preview saved. Nothing was sent.</strong><span>${plan.summary.posts} exact platform posts are recorded in postiz-plan.json.</span>`; toast(`${plan.summary.posts}-post schedule preview saved locally`, "success"); }
  catch (error) { $("#publishingProof").className = "publishing-proof error"; $("#publishingProof").innerHTML = `<strong>Preview needs attention.</strong><span>${esc(error.message || String(error))}</span>`; toast(error.message || String(error), "error"); }
  finally { button.disabled = false; button.textContent = "Build schedule preview"; }
}
function closeScheduleConfirmation() {
  const modal = $("#scheduleConfirmModal"); if (!modal) return; modal.hidden = true; modal.dataset.planId = "";
  $("#scheduleConfirmText").value = ""; $("#startPostizSchedule").disabled = true;
}
function openScheduleConfirmation() {
  const plan = state.publishPlan;
  if (!plan) return toast("Build a schedule preview first", "error");
  if (state.publishingBusy) return toast("Postiz scheduling is already running");
  if (!state.publishSnapshot?.connection?.configured) return toast("Connect Postiz before scheduling", "error");
  const zone = plan.options?.timeZone || "America/New_York";
  const dateOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone };
  const first = new Date(plan.summary.firstAt).toLocaleString([], dateOptions);
  const last = new Date(plan.summary.lastAt).toLocaleString([], dateOptions);
  const platforms = (plan.summary.platforms || []).map((platform) => platformLabels[platform] || platform).join(", ");
  $("#scheduleConfirmSummary").innerHTML = `<div><strong>${plan.summary.reels}</strong><span>Approved reels</span></div><div><strong>${plan.summary.carousels}</strong><span>Carousel decks</span></div><div><strong>${plan.summary.posts}</strong><span>Platform posts</span></div><div><strong>~${plan.summary.estimatedCreateMinutes} min</strong><span>Safe paced run</span></div>`;
  $("#scheduleConfirmWindow").innerHTML = `<div><span>Schedule window</span><strong>${esc(first)} ET &rarr; ${esc(last)} ET</strong></div><div><span>Channels</span><strong>${esc(platforms)}</strong></div><div><span>Timing rules</span><strong>Reels ${esc(plan.policy.reelTimes.join(" + "))} ET &middot; TikTok ${plan.policy.tiktokLeadMinutes} min earlier${plan.summary.carousels ? ` &middot; carousels ${esc(plan.policy.carouselTime)} ET` : ""}</strong></div>`;
  const warning = $("#scheduleConfirmWarning"); warning.className = `schedule-confirm-warning${plan.summary.carousels ? "" : " attention"}`;
  warning.innerHTML = plan.summary.carousels
    ? `<strong>Keep LocalCut open</strong><span>Postiz requests are intentionally paced to protect the schedule. Progress will remain visible here.</span>`
    : `<strong>No carousels are included</strong><span>This plan contains reels only. Cancel and rebuild the preview if carousel decks should be part of this run. Keep LocalCut open for the full ${plan.summary.estimatedCreateMinutes}-minute paced schedule.</span>`;
  const modal = $("#scheduleConfirmModal"); modal.dataset.planId = plan.id; modal.hidden = false;
  $("#scheduleConfirmText").value = ""; $("#startPostizSchedule").disabled = true; setTimeout(() => $("#scheduleConfirmText").focus(), 0);
}
async function commitPostizPlan() {
  const plan = state.publishPlan; if (!plan || state.publishingBusy) return;
  const modal = $("#scheduleConfirmModal"), confirmation = $("#scheduleConfirmText").value.trim();
  if (confirmation !== "SCHEDULE") return toast("Type SCHEDULE to unlock the live action", "error");
  if (modal.dataset.planId !== plan.id) { closeScheduleConfirmation(); return toast("The preview changed. Review it again before scheduling.", "error"); }
  state.publishingBusy = true; closeScheduleConfirmation();
  renderPublishingPlan(); $("#publishGraph"); $(".publish-graph").className = "publish-graph uploading"; $("#publishingProof").className = "publishing-proof"; $("#publishingProof").innerHTML = `<strong>Scheduling is running...</strong><span>The duplicate-safe state is saved after every Postiz post.</span>`;
  try { const result = await api.schedulePostizPlan(plan.id, confirmation); $(".publish-graph").className = "publish-graph done"; $("#publishingProof").innerHTML = `<strong>Postiz schedule verified.</strong><span>${result.verified}/${result.total} posts have stored IDs and are visible in the Postiz calendar. ${result.coverPayloads || 0} reel posts carried verified cover metadata; every video still starts at 0:00.</span>`; await refreshActiveSchedule(false); toast(`${result.verified} Postiz posts scheduled and verified`, "success"); }
  catch (error) { $(".publish-graph").className = "publish-graph"; $("#publishingProof").className = "publishing-proof error"; $("#publishingProof").innerHTML = `<strong>Scheduling stopped safely.</strong><span>${esc(error.message || String(error))}</span>`; toast(error.message || String(error), "error"); }
  finally { state.publishingBusy = false; renderPublishingPlan(); }
}
const podcastStages = ["inspect", "analyze", "isolate", "deepen", "trim", "loudness", "verify"];
function podcastDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0)); const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2,"0")}:${String(remainder).padStart(2,"0")}` : `${minutes}:${String(remainder).padStart(2,"0")}`;
}
function renderPodcastRanges() {
  const depth = Number($("#podcastVoiceDepth").value); $("#voiceDepthLabel").textContent = depth < 35 ? "Natural" : depth < 75 ? "Deep and clear" : "Extra deep";
  const clarity = Number($("#podcastClarity").value); $("#clarityLabel").textContent = clarity < 35 ? "Soft" : clarity < 70 ? "Clear" : "Crisp";
  const cleanup = Number($("#podcastCleanup").value); $("#cleanupLabel").textContent = cleanup < 35 ? "Light" : cleanup < 75 ? "Balanced" : "Strong";
  $("#majorSilenceLabel").textContent = `Longer than ${Number($("#podcastMajorSilence").value).toFixed(1)} sec`;
  $("#retainedPauseLabel").textContent = `${Number($("#podcastRetainedPause").value).toFixed(1)} sec`;
}
function podcastOptions() {
  return { voiceDepth: Number($("#podcastVoiceDepth").value), clarity: Number($("#podcastClarity").value), cleanup: Number($("#podcastCleanup").value), removeElectricalHum: $("#podcastRemoveHum").checked, humFrequency: 60, majorSilenceSeconds: Number($("#podcastMajorSilence").value), retainedPauseSeconds: Number($("#podcastRetainedPause").value), preserveVideo: $("#podcastPreserveVideo").checked };
}
function resetMediaElement(element) { element.pause(); element.removeAttribute("src"); element.load(); element.hidden = true; }
function showPodcastSource(source) {
  state.podcastSource = source; state.podcastResult = null; $("#podcastResult").hidden = true; $("#podcastSourceEmpty").hidden = true; $("#podcastOutputEmpty").hidden = false;
  resetMediaElement($("#podcastSourceVideo")); resetMediaElement($("#podcastSourceAudio")); resetMediaElement($("#podcastOutputVideo")); resetMediaElement($("#podcastOutputAudio"));
  const player = source.hasVideo ? $("#podcastSourceVideo") : $("#podcastSourceAudio"); player.src = source.url; player.hidden = false; player.load();
  $("#podcastSourceDetails").hidden = false; $("#podcastSourceDetails").innerHTML = `<strong>${esc(source.name)}</strong><span>${esc(podcastDuration(source.duration))} &middot; ${source.audio.sampleRate ? `${Math.round(source.audio.sampleRate / 1000)} kHz &middot; ` : ""}${source.audio.channels || 1} channel${source.audio.channels === 1 ? "" : "s"}</span><em>${source.hasVideo ? `${source.video.width}×${source.video.height} video` : "Audio only"}</em>`;
  $("#removePodcastSource").hidden = false; $("#removePodcastSource").disabled = false; $("#removePodcastSource").textContent = "Remove recording";
  $("#podcastBeforeDuration").textContent = podcastDuration(source.duration); $("#podcastAfterDuration").textContent = "Waiting"; $("#processPodcast").disabled = false;
  $("#podcastPreserveVideo").checked = source.hasVideo; $("#podcastPreserveVideo").disabled = !source.hasVideo; $("#podcastPreserveVideo").closest("label").classList.toggle("disabled", !source.hasVideo);
  updatePodcastProgress({ stage: "inspect", status: "completed", percent: 4, message: `${source.hasVideo ? "Video and audio" : "Audio"} loaded locally` });
}
function clearPodcastSource() {
  state.podcastSource = null; state.podcastResult = null; state.podcastProgress = null; state.podcastClearRequested = false;
  for (const player of [$("#podcastSourceVideo"),$("#podcastSourceAudio"),$("#podcastOutputVideo"),$("#podcastOutputAudio")]) resetMediaElement(player);
  $("#podcastSourceDetails").hidden = true; $("#podcastSourceDetails").innerHTML = ""; $("#removePodcastSource").hidden = true; $("#removePodcastSource").disabled = false; $("#removePodcastSource").textContent = "Remove recording";
  $("#podcastSourceEmpty").hidden = false; $("#podcastOutputEmpty").hidden = false; $("#podcastResult").hidden = true; $("#podcastBeforeDuration").textContent = "No source"; $("#podcastAfterDuration").textContent = "Waiting"; $("#processPodcast").disabled = true; $("#podcastPreserveVideo").checked = false; $("#podcastPreserveVideo").disabled = true;
  $$('[data-podcast-stage]').forEach((node) => node.classList.remove("running", "completed")); $("#podcastProgressStage").textContent = "READY"; $("#podcastProgressMessage").textContent = "Choose a recording to begin"; $("#podcastProgressDetail").textContent = "The original file is never overwritten."; $("#podcastProgressPercent").textContent = "0%"; $("#podcastProgressBar").style.width = "0%";
}
async function removePodcastSource() {
  if (!state.podcastSource) return;
  if (state.podcastBusy) {
    state.podcastClearRequested = true; $("#removePodcastSource").disabled = true; $("#removePodcastSource").textContent = "Stopping and removing...";
    const result = await api.cancelPodcast(); if (result.cancelled) toast("Stopping Podcast processing and clearing the recording"); return;
  }
  clearPodcastSource(); toast("Recording removed from the workspace. Original and finished files were kept.", "success");
}
async function choosePodcastFile(path = null) {
  if (state.podcastBusy) return toast("Stop the current podcast process before choosing another file", "error");
  const inputPath = path || await api.chooseFile({ title: "Choose a podcast recording", filters: [{ name: "Podcast audio and video", extensions: ["mp4","mov","m4v","mkv","webm","mp3","wav","m4a","aac","flac","ogg"] }] });
  if (!inputPath) return; $("#podcastDrop").disabled = true; $("#podcastProgressMessage").textContent = "Inspecting the recording...";
  try { showPodcastSource(await api.inspectPodcast(inputPath)); toast("Podcast recording loaded locally", "success"); }
  catch (error) { toast(error.message || String(error), "error"); $("#podcastProgressMessage").textContent = "This recording could not be opened"; }
  finally { $("#podcastDrop").disabled = false; }
}
function updatePodcastProgress(progress = {}) {
  state.podcastProgress = progress; const stageIndex = Math.max(0, podcastStages.indexOf(progress.stage));
  $$('[data-podcast-stage]').forEach((node) => { const index = podcastStages.indexOf(node.dataset.podcastStage); node.classList.toggle("completed", index < stageIndex || (index === stageIndex && progress.status === "completed")); node.classList.toggle("running", index === stageIndex && progress.status === "running"); });
  const label = { inspect: "SOURCE INSPECTION", analyze: "SILENCE ANALYSIS", isolate: "VOICE ISOLATION", deepen: "VOICE DEPTH", trim: "DEAD-SPACE CUTS", loudness: "PODCAST MASTERING", verify: "OUTPUT VERIFICATION" }[progress.stage] || "READY";
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0)); $("#podcastProgressStage").textContent = label; $("#podcastProgressMessage").textContent = progress.message || "Processing locally"; $("#podcastProgressPercent").textContent = `${Math.round(percent)}%`; $("#podcastProgressBar").style.width = `${percent}%`;
  $("#podcastProgressDetail").textContent = state.podcastBusy ? "Keep LocalCut open. No command windows or cloud services are used." : progress.status === "completed" && percent === 100 ? "The master files passed duration, audio-track, and synchronization checks." : "The original file is never overwritten.";
}
function renderPodcastResult(result) {
  state.podcastResult = result; const analysis = result.analysis || {}, source = result.source || {}; $("#podcastResult").hidden = false;
  const announcementCount = analysis.removedAnnouncements?.length || 0;
  const humRemoved = analysis.electricalHum?.removed;
  $("#podcastResultSummary").textContent = `${source.name} was isolated, clarified, deepened, tightened, mastered, and checked locally.${announcementCount ? " The opening recording announcement was removed." : ""}${humRemoved ? ` The ${analysis.electricalHum.fundamentalHz || 60} Hz Focusrite/electrical hum was removed.` : ""}`;
  $("#podcastResultStats").innerHTML = `<div><strong>${podcastDuration(analysis.outputDuration)}</strong><span>Finished length</span></div><div><strong>${Math.max(0, Number(analysis.removedSeconds || 0)).toFixed(1)} sec</strong><span>Total unwanted audio removed</span></div><div><strong>${announcementCount || analysis.majorSilences?.length || 0}</strong><span>${announcementCount ? "System announcement removed" : "Long sections tightened"}</span></div><div><strong>${humRemoved ? `${analysis.electricalHum.fundamentalHz || 60} Hz clean` : "-16 LUFS"}</strong><span>${humRemoved ? "Electrical hum removed" : "Podcast loudness target"}</span></div>`;
  const outputLabels = { masterWav: "WAV master", mp3: "Shareable MP3", video: "Corrected video" };
  $("#podcastOutputFiles").innerHTML = Object.entries(result.files || {}).filter(([,path]) => Boolean(path)).map(([key,path]) => `<button type="button" data-podcast-file="${esc(path)}">${esc(outputLabels[key] || key)}</button>`).join("");
  $$('[data-podcast-file]').forEach((button) => button.onclick = () => api.reveal(button.dataset.podcastFile));
  resetMediaElement($("#podcastOutputVideo")); resetMediaElement($("#podcastOutputAudio")); $("#podcastOutputEmpty").hidden = true;
  const finalPlayer = result.fileUrls?.video ? $("#podcastOutputVideo") : $("#podcastOutputAudio"); finalPlayer.src = result.fileUrls?.video || result.fileUrls?.mp3 || result.fileUrls?.masterWav; finalPlayer.hidden = false; finalPlayer.load();
  $("#podcastAfterDuration").textContent = podcastDuration(analysis.outputDuration); renderPodcastHistory();
}
async function processPodcast() {
  if (!state.podcastSource || state.podcastBusy) return; state.podcastBusy = true; $("#processPodcast").disabled = true; $("#podcastDrop").disabled = true; $("#cancelPodcast").hidden = false; $("#podcastResult").hidden = true;
  updatePodcastProgress({ stage: "inspect", status: "running", percent: 1, message: "Reading the source locally" });
  try { const result = await api.processPodcast(state.podcastSource.inputPath, podcastOptions()); renderPodcastResult(result); toast("Podcast master finished and verified", "success"); }
  catch (error) { updatePodcastProgress({ stage: state.podcastProgress?.stage || "inspect", status: "error", percent: state.podcastProgress?.percent || 0, message: error.message || String(error) }); toast(error.message || String(error), "error"); }
  finally { state.podcastBusy = false; $("#podcastDrop").disabled = false; $("#cancelPodcast").hidden = true; if (state.podcastClearRequested) clearPodcastSource(); else { $("#processPodcast").disabled = !state.podcastSource; $("#removePodcastSource").disabled = false; $("#removePodcastSource").textContent = "Remove recording"; } }
}
async function cancelPodcast() { if (!state.podcastBusy) return; const result = await api.cancelPodcast(); if (result.cancelled) { $("#cancelPodcast").disabled = true; $("#cancelPodcast").textContent = "Stopping..."; } }
async function renderPodcastHistory() {
  let history = []; try { history = await api.podcastHistory(); } catch { /* keep the current result visible */ }
  const target = $("#podcastHistoryList"); if (!history.length) { target.innerHTML = "<p>No processed podcasts yet.</p>"; return; }
  target.innerHTML = history.map((item) => `<article class="podcast-history-row"><div><strong>${esc(item.source?.name || "Podcast master")}</strong><span>${esc(new Date(item.completedAt).toLocaleString())} &middot; ${podcastDuration(item.analysis?.outputDuration)} &middot; ${Number(item.analysis?.removedSeconds || 0).toFixed(1)} sec removed</span></div><em>${item.files?.video ? "Video + audio" : "Audio master"}</em><button type="button" data-podcast-history="${esc(item.outputDir)}">Open</button></article>`).join("");
  $$('[data-podcast-history]').forEach((button) => button.onclick = () => api.open(button.dataset.podcastHistory));
}
async function openPodcast(updateUrl = true) { closeAutomation(false); $("#podcastHub").hidden = false; if (updateUrl) setAppUrl("/podcast"); renderPodcastRanges(); await renderPodcastHistory(); }
function closePodcast(updateUrl = true) { const wasOpen = !$("#podcastHub").hidden; $("#podcastHub").hidden = true; if (updateUrl && wasOpen) setAppUrl("/"); }
async function openAutomation(preferredId = null, updateUrl = true) {
  $("#podcastHub").hidden = true; $("#automationBackdrop").hidden = false; $("#automationDrawer").classList.add("open"); await refreshAutomation(preferredId);
  if (updateUrl) setAppUrl(batchUrl(state.pipeline?.id || preferredId));
  if (state.pipeline?.summary?.status === "running") startPipelinePoll();
}
function closeAutomation(updateUrl = true) {
  const wasOpen = $("#automationDrawer").classList.contains("open"); closeReelReviewer(false); closePublishing(false); $("#automationDrawer").classList.remove("open"); $("#automationBackdrop").hidden = true; clearInterval(state.pipelineTimer); state.pipelineTimer = null;
  if (updateUrl && wasOpen) setAppUrl("/");
}
async function applyAppRoute() {
  if (!hostedNavigation()) return;
  const route = parseAppRoute();
  if (route.view === "podcast") return openPodcast(false);
  if (route.view !== "batches") { closePodcast(false); closeAutomation(false); return; }
  await openAutomation(route.batchId, false);
  if (!route.batchId || state.pipeline?.id !== route.batchId) { closeReelReviewer(false); closePublishing(false); return; }
  if (route.publishing) return openPublishing(false);
  closePublishing(false);
  if (route.reel) openReelReviewer(route.reel, false, false); else closeReelReviewer(false);
}
function startPipelinePoll() { clearInterval(state.pipelineTimer); state.pipelineTimer = setInterval(async () => { await refreshAutomation(); if (!state.pipeline || ["completed","failed","cancelled"].includes(state.pipeline.summary?.status)) { clearInterval(state.pipelineTimer); state.pipelineTimer = null; if (state.reviewRerendering && state.reviewReel) { const reel = state.reviewReel; state.reviewRerendering = null; openReelReviewer(reel, true); toast(state.pipeline.summary.status === "completed" ? `Reel ${reel} rebuilt; review and approve again` : `Reel ${reel} rebuild needs attention`, state.pipeline.summary.status === "completed" ? "success" : "error"); } } }, 1400); }
async function runTalkingHeadBatch() {
  if (state.batchStarting || state.pipeline?.summary?.status === "running") return openAutomation();
  state.batchStarting = true;
  try {
    await openAutomation();
    addAgentMessage(`<strong>ANALYZING LATEST RAW BATCH</strong>LocalCut is pairing the newest recording with its teleprompter/edit specification, selecting clean takes, and preparing the seven-stage reel graph.`);
    state.pipeline = await api.prepareAndStartBatch(); renderAutomation(); setAppUrl(batchUrl(state.pipeline.id), { replace: true });
    toast("Talking-head analysis complete · render graph started", "success"); startPipelinePoll();
  } catch (error) { toast(error.message || String(error), "error"); addAgentMessage(`<strong>BATCH STOPPED</strong>${esc(error.message || String(error))}`); }
  finally { state.batchStarting = false; }
}
const runDefaultBatch = runTalkingHeadBatch;

function bindEvents() {
  $("#projectLibraryButton").onclick = () => openModal("projectModal"); $("#versionsButton").onclick = () => openModal("versionsModal"); $("#exportButton").onclick = () => openModal("exportModal");
  $$('[data-close-modal]').forEach((button) => button.onclick = () => closeModal(button.dataset.closeModal));
  $$(".modal-backdrop").forEach((backdrop) => backdrop.onclick = (event) => { if (event.target === backdrop) backdrop.hidden = true; });
  $("#projectName").oninput = () => { clearTimeout(state.renameTimer); state.renameTimer = setTimeout(() => mutate("update_project", { name: $("#projectName").value }), 600); };
  $("#projectName").onblur = () => { clearTimeout(state.renameTimer); if ($("#projectName").value.trim() !== state.project.name) mutate("update_project", { name: $("#projectName").value }); };
  $("#undoButton").onclick = () => mutate("undo_project", {}, "Undid last edit"); $("#redoButton").onclick = () => mutate("redo_project", {}, "Redid edit");
  $("#workspaceButton").onclick = () => showWorkspacePopover($("#workspaceButton")); $("#aspectButton").onclick = () => showAspectPopover($("#aspectButton"));
  $("#agentSettingsButton").onclick = () => showAgentSettings($("#agentSettingsButton")); $("#styleButton").onclick = () => showStylePopover($("#styleButton")); $("#skillsButton").onclick = () => showSkillsPopover($("#skillsButton"));
  $("#recordSettingsButton").onclick = () => showRecordSettings($("#recordSettingsButton"));
  $("#selectionContextButton").onclick = () => { $("#selectionContextButton").classList.toggle("active"); toast($("#selectionContextButton").classList.contains("active") ? "Selection context enabled" : "Selection context disabled"); };
  document.addEventListener("click", (event) => { const popover = $("#contextPopover"); if (!popover.hidden && !popover.contains(event.target) && !state.popoverAnchor?.contains(event.target)) popover.hidden = true; });

  $$('[data-workflow]').forEach((button) => button.onclick = () => button.dataset.workflow === "podcast" ? openPodcast() : ["talking","reels"].includes(button.dataset.workflow) ? runTalkingHeadBatch() : setWorkflow(button.dataset.workflow)); $("#sendPromptButton").onclick = runPrompt;
  $("#promptInput").onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); runPrompt(); } };
  $("#attachButton").onclick = importMedia; $("#uploadAssetButton").onclick = importMedia; $("#mediaDropTarget").onclick = importMedia;
  $("#assetSearch").oninput = renderAssets; $("#assetViewButton").onclick = () => $("#assetGrid").classList.toggle("list");
  $("#assetSortButton").onclick = () => { const entries = Object.entries(state.project.assets).sort((a,b) => a[1].name.localeCompare(b[1].name)); state.project.assets = Object.fromEntries(entries); renderAssets(); toast("Assets sorted by name"); };
  $("#newBinButton").onclick = () => toast("AutoEditPost bin is already active");
  $$('[data-media-tab]').forEach((button) => button.onclick = () => switchMediaTab(button.dataset.mediaTab)); $("#refreshTranscript").onclick = loadTranscript;
  $$('[data-category]').forEach((button) => button.onclick = () => { $$('[data-category]').forEach((item) => item.classList.remove("active")); button.classList.add("active"); renderTemplates(button.dataset.category); });

  const dropTarget = $("#mediaDropTarget"); dropTarget.ondragover = (event) => { event.preventDefault(); dropTarget.classList.add("dragging"); }; dropTarget.ondragleave = () => dropTarget.classList.remove("dragging");
  dropTarget.ondrop = (event) => { event.preventDefault(); dropTarget.classList.remove("dragging"); const file = event.dataTransfer.files?.[0]; if (file?.path) uploadAndImport(file.path).catch(() => {}); else importMedia(); };
  $$(".track-lane").forEach((lane) => { lane.ondragover = (event) => { event.preventDefault(); lane.classList.add("dragging"); }; lane.ondragleave = () => lane.classList.remove("dragging"); lane.ondrop = (event) => { event.preventDefault(); lane.classList.remove("dragging"); const assetId = event.dataTransfer.getData("text/localcut-asset"); if (assetId) addAssetToTimeline(assetId, lane.dataset.track); }; });

  $("#viewerVideo").onloadedmetadata = () => { if (!state.selectedItemId) $("#viewerTime").textContent = fmtTime(0,true); };
  $("#viewerVideo").ontimeupdate = () => { const video = $("#viewerVideo"); const item = currentItem(); state.playhead = item && item.assetId === state.selectedAssetId ? item.from + Math.max(0, video.currentTime - item.sourceStart) : video.currentTime; $("#viewerTime").textContent = fmtTime(video.currentTime,true); $("#playhead").style.left = `${state.playhead * pixelsPerSecond()}px`; };
  $("#viewerVideo").onplay = () => $("#playButton").textContent = "❚❚"; $("#viewerVideo").onpause = () => $("#playButton").textContent = "▶";
  $("#playButton").onclick = () => { const video = $("#viewerVideo"); if (!currentAsset()) return importMedia(); video.paused ? video.play().catch((error) => toast(error.message,"error")) : video.pause(); };
  $("#captionsButton").onclick = () => mutate("update_project", { settings: { captions: state.project.settings?.captions === false } });
  $("#captionStyleButton").onclick = () => showStylePopover($("#captionStyleButton")); $("#fullscreenButton").onclick = () => $("#viewerStage").requestFullscreen?.();
  $("#viewerStage").ondblclick = () => $("#viewerStage").requestFullscreen?.();

  $$('[data-edit-mode]').forEach((button) => button.onclick = () => { state.editMode = button.dataset.editMode; $$('[data-edit-mode]').forEach((item) => item.classList.toggle("active", item === button)); toast(`${button.dataset.editMode[0].toUpperCase()}${button.dataset.editMode.slice(1)} mode`); });
  $("#splitButton").onclick = splitSelected; $("#snapButton").onclick = () => mutate("update_project", { settings: { snapping: state.project.settings?.snapping === false } });
  $("#recordButton").onclick = () => toast("Choose Voiceover, Camera, or Screen from recording settings"); $("#addTrackButton").onclick = () => toast("V2, V1, and A1 tracks are ready");
  $("#zoomOut").onclick = () => { state.zoom = Math.max(25,state.zoom - 10); renderTimeline(); }; $("#zoomIn").onclick = () => { state.zoom = Math.min(200,state.zoom + 10); renderTimeline(); }; $("#fitTimeline").onclick = () => { const total = Math.max(1,timelineEnd()); state.zoom = Math.max(25,Math.min(200,(($("#timelineScroll").clientWidth - 70) / total) * 7)); renderTimeline(); };
  $("#timelineScroll").onclick = (event) => { if (event.target.closest(".timeline-clip")) return; const rect = $("#timelineScroll").getBoundingClientRect(); state.playhead = Math.max(0,(event.clientX - rect.left + $("#timelineScroll").scrollLeft) / pixelsPerSecond()); renderTimeline(); const item = Object.values(state.project.items).find((candidate) => state.playhead >= candidate.from && state.playhead <= candidate.from + candidate.duration); if (item) selectTimelineItem(item.id); };

  $("#saveVersionButton").onclick = async () => { const name = $("#versionName").value.trim(); await api.editorCall("save_project_version", { name }); $("#versionName").value = ""; await renderVersions(); toast("Project version saved", "success"); };
  $("#startExportButton").onclick = async () => { const suggested = `${state.bootstrap.defaults.autoEditRoot}\\out\\exports\\${state.project.name.replace(/[^a-z0-9_-]+/gi,"_")}.mp4`; const outputPath = await api.chooseSaveFile({ title: "Export timeline", defaultPath: suggested }); if (!outputPath) return; $("#exportProgress").hidden = false; $("#startExportButton").disabled = true; try { await api.editorCall("local_export", { outputPath }); toast("Export complete", "success"); closeModal("exportModal"); await api.reveal(outputPath); } catch (error) { toast(error.message || String(error), "error"); } finally { $("#exportProgress").hidden = true; $("#startExportButton").disabled = false; } };
  $("#projectSearch").oninput = renderProjectLibrary;

  $("#podcastButton").onclick = openPodcast; $("#closePodcast").onclick = closePodcast; $("#podcastDrop").onclick = () => choosePodcastFile(); $("#removePodcastSource").onclick = removePodcastSource; $("#processPodcast").onclick = processPodcast; $("#cancelPodcast").onclick = cancelPodcast; $("#refreshPodcastHistory").onclick = renderPodcastHistory;
  $("#openPodcastFolder").onclick = () => { if (state.podcastResult?.outputDir) api.open(state.podcastResult.outputDir); };
  for (const id of ["podcastVoiceDepth","podcastClarity","podcastCleanup","podcastMajorSilence","podcastRetainedPause"]) $(`#${id}`).oninput = renderPodcastRanges;
  const podcastDrop = $("#podcastDrop"); podcastDrop.ondragover = (event) => { event.preventDefault(); podcastDrop.classList.add("dragging"); }; podcastDrop.ondragleave = () => podcastDrop.classList.remove("dragging"); podcastDrop.ondrop = (event) => { event.preventDefault(); podcastDrop.classList.remove("dragging"); const file = event.dataTransfer.files?.[0]; file?.path ? choosePodcastFile(file.path) : choosePodcastFile(); };
  for (const player of [$("#podcastSourceVideo"),$("#podcastSourceAudio"),$("#podcastOutputVideo"),$("#podcastOutputAudio")]) player.onplay = () => { for (const other of [$("#podcastSourceVideo"),$("#podcastSourceAudio"),$("#podcastOutputVideo"),$("#podcastOutputAudio")]) if (other !== player) other.pause(); };

  $("#automationButton").onclick = () => openAutomation(); $("#closeAutomation").onclick = () => closeAutomation(); $("#automationBackdrop").onclick = () => closeAutomation(); $("#runDefaultBatch").onclick = runDefaultBatch;
  $("#toggleExecutionGraph").onclick = () => setExecutionGraphHidden(!state.executionGraphHidden);
  $("#openPublishing").onclick = openPublishing; $("#closePublishing").onclick = closePublishing; $("#buildPostizPlan").onclick = buildPostizPreview; $("#commitPostizPlan").onclick = openScheduleConfirmation;
  $("#closeScheduleConfirmation").onclick = closeScheduleConfirmation; $("#cancelScheduleConfirmation").onclick = closeScheduleConfirmation; $("#startPostizSchedule").onclick = commitPostizPlan;
  $("#scheduleConfirmModal").onclick = (event) => { if (event.target === $("#scheduleConfirmModal")) closeScheduleConfirmation(); };
  $("#scheduleConfirmText").oninput = () => { $("#startPostizSchedule").disabled = $("#scheduleConfirmText").value.trim() !== "SCHEDULE" || state.publishingBusy; };
  $("#scheduleConfirmText").onkeydown = (event) => { if (event.key === "Enter" && !$("#startPostizSchedule").disabled) { event.preventDefault(); commitPostizPlan(); } };
  $("#refreshActiveSchedule").onclick = () => refreshActiveSchedule(true); $("#activeScheduleRange").onchange = () => refreshActiveSchedule(true);
  $$("[data-schedule-filter]").forEach((button) => button.onclick = () => { state.activeScheduleFilter = button.dataset.scheduleFilter; renderActiveSchedule(); });
  $("#savePostizConnection").onclick = async () => {
    const button = $("#savePostizConnection"); button.disabled = true; button.textContent = "Encrypting...";
    try { const result = await api.savePostizConfig({ apiUrl: $("#postizApiUrl").value, key: $("#postizApiKey").value }); $("#postizApiKey").value = ""; await refreshPublishing(); await refreshActiveSchedule(false); toast(result.configured ? "Postiz connection saved with Windows encryption" : "Postiz API address saved; key still required", result.configured ? "success" : ""); }
    catch (error) { toast(error.message || String(error), "error"); }
    finally { button.disabled = false; button.textContent = "Save encrypted connection"; }
  };
  $("#testPostiz").onclick = async () => { const button = $("#testPostiz"); button.disabled = true; button.textContent = "Testing..."; try { const result = await api.testPostiz(); await refreshActiveSchedule(false); toast(`Postiz connected${Number.isFinite(result.visiblePosts) ? ` · ${result.visiblePosts} posts visible in the next day` : ""}`, "success"); } catch (error) { toast(error.message || String(error), "error"); } finally { button.disabled = false; button.textContent = "Test"; } };
  $("#allowScheduledCarousels").onchange = () => { renderPublishingCarousels(); renderPublishingPlan(null); if ($("#allowScheduledCarousels").checked) toast("Previously scheduled carousel decks are now selectable; review carefully to avoid repeats"); };
  $("#toggleAllPublishReels").onclick = () => { const inputs = $$('[data-publish-reel]:not(:disabled)'); const select = inputs.some((input) => !input.checked); inputs.forEach((input) => input.checked = select); $("#toggleAllPublishReels").textContent = select ? "Clear approved reels" : "Select all approved"; renderPublishingPlan(null); };
  $("#revealPostizPlan").onclick = () => { if (state.publishSnapshot?.outputDir) api.open(`${state.publishSnapshot.outputDir}\\postiz-plan.json`); };
  for (const id of ["publishStartDate","publishReelTimes","publishCarouselTime","publishTimeZone","publishPlatforms","publishReelList","publishCarouselList"]) {
    $(`#${id}`).addEventListener("change", () => renderPublishingPlan(null));
  }
  $("#closeReelReviewer").onclick = closeReelReviewer;
  $("#previousReviewReel").onclick = () => { const index = state.pipeline?.reels.indexOf(state.reviewReel) ?? -1; if (index > 0) openReelReviewer(state.pipeline.reels[index - 1]); };
  $("#nextReviewReel").onclick = () => { const index = state.pipeline?.reels.indexOf(state.reviewReel) ?? -1; if (index >= 0 && index < state.pipeline.reels.length - 1) openReelReviewer(state.pipeline.reels[index + 1]); };
  $("#reviewReelSlider").oninput = (event) => { const index = Math.max(0, Number(event.target.value) - 1); const reel = state.pipeline?.reels?.[index]; $("#reviewReelSliderValue").textContent = reel ? `Reel ${String(reel).padStart(2, "0")} of ${state.pipeline.reels.length}` : "Choose reel"; };
  $("#reviewReelSlider").onchange = (event) => { const reel = state.pipeline?.reels?.[Math.max(0, Number(event.target.value) - 1)]; if (reel) openReelReviewer(reel); };
  $("#approveReviewReel").onclick = async () => {
    const item = artifactForReel(state.reviewReel); if (!item || state.pipeline?.summary?.status === "running") return;
    const button = $("#approveReviewReel"), approve = !item.approval?.approved; button.disabled = true; button.textContent = approve ? "Saving approval…" : "Revoking approval…";
    try {
      const result = await api.setReelApproval(state.pipeline.id, state.reviewReel, approve); item.review = result.review; item.approval = result.approval;
      renderReviewApproval(item); renderAutomation(); toast(approve ? `Reel ${state.reviewReel} approved for Postiz` : `Reel ${state.reviewReel} approval revoked`, approve ? "success" : "");
    } catch (error) { renderReviewApproval(item); toast(error.message || String(error), "error"); }
  };
  $("#captionPosition").oninput = (event) => { setReviewCaptionPosition(event.target.value); setReviewGuideVisible(true); };
  $$('[data-caption-y]').forEach((button) => button.onclick = () => { setReviewCaptionPosition(button.dataset.captionY); setReviewGuideVisible(true); });
  $("#framingZoom").oninput = (event) => setReviewFraming(event.target.value);
  $$('[data-frame-zoom]').forEach((button) => button.onclick = () => setReviewFraming(button.dataset.frameZoom));
  $("#toggleCaptionGuide").onclick = () => setReviewGuideVisible($("#reviewCaptionGuide").hidden);
  $("#reviewVideo").onplay = () => setReviewGuideVisible(false);
  $("#seoPrimary").oninput = updateSeoPreview; $("#seoRelated").oninput = updateSeoPreview; $("#seoHashtags").oninput = updateSeoPreview;
  $("#saveSeoPackage").onclick = async () => {
    const item = artifactForReel(state.reviewReel); if (!item || state.pipeline?.summary?.status === "running") return;
    const button = $("#saveSeoPackage"), video = $("#reviewVideo"), previousTime = Number(video.currentTime) || 0, previousUrl = item.videoUrl;
    button.disabled = true; button.textContent = "Attaching keywords to MP4…"; $("#seoFeedbackState").textContent = "Writing file metadata";
    video.pause(); video.removeAttribute("src"); video.load();
    try {
      const result = await api.saveSeo(state.pipeline.id, state.reviewReel, seoFromFields());
      item.videoUrl = result.videoUrl; item.seoPath = result.seoPath; item.seoExists = true; item.review = result.review; item.brief.seo = result.seo; item.qa ||= {}; item.qa.seo = result.seo; item.qa.media ||= {}; item.qa.media.metadataKeywords = result.metadataKeywords;
      markApprovalPending(item, "seo");
      setReviewSeo(result.seo); $("#seoFeedbackState").textContent = `${result.seo.keywords.length} terms attached`;
      video.src = result.videoUrl; video.addEventListener("loadedmetadata", () => { video.currentTime = Math.min(previousTime, Math.max(0, video.duration - .05)); }, { once: true }); video.load();
      renderAutomation();
      toast(`Reel ${state.reviewReel} SEO keywords attached to the MP4 and Postiz package`, "success");
    } catch (error) {
      video.src = previousUrl; video.load(); $("#seoFeedbackState").textContent = "Could not attach"; toast(error.message || String(error), "error");
    } finally { button.disabled = false; button.textContent = "Save keywords and attach to video"; }
  };
  $("#usePausedCoverFrame").onclick = async () => {
    const item = artifactForReel(state.reviewReel); if (!item) return;
    const video = $("#reviewVideo"); video.pause();
    const at = Math.max(0, Number(video.currentTime) || 0); state.reviewCoverAt = at;
    $("#coverFeedbackState").textContent = `Paused frame ${fmtTime(at,true)} selected`;
    await loadCoverCandidates(item, at);
  };
  $("#regenerateCover").onclick = async () => {
    const item = artifactForReel(state.reviewReel); if (!item) return;
    const video = $("#reviewVideo"); const duration = Number(item.qa?.media?.duration || video.duration || 0); const at = Number.isFinite(Number(state.reviewCoverAt)) ? Number(state.reviewCoverAt) : Number(item.review?.cover?.atSeconds ?? duration * .78);
    const button = $("#regenerateCover"); button.disabled = true; button.textContent = "Creating new cover…";
    const coverCopy = { kicker: $("#coverKicker").value, accent: $("#coverAccent").value, headline: $("#coverHeadline").value };
    try { const result = await api.regenerateCover(state.pipeline.id, state.reviewReel, at, $("#coverFeedback").value, coverCopy); item.coverUrl = result.coverUrl; item.coverExists = true; item.review = result.review; item.brief.coverCopy = result.review.cover; markApprovalPending(item, "cover"); state.reviewCoverAt = at; $("#reviewCover").src = result.coverUrl; $("#coverFeedbackState").textContent = `Frame at ${fmtTime(at,true)} · lettering ready`; toast(`Reel ${state.reviewReel} cover applied locally; approval is now required`, "success"); renderAutomation(); await loadCoverCandidates(item, at); }
    catch (error) { toast(error.message || String(error), "error"); }
    finally { button.disabled = false; button.textContent = "Apply this cover now"; }
  };
  $("#redoCaptions").onclick = async () => {
    if (!state.reviewReel || state.pipeline?.summary?.status === "running") return;
    const reel = state.reviewReel, button = $("#redoCaptions"); button.disabled = true; button.textContent = "Starting face-safe rebuild…";
    try { markApprovalPending(artifactForReel(reel), "captions"); await api.redoCaptions(state.pipeline.id, reel, Number($("#captionPosition").value), $("#captionFeedback").value); state.reviewRerendering = reel; button.textContent = "Rendering face-safe captions…"; toast(`Reel ${reel} captions are rebuilding below the face; approve again when complete`, "success"); await refreshAutomation(); startPipelinePoll(); }
    catch (error) { button.disabled = false; button.textContent = "Redo captions and final video"; toast(error.message || String(error), "error"); }
  };
  $("#applyFraming").onclick = async () => {
    if (!state.reviewReel || state.pipeline?.summary?.status === "running") return;
    const reel = state.reviewReel, button = $("#applyFraming"); button.disabled = true; button.textContent = "Starting framing rebuild…";
    try { markApprovalPending(artifactForReel(reel), "framing"); await api.setFraming(state.pipeline.id, reel, Number($("#framingZoom").value), $("#framingFeedback").value); state.reviewRerendering = reel; button.textContent = "Rebuilding with new framing…"; toast(`Reel ${reel} is rebuilding from the cut stage with the new framing; approve again when complete`, "success"); await refreshAutomation(); startPipelinePoll(); }
    catch (error) { button.disabled = false; button.textContent = "Apply framing and rebuild reel"; toast(error.message || String(error), "error"); }
  };
  $("#openBatchFolder").onclick = () => api.open(state.pipeline?.batch?.outputDir || state.bootstrap.defaults.outputDir);
  $("#copyBatchLink").onclick = async () => { if (!state.pipeline) return; const link = hostedNavigation() ? `${location.origin}${batchUrl(state.pipeline.id)}` : batchUrl(state.pipeline.id); await api.copy(link); toast("Direct batch link copied", "success"); };
  $("#retryBatch").onclick = async () => { if (!state.pipeline) return; try { await api.retryPipeline(state.pipeline.id); toast("Retrying failed pipeline stages", "success"); await refreshAutomation(); startPipelinePoll(); } catch (error) { toast(error.message || String(error), "error"); } };
  $("#cancelBatch").onclick = async () => { if (!state.pipeline) return; try { await api.cancelPipeline(state.pipeline.id); toast("Batch stopped safely"); await refreshAutomation(); } catch (error) { toast(error.message || String(error), "error"); } };
  $("#rebuildBatch").onclick = async () => { if (!state.pipeline || !confirm(`Rebuild all ${state.pipeline.reels.length} reels in this batch from the source video?`)) return; try { await api.rebuildPipeline(state.pipeline.id); toast("Rebuilding every reel from the source", "success"); await refreshAutomation(); startPipelinePoll(); } catch (error) { toast(error.message || String(error), "error"); } };
  $("#regenerateAllCovers").onclick = async () => { if (!state.pipeline || !confirm(`Add branded lettering to all ${state.pipeline.reels.length} cover photos? Reel videos and caption positions will not be changed.`)) return; const button = $("#regenerateAllCovers"); button.disabled = true; button.textContent = "Rendering cover lettering…"; try { const result = await api.regenerateAllCovers(state.pipeline.id); toast(`${result.regenerated} covers regenerated with lettering`, "success"); await refreshAutomation(); } catch (error) { toast(error.message || String(error), "error"); } finally { button.disabled = false; button.textContent = "Add lettering to all covers"; } };
  $("#redoAllCaptions").onclick = async () => { if (!state.pipeline || !confirm(`Redo captions and final renders for all ${state.pipeline.reels.length} reels using the face-safe lower third?`)) return; try { await api.redoAllCaptions(state.pipeline.id, 1450, "Keep captions below the face in the face-safe lower third."); toast("Rebuilding all captions below the face", "success"); await refreshAutomation(); startPipelinePoll(); } catch (error) { toast(error.message || String(error), "error"); } };
  $("#copyMcpButton").onclick = async () => { await api.copy(JSON.stringify(state.bootstrap.mcpConfig,null,2)); toast("MCP configuration copied", "success"); };
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#scheduleConfirmModal").hidden) { event.preventDefault(); closeScheduleConfirmation(); return; }
    if (event.key === "Escape" && !$("#podcastHub").hidden) { event.preventDefault(); closePodcast(); return; }
    if (event.key === "Escape") { $("#contextPopover").hidden = true; closeAutomation(); $$(".modal-backdrop").forEach((modal) => modal.hidden = true); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? mutate("redo_project") : mutate("undo_project"); }
    if ((event.key === "Delete" || event.key === "Backspace") && !event.target.matches("input,textarea,[contenteditable]") && state.selectedItemId) { event.preventDefault(); deleteSelectedItem(); }
    if (["v","n","b"].includes(event.key.toLowerCase()) && !event.target.matches("input,textarea")) { const mode = {v:"select",n:"trim",b:"blade"}[event.key.toLowerCase()]; $(`[data-edit-mode="${mode}"]`).click(); }
    if (event.key === " " && !event.target.matches("input,textarea")) { event.preventDefault(); $("#playButton").click(); }
  });
  window.addEventListener("resize", () => renderTimeline());
  window.addEventListener("popstate", applyAppRoute);
}

async function init() {
  if (!api?.bootstrap || !api?.editorCall) {
    $("#bootScreen strong").textContent = "Open the LocalCut desktop app";
    $("#bootScreen span").textContent = "This HTML file is only the interface. Install LocalCut to start its secure local editing engine.";
    $("#bootScreen i").style.display = "none"; $("#desktopInstallerLink").hidden = false;
    return;
  }
  try {
    state.bootstrap = await api.bootstrap(); bindEvents(); renderTemplates();
    let graphHidden = false; try { graphHidden = localStorage.getItem("localcut:execution-graph-hidden") === "1"; } catch { /* storage can be disabled */ }
    setExecutionGraphHidden(graphHidden, false);
    api.onBatchProgress?.((progress) => {
      const label = progress.stage === "transcribe" ? "Transcribing recording" : progress.stage === "match" ? "Matching clean takes to scripts" : "Preparing Talking Heads";
      toast(`${label}${progress.status ? ` · ${progress.status}` : ""}`);
    });
    api.onUploadProgress?.((progress) => toast(`Uploading ${progress.filename} to ${state.bootstrap.upload?.host || "server"} · ${progress.percent}%`));
    api.onPublishingProgress?.((progress) => {
      $(".publish-graph").className = `publish-graph ${progress.stage === "upload" ? "uploading" : progress.stage === "verify" ? "verifying" : "scheduling"}`;
      $("#publishingProof").innerHTML = `<strong>${progress.stage === "upload" ? "Uploading media" : "Creating scheduled posts"}...</strong><span>${progress.completed}/${progress.total} complete · ${esc(platformLabels[progress.delivery?.platform] || progress.delivery?.platform || "Postiz")}</span>`;
    });
    api.onPodcastProgress?.((progress) => updatePodcastProgress(progress));
    if (state.bootstrap.upload?.enabled) {
      $("#uploadAssetButton").title = `Upload media to ${state.bootstrap.upload.host}`;
      api.uploadHealth().then((health) => {
        if (!health.ok) toast(`Upload server ${state.bootstrap.upload.host} is unavailable`, "error");
      }).catch((error) => toast(error.message || String(error), "error"));
    }
    state.project = await api.editorCall("seed_autoeditpost_project", { autoEditRoot: state.bootstrap.defaults.autoEditRoot, sourceVideo: state.bootstrap.defaults.inputPath });
    await refreshProject(false); await refreshProjects(); await refreshAutomation(); applyWorkspace(state.project.settings?.workspace || "default"); renderProject();
    api.getActivePostizSchedule?.({ daysBefore: 2, daysAhead: 30 }).then((schedule) => { state.activeSchedule = schedule; if (!$("#publishingHub").hidden) renderActiveSchedule(); }).catch(() => { /* connection errors remain visible in the Postiz hub */ });
    const firstItem = Object.values(state.project.items)[0]; if (firstItem) { state.selectedItemId = firstItem.id; state.playhead = firstItem.from; await selectAsset(firstItem.assetId, firstItem.sourceStart); }
    addAgentMessage(`<strong>PROJECT READY</strong>I loaded the local AutoEditPost studio with ${Object.keys(state.project.assets).length} media assets and the completed talking-head pipeline. Your footage and renders remain on this computer.<div class="message-actions"><button data-message-action="automation">Open execution graph</button><button data-message-action="transcript">Open transcript</button></div>`);
    $("#assistantWelcome").classList.remove("compact"); $("#assistantScroll").scrollTop = 0;
    const route = parseAppRoute(); const captureView = new URLSearchParams(location.search).get("captureView");
    if (hostedNavigation() && route.view !== "editor") await applyAppRoute();
    else {
      if (captureView === "podcast") await openPodcast();
      if (["automation", "review", "seo", "publishing"].includes(captureView)) {
        $("#automationBackdrop").hidden = false; $("#automationDrawer").classList.add("open");
        if ((captureView === "review" || captureView === "seo") && state.pipeline?.reels?.length) openReelReviewer(state.pipeline.reels[0]);
        if (captureView === "seo") setTimeout(() => $(".seo-feedback-card")?.scrollIntoView({ block: "start" }), 1200);
        if (captureView === "publishing") await openPublishing();
      }
    }
    $("#bootScreen").classList.add("ready");
  } catch (error) {
    $("#bootScreen strong").textContent = "Local studio could not open"; $("#bootScreen span").textContent = error.message || String(error); $("#bootScreen i").style.display = "none"; toast(error.message || String(error), "error");
  }
}
init();
