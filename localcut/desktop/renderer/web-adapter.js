(() => {
  if (window.localcut) return;

  const subscriptions = new Map();
  const uploadReceipts = new Map();
  const uploadListeners = new Set();
  const publish = (channel, payload) => {
    for (const callback of subscriptions.get(channel) || []) {
      try { callback(payload); } catch (error) { console.error(error); }
    }
  };
  const subscribe = (channel, callback) => {
    if (!subscriptions.has(channel)) subscriptions.set(channel, new Set());
    subscriptions.get(channel).add(callback);
    return () => subscriptions.get(channel)?.delete(callback);
  };
  const events = new EventSource("/events");
  events.onmessage = (event) => {
    try { const message = JSON.parse(event.data); publish(message.channel, message.payload); } catch (error) { console.error("LocalCut event error", error); }
  };
  events.onerror = () => document.documentElement.classList.add("web-reconnecting");
  events.onopen = () => document.documentElement.classList.remove("web-reconnecting");

  async function invoke(channel, ...args) {
    const response = await fetch(`/api/${encodeURIComponent(channel)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) });
    const payload = await response.json().catch(() => ({ ok: false, error: `LocalCut returned HTTP ${response.status}` }));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `LocalCut returned HTTP ${response.status}`);
    return payload.result;
  }

  const acceptFromFilters = (filters = []) => filters.flatMap((filter) => filter.extensions || []).map((extension) => `.${extension}`).join(",");
  function selectBrowserFile(options = {}) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = acceptFromFilters(options.filters); input.hidden = true;
      document.body.append(input);
      const finish = (value) => { input.remove(); resolve(value); };
      input.addEventListener("change", () => finish(input.files?.[0] || null), { once: true });
      window.addEventListener("focus", () => setTimeout(() => { if (!input.files?.length && document.body.contains(input)) finish(null); }, 500), { once: true });
      input.click();
    });
  }
  function uploadBrowserFile(file) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", `/upload?name=${encodeURIComponent(file.name)}`);
      request.responseType = "json";
      request.upload.onprogress = (event) => {
        const progress = { name: file.name, bytes: event.loaded, total: event.lengthComputable ? event.total : file.size, percent: event.lengthComputable ? event.loaded / event.total * 100 : null };
        for (const callback of uploadListeners) callback(progress);
      };
      request.onerror = () => reject(new Error("The browser upload could not reach LocalCut"));
      request.onload = () => {
        const payload = request.response || {};
        if (request.status < 200 || request.status >= 300) return reject(new Error(payload.error || `Upload failed with HTTP ${request.status}`));
        uploadReceipts.set(payload.path, payload); resolve(payload);
      };
      request.send(file);
    });
  }
  async function chooseFile(options) {
    const file = await selectBrowserFile(options);
    if (!file) return null;
    return (await uploadBrowserFile(file)).path;
  }
  const reveal = async (path) => {
    try { return await invoke("shell:reveal", path); } catch { return false; }
  };

  window.localcut = {
    bootstrap: async () => {
      const value = await invoke("system:bootstrap");
      return { ...value, web: true, upload: { enabled: true, configured: true, host: location.host, url: location.origin } };
    },
    chooseFile,
    chooseDirectory: async () => null,
    chooseSaveFile: async (options = {}) => options.defaultPath || null,
    uploadHealth: async () => ({ ok: true, configured: true, web: true }),
    uploadFile: async (path) => uploadReceipts.get(path) || invoke("upload:file", path),
    onUploadProgress: (callback) => { uploadListeners.add(callback); return () => uploadListeners.delete(callback); },
    editorCall: (name, args) => invoke("editor:call", name, args),
    listPipelines: () => invoke("pipeline:list"),
    readPipeline: (id) => invoke("pipeline:read", id),
    createPipeline: (config) => invoke("pipeline:create", config),
    startPipeline: (id, force) => invoke("pipeline:start", id, force),
    retryPipeline: (id) => invoke("pipeline:retry", id),
    cancelPipeline: (id) => invoke("pipeline:cancel", id),
    rerunReel: (id, reel, fromStage) => invoke("pipeline:rerun-reel", id, reel, fromStage),
    rebuildPipeline: (id) => invoke("pipeline:rebuild", id),
    saveSeo: (id, reel, seo) => invoke("review:save-seo", id, reel, seo),
    setReelApproval: (id, reel, approved) => invoke("review:set-approval", id, reel, approved),
    getCoverCandidates: (id, reel, atSeconds) => invoke("review:cover-candidates", id, reel, atSeconds),
    regenerateCover: (id, reel, atSeconds, feedback, coverCopy) => invoke("review:regenerate-cover", id, reel, atSeconds, feedback, coverCopy),
    regenerateAllCovers: (id) => invoke("review:regenerate-all-covers", id),
    redoCaptions: (id, reel, centerY, feedback) => invoke("review:redo-captions", id, reel, centerY, feedback),
    redoAllCaptions: (id, centerY, feedback) => invoke("review:redo-all-captions", id, centerY, feedback),
    setFraming: (id, reel, zoom, feedback) => invoke("review:set-framing", id, reel, zoom, feedback),
    prepareAndStartBatch: () => invoke("pipeline:prepare-and-start"),
    syncPipelineArtifacts: (id) => invoke("pipeline:sync-artifacts", id),
    getPublishing: (id) => invoke("publishing:snapshot", id),
    savePostizConfig: (config) => invoke("publishing:save-config", config),
    testPostiz: () => invoke("publishing:test"),
    getActivePostizSchedule: (options) => invoke("publishing:active-schedule", options),
    buildPostizPlan: (id, options) => invoke("publishing:build-plan", id, options),
    schedulePostizPlan: (planId, confirmation) => invoke("publishing:schedule-plan", planId, confirmation),
    onPublishingProgress: (callback) => subscribe("publishing:progress", callback),
    inspectPodcast: (inputPath) => invoke("podcast:inspect", inputPath),
    processPodcast: (inputPath, options) => invoke("podcast:process", inputPath, options),
    podcastHistory: () => invoke("podcast:history"),
    cancelPodcast: () => invoke("podcast:cancel"),
    onPodcastProgress: (callback) => subscribe("podcast:progress", callback),
    onBatchProgress: (callback) => subscribe("batch:progress", callback),
    reveal,
    open: reveal,
    copy: async (text) => { await navigator.clipboard.writeText(String(text)); return true; },
  };

  document.documentElement.classList.add("localcut-web");
})();
