import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPipelineGraph, createPipelineManager, prepareLocalMediaBinaries, resetBatchNodes, resetReelNodes } from "../src/pipeline.mjs";

test("builds one seven-stage chain per reel and a batch join", () => {
  const nodes = buildPipelineGraph([{ id: "01", segments: [[0, 10]] }, { reel: 2, segments: [[20, 30]] }]);
  assert.equal(nodes.length, 16);
  assert.deepEqual(nodes.find((node) => node.id === "01:clean").deps, ["01:cut"]);
  assert.deepEqual(nodes.find((node) => node.id === "02:qa").deps, ["02:render"]);
  assert.deepEqual(nodes.at(-1).deps, ["01:qa", "02:qa"]);
});

test("rejects manifest rows with no stable reel identity", () => {
  assert.throws(() => buildPipelineGraph([{ segments: [[0, 1]] }]), /needs id or reel/);
});

test("resets one reel from a chosen stage without discarding other reel work", () => {
  const run = { id: "batch", reels: ["01", "02"], status: "completed", cancelRequested: false,
    nodes: buildPipelineGraph([{ id: "01", segments: [[0, 1]] }, { id: "02", segments: [[2, 3]] }]).map((node) => ({ ...node, status: "completed", attempts: 1 })) };
  const reset = resetReelNodes(run, "1", "captions");
  assert.deepEqual(reset, ["01:captions", "01:render", "01:qa", "finalize"]);
  assert.equal(run.nodes.find((node) => node.id === "01:speed").status, "completed");
  assert.equal(run.nodes.find((node) => node.id === "01:captions").status, "pending");
  assert.equal(run.nodes.find((node) => node.id === "02:qa").status, "completed");
  assert.equal(run.status, "ready");
});

test("resets every reel from captions while preserving completed edit stages", () => {
  const run = { id: "batch", reels: ["01", "02"], status: "completed", cancelRequested: false,
    nodes: buildPipelineGraph([{ id: "01", segments: [[0, 1]] }, { id: "02", segments: [[2, 3]] }]).map((node) => ({ ...node, status: "completed", attempts: 1 })) };
  const reset = resetBatchNodes(run, "captions");
  assert.deepEqual(reset, ["01:captions", "01:render", "01:qa", "02:captions", "02:render", "02:qa", "finalize"]);
  assert.equal(run.nodes.find((node) => node.id === "01:speed").status, "completed");
  assert.equal(run.nodes.find((node) => node.id === "02:captions").status, "pending");
  assert.equal(run.status, "ready");
});

test("active cancellation survives concurrent node checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "localcut-cancel-"));
  const autoEditRoot = join(root, "AutoEditPost");
  const dataDir = join(root, "data");
  const outputDir = join(root, "output");
  const inputPath = join(root, "input.mp4");
  const manifestPath = join(root, "manifest.json");
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousFfprobe = process.env.FFPROBE_PATH;
  try {
    await mkdir(join(autoEditRoot, "dist"), { recursive: true });
    await mkdir(join(autoEditRoot, "scripts"), { recursive: true });
    await writeFile(inputPath, "acceptance input");
    await writeFile(manifestPath, JSON.stringify([{ id: "01", segments: [[0, 1]] }]));
    await writeFile(join(autoEditRoot, "dist", "cli.js"), "");
    await writeFile(join(autoEditRoot, "scripts", "talking_head_stage.mjs"), "setTimeout(() => {}, 10000);\n");
    await writeFile(join(autoEditRoot, "scripts", "verify_talking_head_batch.mjs"), "process.exit(0);\n");
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    const binaries = await prepareLocalMediaBinaries();
    process.env.FFMPEG_PATH = binaries.ffmpeg;
    process.env.FFPROBE_PATH = binaries.ffprobe;

    const manager = createPipelineManager({ dataDir });
    const created = await manager.call("create_talking_head_pipeline", {
      name: "Cancellation race", inputPath, manifestPath, outputDir, autoEditRoot, concurrency: 1, retryLimit: 0,
    });
    await manager.call("run_talking_head_pipeline", { runId: created.id });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const acknowledgement = await manager.call("cancel_talking_head_pipeline", { runId: created.id });
    assert.equal(acknowledgement.cancelled, true);

    let settled;
    for (let attempt = 0; attempt < 50; attempt++) {
      settled = await manager.call("read_talking_head_pipeline", { runId: created.id });
      if (settled.summary.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(settled.summary.status, "cancelled");
    assert.equal(settled.nodes.some((node) => node.status === "running"), false);
    const persisted = JSON.parse(await readFile(join(dataDir, "pipelines", `${created.id}.json`), "utf8"));
    assert.equal(persisted.cancelRequested, true);
    assert.equal(persisted.status, "cancelled");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    await rm(root, { recursive: true, force: true });
  }
});

test("finalize runs independent batch acceptance before completing", async () => {
  const root = await mkdtemp(join(tmpdir(), "localcut-finalize-"));
  const autoEditRoot = join(root, "AutoEditPost"), dataDir = join(root, "data"), outputDir = join(root, "output");
  const inputPath = join(root, "input.mp4"), manifestPath = join(root, "manifest.json");
  const previousFfmpeg = process.env.FFMPEG_PATH, previousFfprobe = process.env.FFPROBE_PATH;
  try {
    await mkdir(join(autoEditRoot, "dist"), { recursive: true });
    await mkdir(join(autoEditRoot, "scripts"), { recursive: true });
    await writeFile(inputPath, "acceptance input");
    await writeFile(manifestPath, JSON.stringify([{ id: "01", outputName: "a_01", segments: [[0, 1]] }]));
    await writeFile(join(autoEditRoot, "dist", "cli.js"), "");
    await writeFile(join(autoEditRoot, "scripts", "talking_head_stage.mjs"), "process.exit(0);\n");
    await writeFile(join(autoEditRoot, "scripts", "verify_talking_head_batch.mjs"), `import { mkdir, writeFile } from "node:fs/promises";\nimport { join } from "node:path";\nconst a=process.argv.slice(2),p=a[a.indexOf("--proof")+1];await mkdir(p,{recursive:true});await writeFile(join(p,"proof.json"),JSON.stringify({ok:true}));\n`);
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    const binaries = await prepareLocalMediaBinaries();
    process.env.FFMPEG_PATH = binaries.ffmpeg;
    process.env.FFPROBE_PATH = binaries.ffprobe;
    const manager = createPipelineManager({ dataDir });
    const created = await manager.call("create_talking_head_pipeline", { name: "Finalize proof", inputPath, manifestPath, outputDir, autoEditRoot, concurrency: 1, retryLimit: 0 });
    await manager.call("run_talking_head_pipeline", { runId: created.id });
    let settled;
    for (let attempt = 0; attempt < 100; attempt++) {
      settled = await manager.call("read_talking_head_pipeline", { runId: created.id });
      if (["completed", "failed"].includes(settled.summary.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(settled.summary.status, "completed", JSON.stringify(settled.nodes.map(({ id, status, error }) => ({ id, status, error }))));
    const finalize = settled.nodes.find((node) => node.id === "finalize");
    assert.equal(finalize.status, "completed");
    assert.deepEqual(JSON.parse(await readFile(finalize.result.proof, "utf8")), { ok: true });
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    await rm(root, { recursive: true, force: true });
  }
});
