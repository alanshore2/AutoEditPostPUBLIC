import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("Podcast Studio is fully wired through the installed-app layers", async () => {
  const [html, app, css, preload, main] = await Promise.all([
    readFile(new URL("desktop/renderer/index.html", root), "utf8"),
    readFile(new URL("desktop/renderer/app.js", root), "utf8"),
    readFile(new URL("desktop/renderer/podcast.css", root), "utf8"),
    readFile(new URL("desktop/preload.cjs", root), "utf8"),
    readFile(new URL("desktop/main.mjs", root), "utf8"),
  ]);
  for (const id of ["podcastButton", "podcastHub", "podcastDrop", "removePodcastSource", "processPodcast", "podcastSourceVideo", "podcastSourceAudio", "podcastOutputVideo", "podcastOutputAudio", "podcastResult"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="podcastRemoveHum"/);
  assert.match(html, /id="podcastClarity"/);
  assert.match(html, /Remove Focusrite \/ electrical hum/);
  for (const stage of ["inspect", "analyze", "isolate", "deepen", "trim", "loudness", "verify"]) assert.match(html, new RegExp(`data-podcast-stage="${stage}"`));
  assert.match(app, /api\.processPodcast\(state\.podcastSource\.inputPath, podcastOptions\(\)\)/);
  assert.match(app, /api\.onPodcastProgress/);
  assert.match(app, /function clearPodcastSource\(\)/);
  assert.match(app, /api\.cancelPodcast\(\)/);
  assert.match(preload, /processPodcast: \(inputPath, options\)/);
  assert.match(preload, /onPodcastProgress/);
  assert.match(main, /registerHandler\("podcast:process"/);
  assert.match(main, /createPodcastManager/);
  assert.match(css, /\.podcast-hub/);
});
