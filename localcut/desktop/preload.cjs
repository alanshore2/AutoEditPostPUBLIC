const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localcut", {
  bootstrap: () => ipcRenderer.invoke("system:bootstrap"),
  chooseFile: (options) => ipcRenderer.invoke("dialog:file", options),
  chooseDirectory: (options) => ipcRenderer.invoke("dialog:directory", options),
  chooseSaveFile: (options) => ipcRenderer.invoke("dialog:save", options),
  uploadHealth: () => ipcRenderer.invoke("upload:health"),
  uploadFile: (filePath) => ipcRenderer.invoke("upload:file", filePath),
  onUploadProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("upload:progress", listener);
    return () => ipcRenderer.removeListener("upload:progress", listener);
  },
  editorCall: (name, args) => ipcRenderer.invoke("editor:call", name, args),
  listPipelines: () => ipcRenderer.invoke("pipeline:list"),
  readPipeline: (id) => ipcRenderer.invoke("pipeline:read", id),
  createPipeline: (config) => ipcRenderer.invoke("pipeline:create", config),
  startPipeline: (id, force) => ipcRenderer.invoke("pipeline:start", id, force),
  retryPipeline: (id) => ipcRenderer.invoke("pipeline:retry", id),
  cancelPipeline: (id) => ipcRenderer.invoke("pipeline:cancel", id),
  rerunReel: (id, reel, fromStage) => ipcRenderer.invoke("pipeline:rerun-reel", id, reel, fromStage),
  rebuildPipeline: (id) => ipcRenderer.invoke("pipeline:rebuild", id),
  saveSeo: (id, reel, seo) => ipcRenderer.invoke("review:save-seo", id, reel, seo),
  setReelApproval: (id, reel, approved) => ipcRenderer.invoke("review:set-approval", id, reel, approved),
  getCoverCandidates: (id, reel, atSeconds) => ipcRenderer.invoke("review:cover-candidates", id, reel, atSeconds),
  regenerateCover: (id, reel, atSeconds, feedback, coverCopy) => ipcRenderer.invoke("review:regenerate-cover", id, reel, atSeconds, feedback, coverCopy),
  regenerateAllCovers: (id) => ipcRenderer.invoke("review:regenerate-all-covers", id),
  redoCaptions: (id, reel, centerY, feedback) => ipcRenderer.invoke("review:redo-captions", id, reel, centerY, feedback),
  redoAllCaptions: (id, centerY, feedback) => ipcRenderer.invoke("review:redo-all-captions", id, centerY, feedback),
  setFraming: (id, reel, zoom, feedback) => ipcRenderer.invoke("review:set-framing", id, reel, zoom, feedback),
  prepareAndStartBatch: () => ipcRenderer.invoke("pipeline:prepare-and-start"),
  syncPipelineArtifacts: (id) => ipcRenderer.invoke("pipeline:sync-artifacts", id),
  getPublishing: (id) => ipcRenderer.invoke("publishing:snapshot", id),
  savePostizConfig: (config) => ipcRenderer.invoke("publishing:save-config", config),
  testPostiz: () => ipcRenderer.invoke("publishing:test"),
  getActivePostizSchedule: (options) => ipcRenderer.invoke("publishing:active-schedule", options),
  buildPostizPlan: (id, options) => ipcRenderer.invoke("publishing:build-plan", id, options),
  schedulePostizPlan: (planId, confirmation) => ipcRenderer.invoke("publishing:schedule-plan", planId, confirmation),
  onPublishingProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("publishing:progress", listener);
    return () => ipcRenderer.removeListener("publishing:progress", listener);
  },
  inspectPodcast: (inputPath) => ipcRenderer.invoke("podcast:inspect", inputPath),
  processPodcast: (inputPath, options) => ipcRenderer.invoke("podcast:process", inputPath, options),
  podcastHistory: () => ipcRenderer.invoke("podcast:history"),
  cancelPodcast: () => ipcRenderer.invoke("podcast:cancel"),
  onPodcastProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("podcast:progress", listener);
    return () => ipcRenderer.removeListener("podcast:progress", listener);
  },
  onBatchProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("batch:progress", listener);
    return () => ipcRenderer.removeListener("batch:progress", listener);
  },
  reveal: (path) => ipcRenderer.invoke("shell:reveal", path),
  open: (path) => ipcRenderer.invoke("shell:open", path),
  copy: (text) => ipcRenderer.invoke("clipboard:write", text),
});
