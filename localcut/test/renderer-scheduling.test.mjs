import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const rendererRoot = new URL("../desktop/renderer/", import.meta.url);

test("live Postiz scheduling uses a visible in-app confirmation instead of a hidden prompt", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("index.html", rendererRoot), "utf8"),
    readFile(new URL("app.js", rendererRoot), "utf8"),
    readFile(new URL("schedule-confirm.css", rendererRoot), "utf8"),
  ]);

  assert.match(html, /id="scheduleConfirmModal"/);
  assert.match(html, /id="scheduleConfirmText"/);
  assert.match(html, /id="startPostizSchedule"[^>]*disabled/);
  assert.doesNotMatch(app, /\bprompt\s*\(/);
  assert.match(app, /confirmation !== "SCHEDULE"/);
  assert.match(app, /schedulePostizPlan\(plan\.id, confirmation\)/);
  assert.match(app, /No carousels are included/);
  assert.match(styles, /\.schedule-confirm-backdrop/);
});

test("publishing preview visibly proves the exact reviewed cover without changing video frame zero", async () => {
  const app = await readFile(new URL("app.js", rendererRoot), "utf8");
  assert.match(app, /Exact reviewed cover applied/);
  assert.match(app, /coverSimilarity/);
  assert.match(app, /video starts at 0:00/);
  assert.match(app, /reel posts carried verified cover metadata/);
});

test("per-reel framing review is wired from the full-screen UI through rebuild and approval invalidation", async () => {
  const root = new URL("../", import.meta.url);
  const [html, app, preload, main] = await Promise.all([
    readFile(new URL("desktop/renderer/index.html", root), "utf8"),
    readFile(new URL("desktop/renderer/app.js", root), "utf8"),
    readFile(new URL("desktop/preload.cjs", root), "utf8"),
    readFile(new URL("desktop/main.mjs", root), "utf8"),
  ]);
  for (const id of ["framingZoom", "framingZoomValue", "framingFeedback", "applyFraming"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /api\.setFraming\(state\.pipeline\.id, reel/);
  assert.match(app, /markApprovalPending\(artifactForReel\(reel\), "framing"\)/);
  assert.match(preload, /setFraming: \(id, reel, zoom, feedback\)/);
  assert.match(main, /registerHandler\("review:set-framing"/);
  assert.match(main, /fromStage: "cut", force: true/);
});

test("browser control room exposes every production workflow through the authenticated web adapter", async () => {
  const root = new URL("../", import.meta.url);
  const [html, adapter, host, main] = await Promise.all([
    readFile(new URL("desktop/renderer/index.html", root), "utf8"),
    readFile(new URL("desktop/renderer/web-adapter.js", root), "utf8"),
    readFile(new URL("src/web-host.mjs", root), "utf8"),
    readFile(new URL("desktop/main.mjs", root), "utf8"),
  ]);
  assert.match(html, /connect-src 'self'/);
  assert.match(html, /<script src="web-adapter\.js"><\/script>\s*<script src="app\.js"><\/script>/);
  for (const method of ["prepareAndStartBatch", "setReelApproval", "getCoverCandidates", "redoCaptions", "setFraming", "processPodcast", "getActivePostizSchedule", "schedulePostizPlan"]) assert.match(adapter, new RegExp(`${method}:`));
  assert.match(adapter, /new XMLHttpRequest\(\)/);
  assert.match(adapter, /new EventSource\("\/events"\)/);
  assert.match(host, /accept-ranges/);
  assert.match(host, /MAX_UPLOAD_BYTES/);
  assert.match(host, /timingSafeEqual/);
  assert.match(main, /createLocalCutWebHost/);
  assert.match(main, /WEB_MODE/);
  assert.doesNotMatch(main, /url\.searchParams\.set\("token"/);
});

test("batch workspace has hideable execution graph and stable deep links", async () => {
  const root = new URL("../", import.meta.url);
  const [html, app, styles, host] = await Promise.all([
    readFile(new URL("desktop/renderer/index.html", root), "utf8"),
    readFile(new URL("desktop/renderer/app.js", root), "utf8"),
    readFile(new URL("desktop/renderer/styles.css", root), "utf8"),
    readFile(new URL("src/web-host.mjs", root), "utf8"),
  ]);
  for (const id of ["executionGraphSection", "toggleExecutionGraph", "copyBatchLink", "reviewReelSlider", "reviewReelSliderValue", "reviewReelTicks"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /\/batches\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(app, /window\.addEventListener\("popstate", applyAppRoute\)/);
  assert.match(app, /localStorage\.setItem\("localcut:execution-graph-hidden"/);
  assert.match(app, /\$\("#reviewReelSlider"\)\.onchange/);
  assert.match(app, /openReelReviewer\(reel\)/);
  assert.match(styles, /\.graph-section\.collapsed #automationGraph\{display:none\}/);
  assert.match(styles, /\.review-reel-slider/);
  assert.match(host, /APP_ROUTE\.test\(url\.pathname\)/);
});
