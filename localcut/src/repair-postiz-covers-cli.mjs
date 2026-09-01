import { writeFile } from "node:fs/promises";
import { createPipelineManager } from "./pipeline.mjs";
import { createPublishingManager, DEFAULT_POSTIZ_API_URL } from "./publishing.mjs";

const dataDir = process.env.LOCALCUT_DATA_DIR || "C:/Users/you/.localcut";
const key = String(process.env.POSTIZ_KEY || "").trim();
if (!key) throw new Error("The in-memory Postiz credential was not provided");
const pipelineManager = createPipelineManager({ dataDir });
const publishing = createPublishingManager({
  autoEditRoot: process.env.AUTOEDITPOST_ROOT || "C:/AutoEditPost",
  dataDir,
  pipelineManager,
  getCredential: async () => ({ key, apiUrl: process.env.POSTIZ_API_URL || DEFAULT_POSTIZ_API_URL }),
});
const result = await publishing.repairScheduledCovers({
  planId: process.env.LOCALCUT_POSTIZ_REPAIR_PLAN_ID || null,
  commit: process.env.LOCALCUT_POSTIZ_REPAIR_COMMIT === "1",
  confirmation: process.env.LOCALCUT_POSTIZ_REPAIR_CONFIRMATION || "",
}, (progress) => process.stderr.write(`${JSON.stringify(progress)}\n`));
const receipt = String(process.env.LOCALCUT_POSTIZ_REPAIR_OUTPUT || "").trim();
if (receipt) await writeFile(receipt, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
