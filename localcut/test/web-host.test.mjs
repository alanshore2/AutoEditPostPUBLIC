import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLocalCutWebHost } from "../src/web-host.mjs";

test("authenticated web host serves the studio, invokes real handlers, streams media, and receives uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "localcut-web-"));
  const rendererDir = join(root, "renderer"), assetsDir = join(root, "assets"), dataDir = join(root, "data"), rawDir = join(root, "Raw");
  const media = join(rawDir, "sample.mp4");
  await Promise.all([mkdir(rendererDir), mkdir(assetsDir), mkdir(rawDir)]);
  await writeFile(join(rendererDir, "index.html"), "<!doctype html><title>LocalCut Web</title>");
  await writeFile(join(rendererDir, "app.js"), "window.ready=true;");
  await writeFile(join(assetsDir, "mark.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  await writeFile(media, Buffer.from("0123456789abcdef"));
  const handlers = new Map([
    ["echo", async (event, value) => { event.sender.send("echo:progress", { value }); return { value, media: pathToFileURL(media).href }; }],
  ]);
  let host;
  try {
    host = await createLocalCutWebHost({ rendererDir, assetsDir, dataDir, rawDir, allowedRoots: [root], handlers, host: "127.0.0.1", port: 0, token: "test-token" });
    assert.equal((await fetch(host.localUrl)).status, 401);
    const login = await fetch(`${host.localUrl}/?token=test-token`, { redirect: "manual" });
    assert.equal(login.status, 302);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const page = await fetch(host.localUrl, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /LocalCut Web/);
    const batchRoute = await fetch(`${host.localUrl}/batches/pipeline_test/reels/05`, { headers: { cookie } });
    assert.equal(batchRoute.status, 200);
    const batchHtml = await batchRoute.text();
    assert.match(batchHtml, /LocalCut Web/);
    assert.match(batchHtml, /<base href="\/">/);
    const podcastRoute = await fetch(`${host.localUrl}/podcast`, { headers: { cookie } });
    assert.equal(podcastRoute.status, 200);
    assert.match(await podcastRoute.text(), /LocalCut Web/);

    const invoked = await fetch(`${host.localUrl}/api/echo`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ args: ["working"] }) });
    const payload = await invoked.json();
    assert.equal(payload.result.value, "working");
    assert.match(payload.result.media, /^\/media\//);
    const ranged = await fetch(`${host.localUrl}${payload.result.media}`, { headers: { cookie, range: "bytes=2-5" } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), "2345");

    const uploaded = await fetch(`${host.localUrl}/upload?name=recording.mp4`, { method: "POST", headers: { cookie, "content-type": "video/mp4" }, body: Buffer.from("uploaded media") });
    const receipt = await uploaded.json();
    assert.equal(receipt.verified, true);
    assert.equal(await readFile(receipt.path, "utf8"), "uploaded media");
    assert.equal(JSON.parse(await readFile(join(dataDir, "web-session.json"), "utf8")).port, host.port);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});
