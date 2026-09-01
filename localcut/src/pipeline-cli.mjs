#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createPipelineManager } from "./pipeline.mjs";

const argv = process.argv.slice(2);
const command = argv.shift() || "help";
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const required = (name) => {
  const result = value(name);
  if (!result) throw new Error(`Missing ${name}`);
  return result;
};
const dataDir = resolve(process.env.LOCALCUT_DATA_DIR || join(homedir(), ".localcut"));
const manager = createPipelineManager({ dataDir });
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function follow(id) {
  let last = "";
  while (true) {
    const run = await manager.call("read_talking_head_pipeline", { runId: id, includeNodes: false });
    const line = `${run.summary.status}: ${run.summary.completed}/${run.summary.nodes} nodes (${Math.round(run.summary.progress * 100)}%)`;
    if (line !== last) console.log(line);
    last = line;
    if (["completed", "failed", "cancelled"].includes(run.summary.status)) {
      if (run.summary.status !== "completed") process.exitCode = 1;
      return run;
    }
    await sleep(500);
  }
}

if (command === "run") {
  const created = await manager.call("create_talking_head_pipeline", {
    name: value("--name", "Talking-head batch"),
    inputPath: required("--input"),
    manifestPath: required("--manifest"),
    outputDir: required("--out"),
    autoEditRoot: value("--aep"),
    concurrency: Number(value("--concurrency", "2")),
    retryLimit: Number(value("--retries", "2")),
  });
  console.log(`created ${created.id} (${created.reels} reels)`);
  await manager.call("run_talking_head_pipeline", { runId: created.id, force: argv.includes("--force") });
  const result = await follow(created.id);
  console.log(JSON.stringify({ id: result.id, summary: result.summary, artifacts: result.artifacts }, null, 2));
} else if (command === "resume") {
  const id = argv[0];
  if (!id) throw new Error("usage: pipeline-cli.mjs resume <pipeline-id>");
  await manager.call("run_talking_head_pipeline", { runId: id, force: argv.includes("--force") });
  await follow(id);
} else if (command === "retry") {
  const id = argv[0];
  if (!id) throw new Error("usage: pipeline-cli.mjs retry <pipeline-id>");
  await manager.call("retry_talking_head_pipeline", { runId: id });
  await follow(id);
} else if (command === "status") {
  const id = argv[0];
  if (!id) throw new Error("usage: pipeline-cli.mjs status <pipeline-id>");
  console.log(JSON.stringify(await manager.call("read_talking_head_pipeline", { runId: id }), null, 2));
} else if (command === "list") {
  console.log(JSON.stringify(await manager.call("list_talking_head_pipelines", {}), null, 2));
} else {
  console.log(`LocalCut talking-head pipeline

Run a batch:
  node src/pipeline-cli.mjs run --name "Reliability batch" --input <video> --manifest <cutlists.json> --out <folder> --aep <AutoEditPost> [--concurrency 2]

Resume/status:
  node src/pipeline-cli.mjs resume <pipeline-id>
  node src/pipeline-cli.mjs retry <pipeline-id>
  node src/pipeline-cli.mjs status <pipeline-id>
  node src/pipeline-cli.mjs list`);
}
