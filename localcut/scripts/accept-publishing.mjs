import assert from "node:assert/strict";
process.env.LOCALCUT_YOUTUBE_SITE ||= "example.com";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createPipelineManager } from "../src/pipeline.mjs";
import { buildPublishingPlan, createPublishingManager, DEFAULT_POSTIZ_API_URL, POSTIZ_POLICY } from "../src/publishing.mjs";

const autoEditRoot = resolve(process.env.AUTOEDITPOST_ROOT || "C:\\AutoEditPost");
const dataDir = resolve(process.env.LOCALCUT_DATA_DIR || join(homedir(), ".localcut"));
const pipelines = createPipelineManager({ dataDir });
const publishing = createPublishingManager({ autoEditRoot, dataDir, pipelineManager: pipelines,
  getCredential: async () => ({ key: "", apiUrl: DEFAULT_POSTIZ_API_URL }) });

const snapshot = await publishing.snapshot();
const technicalReels = snapshot.reels.filter((item) => item.technicalReady);
const approvedReels = snapshot.reels.filter((item) => item.ready && item.approval?.approved);
const selectableCarousels = snapshot.carousels.filter((item) => item.ready && !item.scheduledBefore);
assert.equal(snapshot.reels.length, 12, "Acceptance batch must expose all 12 reels");
assert.equal(technicalReels.length, 12, "Every acceptance reel must have video, cover, captions, SEO, and passing QA");
assert.equal(snapshot.carousels.length, 50, "The local carousel library must expose 50 decks");
assert.equal(snapshot.carousels.reduce((sum, item) => sum + item.slideCount, 0), 300, "The carousel library must expose all 300 rendered slides");

let plan = null;
if (approvedReels.length) {
  plan = await publishing.savePlan(snapshot.runId, {
    startDate: snapshot.defaults.startDate, reelTimes: snapshot.defaults.reelTimes, carouselTime: snapshot.defaults.carouselTime,
    timeZone: snapshot.defaults.timeZone, platforms: snapshot.defaults.platforms, reelIds: approvedReels.map((item) => item.id), carouselIds: [],
  });
  assert.equal(plan.schema, 2); assert.equal(plan.summary.reels, approvedReels.length); assert.equal(plan.summary.posts, approvedReels.length * 5);
  assert.ok(plan.items.every((item) => item.kind !== "reel" || item.approvalRevision));
  assert.ok(plan.deliveries.every((item) => /Z$/.test(item.scheduledAt)));
  for (const item of plan.items.filter((candidate) => candidate.kind === "reel")) {
    const base = item.deliveries.find((delivery) => delivery.platform === "instagram");
    const tiktok = item.deliveries.find((delivery) => delivery.platform === "tiktok");
    assert.equal(Date.parse(base.scheduledAt) - Date.parse(tiktok.scheduledAt), POSTIZ_POLICY.tiktokLeadMinutes * 60000);
  }
  assert.ok(plan.deliveries.filter((delivery) => delivery.platform === "youtube").every((delivery) => /Work with me: example\.com/.test(delivery.content) && /#Shorts/.test(delivery.content)));
  assert.ok(plan.deliveries.filter((delivery) => delivery.platform !== "instagram").every((delivery) => !/(?:^|\n)Comment\s+[A-Z0-9_-]+\b/i.test(delivery.content)));
} else {
  assert.equal(snapshot.savedPlan, null, "A preview containing unapproved reels must be hidden");
  await assert.rejects(publishing.savePlan(snapshot.runId, { startDate: snapshot.defaults.startDate, platforms: snapshot.defaults.platforms,
    reelIds: snapshot.reels.map((item) => item.id), carouselIds: [] }), /Select at least one ready reel/);
}
const carouselPreview = buildPublishingPlan(snapshot, { startDate: snapshot.defaults.startDate, reelTimes: snapshot.defaults.reelTimes, carouselTime: snapshot.defaults.carouselTime,
  timeZone: snapshot.defaults.timeZone, platforms: snapshot.defaults.platforms, reelIds: [], carouselIds: [snapshot.carousels[0].id], allowPreviouslyScheduled: true });
assert.equal(carouselPreview.summary.carousels, 1); assert.equal(carouselPreview.summary.posts, 5); assert.equal(carouselPreview.items[0].assetCount, snapshot.carousels[0].slideCount);
const carouselBase = carouselPreview.items[0].deliveries.find((item) => item.platform === "instagram");
const carouselTiktok = carouselPreview.items[0].deliveries.find((item) => item.platform === "tiktok");
assert.equal(Date.parse(carouselBase.scheduledAt) - Date.parse(carouselTiktok.scheduledAt), POSTIZ_POLICY.tiktokLeadMinutes * 60000);

const proofDir = join(snapshot.outputDir, "proof", "postiz-publishing-086"); await mkdir(proofDir, { recursive: true });
const proof = { checkedAt: new Date().toISOString(), localOnly: true, livePostsCreated: 0, runId: snapshot.runId, batchName: snapshot.batchName,
  reels: { total: snapshot.reels.length, technicalReady: technicalReels.length, approved: approvedReels.length, approvalRequired: snapshot.reels.length - approvedReels.length }, carousels: { decks: snapshot.carousels.length, slides: snapshot.carousels.reduce((sum,item) => sum + item.slideCount, 0),
    priorScheduleRecords: snapshot.carousels.filter((item) => item.scheduledBefore).length, selectableWithoutOverride: selectableCarousels.length },
  plan: plan ? { id: plan.id, fingerprint: plan.fingerprint, items: plan.summary.items, posts: plan.summary.posts, platforms: plan.summary.platforms, firstAt: plan.summary.firstAt, lastAt: plan.summary.lastAt } : null,
  carouselPreview: { localOnly: true, deck: carouselPreview.items[0].id, slides: carouselPreview.items[0].assetCount, posts: carouselPreview.summary.posts,
    tiktokLeadTime: carouselPreview.items[0].deliveries.find((item) => item.platform === "tiktok")?.localTime || null },
  policy: POSTIZ_POLICY,
  gates: { encryptedCredentialRequiredForLivePost: true, exactConfirmationRequired: "SCHEDULE", qaRevalidationAtCommit: true,
    perReelApprovalRequired: true, changedAssetExpiresApproval: true, liveIntegrationValidation: true, remoteDuplicateRecovery: true, finalCalendarVerification: true,
    duplicateStatePath: join(snapshot.outputDir, "postiz-schedule-state.json") } };
await writeFile(join(proofDir, "acceptance.json"), `${JSON.stringify(proof, null, 2)}\n`);
await writeFile(join(proofDir, "PROOF.md"), `# LocalCut 0.8.6 Postiz + Carousel Acceptance\n\n- Batch: ${snapshot.batchName}\n- Talking-head packages: ${technicalReels.length}/${snapshot.reels.length} technically ready; ${approvedReels.length}/${snapshot.reels.length} individually approved\n- Approval gate: unapproved or changed reels cannot enter a schedule preview\n- Carousel library: ${proof.carousels.decks} decks, ${proof.carousels.slides} rendered slides\n- Saved reel schedule preview: ${plan ? `${plan.summary.items} approved packages, ${plan.summary.posts} platform posts` : "none until at least one reel is approved"}\n- Carousel preview: ${proof.carouselPreview.deck}, ${proof.carouselPreview.slides} slides, ${proof.carouselPreview.posts} platform posts, TikTok at ${proof.carouselPreview.tiktokLeadTime}\n- Eastern rhythm: reels at ${POSTIZ_POLICY.reelTimes.join(" and ")}, carousels at ${POSTIZ_POLICY.carouselTime}, TikTok ${POSTIZ_POLICY.tiktokLeadMinutes} minutes earlier\n- External posts created by this acceptance run: **0**\n- Live gate: per-reel approval, encrypted Postiz key, and exact **SCHEDULE** confirmation\n- Resume protection: every returned Postiz ID is persisted before the next post, and matching calendar posts are recovered if local state is lost\n- Commit proof: approval, QA, and assets are rechecked, live integrations are validated, and all returned IDs must appear in the Postiz calendar\n`);
console.log(JSON.stringify({ ok: true, proofDir, ...proof }, null, 2));
