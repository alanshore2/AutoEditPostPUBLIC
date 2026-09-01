import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPublishingPlan, createPublishingManager, discoverCarouselLibrary, reconcilePostizSchedule, zonedDateTimeToUtc } from "../src/publishing.mjs";
import { computeReelApprovalRevision } from "../src/approval.mjs";

test("Eastern schedule conversion follows daylight-saving time", () => {
  assert.equal(zonedDateTimeToUtc("2026-01-15", "09:00", "America/New_York"), "2026-01-15T14:00:00.000Z");
  assert.equal(zonedDateTimeToUtc("2026-07-15", "09:00", "America/New_York"), "2026-07-15T13:00:00.000Z");
});

test("live Postiz calendar distinguishes tracked reels, carousels, and unmatched posts", () => {
  const lookup = { byPostId: new Map([
    ["post_reel", { kind: "reel", itemId: "06", title: "Hosted, not purchased", batchName: "Talking Heads", source: "localcut-state" }],
    ["post_carousel", { kind: "carousel", itemId: "c_009", title: "The actual leak", source: "autoeditpost-daily-carousel" }],
  ]) };
  const posts = reconcilePostizSchedule([
    { id: "post_reel", content: "Reel copy", publishDate: "2026-08-12T13:00:00.000Z", releaseURL: "", integration: { id: "ig", providerIdentifier: "instagram", name: "Creator" } },
    { id: "post_carousel", content: "Carousel copy", publishDate: "2026-08-12T17:00:00.000Z", releaseURL: "", integration: { id: "li", providerIdentifier: "linkedin-page", name: "Creator Page" } },
    { id: "outside", content: "A separate Postiz item.", publishDate: "2026-08-10T13:00:00.000Z", releaseURL: "https://example.test/post", integration: { id: "fb", providerIdentifier: "facebook" } },
  ], lookup, [], new Date("2026-08-11T12:00:00.000Z"));
  assert.deepEqual(posts.map((item) => item.kind), ["other", "reel", "carousel"]);
  assert.deepEqual(posts.map((item) => item.status), ["published", "scheduled", "scheduled"]);
  assert.equal(posts[1].tracked, true); assert.equal(posts[1].itemId, "06"); assert.equal(posts[2].platform, "linkedin");
});

test("publishing plan keeps the two-reel rhythm and gives every TikTok delivery a one-hour lead", () => {
  const snapshot = { runId: "run_1", batchName: "Batch", reels: [
    { id: "01", title: "One", ready: true, video: "one.mp4", cover: "one.jpg", coverAtSeconds: 1.25, durationSeconds: 10, caption: "One caption", pinnedComment: "" },
    { id: "02", title: "Two", ready: true, video: "two.mp4", cover: "two.jpg", coverAtSeconds: 3, durationSeconds: 10, caption: "Two caption", pinnedComment: "" },
    { id: "03", title: "Three", ready: true, video: "three.mp4", cover: "three.jpg", coverAtSeconds: 12, durationSeconds: 10, caption: "Three caption", pinnedComment: "" },
  ], carousels: [{ id: "c_001", title: "Deck", ready: true, slides: ["1.png", "2.png"], slideCount: 2, video: "deck.mp4", caption: "Deck caption", scheduledBefore: false }] };
  const plan = buildPublishingPlan(snapshot, { startDate: "2026-08-11", reelTimes: ["09:00", "18:00"], carouselTime: "13:00", timeZone: "America/New_York", platforms: ["instagram", "tiktok"], reelIds: ["01","02","03"], carouselIds: ["c_001"] });
  assert.deepEqual(plan.items.filter((item) => item.kind === "reel").map((item) => `${item.date} ${item.time}`), ["2026-08-11 09:00", "2026-08-11 18:00", "2026-08-12 09:00"]);
  const firstReel = plan.items.find((item) => item.kind === "reel");
  assert.equal(firstReel.assets.cover, "one.jpg"); assert.equal(firstReel.assets.coverTimestampMs, 1250);
  assert.equal(plan.items.find((item) => item.id === "03").assets.coverTimestampMs, 9950);
  assert.equal(firstReel.deliveries.find((item) => item.platform === "instagram").scheduledAt, "2026-08-11T13:00:00.000Z");
  assert.equal(firstReel.deliveries.find((item) => item.platform === "tiktok").scheduledAt, "2026-08-11T12:00:00.000Z");
  const carousel = plan.items.find((item) => item.kind === "carousel");
  assert.equal(carousel.deliveries.find((item) => item.platform === "instagram").scheduledAt, "2026-08-11T17:00:00.000Z");
  assert.equal(carousel.deliveries.find((item) => item.platform === "tiktok").scheduledAt, "2026-08-11T16:00:00.000Z");
  assert.equal(plan.summary.posts, 8);
});

test("carousel discovery returns rendered slide packages and prior schedule labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "localcut-carousel-"));
  try {
    const deck = join(root, "out", "ghl", "native", "c_001"); await mkdir(deck, { recursive: true });
    await Promise.all([writeFile(join(deck, "slide_1.png"), "one"), writeFile(join(deck, "slide_2.png"), "two")]);
    await writeFile(join(root, "out", "ghl", "deck_specs.json"), JSON.stringify([{ i: 0, hook: { h1: "A useful hook", lede: "The setup" }, outcome: "booked" }]));
    await writeFile(join(root, "out", "ghl", "scheduled_native.json"), JSON.stringify({ 0: { instagram: "post_1" } }));
    const library = await discoverCarouselLibrary(root);
    assert.equal(library.length, 1); assert.equal(library[0].slideCount, 2); assert.equal(library[0].scheduledBefore, true);
    assert.deepEqual(library[0].scheduledPlatforms, ["instagram"]); assert.match(library[0].caption, /Comment TEARDOWN/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("saved Postiz plans upload once, store post IDs, and resume without duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "localcut-publish-")); const dataDir = join(root, "data"); const outputDir = join(root, "out", "talking-heads", "batch");
  try {
    const reelDir = join(outputDir, "a_01"), carouselDir = join(root, "out", "ghl", "native", "c_001"), videoDir = join(root, "out", "ghl", "native", "video");
    await Promise.all([mkdir(reelDir, { recursive: true }), mkdir(carouselDir, { recursive: true }), mkdir(videoDir, { recursive: true })]);
    const video = join(reelDir, "a_01_FINAL.mp4"), qa = join(reelDir, "qa.json"), manifest = join(outputDir, "manifest.json");
    await Promise.all([
      writeFile(video, "video"), writeFile(join(reelDir, "a_01_cover.jpg"), "cover"), writeFile(join(reelDir, "cap.ass"), "captions"),
      writeFile(join(reelDir, "seo-keywords.json"), JSON.stringify({ primaryPhrase: "appointment conversion", hashtags: ["#SalesOps"] })),
      writeFile(qa, JSON.stringify({ ok: true, title: "Reel one", postCaption: "Post copy", media: { duration: 8 }, effects: { coverAtSeconds: 6.5 } })),
      writeFile(manifest, JSON.stringify([{ id: "01", title: "Reel one", postCaption: "Post copy", keyword: { pinnedComment: "Comment AUDIT and I will send it." }, seo: { hashtags: ["#SalesOps"] } }])),
      writeFile(join(carouselDir, "slide_1.png"), "slide1"), writeFile(join(carouselDir, "slide_2.png"), "slide2"), writeFile(join(videoDir, "c_001.mp4"), "slideshow"),
      writeFile(join(root, "out", "ghl", "deck_specs.json"), JSON.stringify([{ i: 0, hook: { h1: "Deck one", lede: "Swipe" } }])),
    ]);
    const run = { id: "run_1", name: "Acceptance batch", config: { manifestPath: manifest, outputDir }, artifacts: [{ reel: "01", label: "a_01", video, qa }] };
    const pipelineManager = { call: async (name) => name === "list_talking_head_pipelines" ? { pipelines: [{ id: run.id }] } : run };
    let uploadCalls = 0, postCalls = 0; const postedBodies = [], createdPosts = [];
    process.env.POSTIZ_IG = "ig-integration-1";
    process.env.POSTIZ_YOUTUBE = "yt-integration-1";
    process.env.LOCALCUT_YOUTUBE_SITE = "example.com";
    const fetchImpl = async (url, options = {}) => {
      if (String(url).endsWith("/integrations")) return new Response(JSON.stringify([
        { id: "ig-integration-1", identifier: "instagram", disabled: false },
        { id: "yt-integration-1", identifier: "youtube", disabled: false },
      ]), { status: 200, headers: { "content-type": "application/json" } });
      if (String(url).includes("/posts?") && !options.method) return new Response(JSON.stringify({ posts: createdPosts }), { status: 200, headers: { "content-type": "application/json" } });
      if (String(url).endsWith("/upload")) return new Response(JSON.stringify({ id: `media_${++uploadCalls}`, path: `https://example.test/media_${uploadCalls}` }), { status: 200, headers: { "content-type": "application/json" } });
      if (String(url).endsWith("/posts") && options.method === "POST") {
        const body = JSON.parse(options.body), postId = `post_${++postCalls}`; postedBodies.push(body);
        createdPosts.push({ id: postId, state: "QUEUE", publishDate: body.date, content: body.posts[0].value[0].content, integration: { id: body.posts[0].integration.id } });
        return new Response(JSON.stringify([{ postId }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url).includes("/posts/") && options.method === "DELETE") {
        const id = String(url).split("/").at(-1), index = createdPosts.findIndex((post) => post.id === id);
        if (index >= 0) createdPosts.splice(index, 1);
        return new Response("{}", { status: index >= 0 ? 200 : 404, headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    const preparePublishMaster = async ({ video: sourceVideo }) => {
      const publishVideo = join(reelDir, "a_01_POSTIZ.mp4"); await writeFile(publishVideo, "video-with-exact-cover-tail");
      return { publishVideo, coverTimestampMs: 8033, coverSimilarity: 0.99, openingStartsAtZero: true,
        openingFramesVerified: 8, appendedSeconds: 0.033, fingerprint: "proof" };
    };
    const manager = createPublishingManager({ autoEditRoot: root, dataDir, pipelineManager, getCredential: async () => ({ key: "test-key", apiUrl: "https://postiz.test/v1" }),
      fetchImpl, createGapMs: 0, now: () => new Date("2026-08-10T12:00:00.000Z"), preparePublishMaster });
    const unapproved = await manager.snapshot(run.id); assert.equal(unapproved.reels[0].technicalReady, true); assert.equal(unapproved.reels[0].ready, false);
    await assert.rejects(manager.savePlan(run.id, { startDate: "2026-08-12", platforms: ["instagram"], reelIds: ["01"], carouselIds: [] }), /Select at least one ready reel/);
    const approvalRevision = await computeReelApprovalRevision({ video, cover: join(reelDir, "a_01_cover.jpg"), captions: join(reelDir, "cap.ass"), seo: join(reelDir, "seo-keywords.json"), qa });
    await writeFile(join(reelDir, "review-feedback.json"), JSON.stringify({ cover: { atSeconds: 4.25 }, approval: { status: "approved", revision: approvalRevision, approvedAt: "2026-08-10T12:00:00.000Z" } }));
    const snapshot = await manager.snapshot(run.id); assert.equal(snapshot.reels[0].ready, true); assert.equal(snapshot.reels[0].approval.approved, true); assert.equal(snapshot.carousels.length, 1);
    const plan = await manager.savePlan(run.id, { startDate: "2026-08-12", platforms: ["instagram", "youtube"], reelIds: ["01"], carouselIds: ["c_001"] });
    assert.equal(plan.summary.posts, 4); await assert.rejects(manager.schedulePlan(plan.id, "yes"), /exact confirmation/);
    const result = await manager.schedulePlan(plan.id, "SCHEDULE"); assert.equal(result.completed, 4); assert.equal(result.verified, 4); assert.equal(result.coverPayloads, 2); assert.equal(postCalls, 4); assert.equal(uploadCalls, 5);
    assert.deepEqual(postedBodies.map((body) => body.posts[0].settings.__type), ["instagram", "youtube", "instagram", "youtube"]);
    assert.match(postedBodies[0].posts[0].value[0].content, /Comment AUDIT/);
    assert.match(postedBodies[1].posts[0].value[0].content, /Work with me: example\.com/);
    assert.equal(postedBodies[0].posts[0].value[0].image[0].path, "https://example.test/media_1");
    assert.equal(postedBodies[0].posts[0].value[0].image[0].thumbnail, "https://example.test/media_2");
    assert.equal(postedBodies[0].posts[0].value[0].image[0].thumbnailTimestamp, 8033);
    assert.equal(postedBodies[1].posts[0].value[0].image[0].path, "https://example.test/media_1");
    assert.equal(postedBodies[1].posts[0].value[0].image[0].thumbnailTimestamp, 8033);
    assert.equal("thumbnail" in postedBodies[1].posts[0].settings, false);
    const firstSaved = JSON.parse(await readFile(join(outputDir, "postiz-schedule-state.json"), "utf8"));
    assert.equal(firstSaved.posts["reel:01:instagram"].cover.thumbnailTimestamp, 8033);
    assert.equal(firstSaved.posts["reel:01:instagram"].cover.payloadVerified, true);
    assert.equal(firstSaved.posts["reel:01:instagram"].cover.exactReviewedCover, true);
    await rm(join(outputDir, "postiz-schedule-state.json"));
    await manager.schedulePlan(plan.id, "SCHEDULE"); assert.equal(postCalls, 4); assert.equal(uploadCalls, 5);
    const savedPath = join(outputDir, "postiz-schedule-state.json");
    const saved = JSON.parse(await readFile(savedPath, "utf8")); assert.equal(Object.keys(saved.posts).length, 4);
    const calendar = await manager.activeSchedule({ daysBefore: 0, daysAhead: 7 });
    assert.equal(calendar.summary.scheduled, 4); assert.equal(calendar.summary.scheduledReels, 2); assert.equal(calendar.summary.scheduledCarousels, 2);
    assert.equal(calendar.summary.tracked, 4); assert.ok(calendar.posts.every((item) => item.tracked));
    saved.posts["reel:01:instagram"].cover.exactReviewedCover = false; await writeFile(savedPath, JSON.stringify(saved));
    const audit = await manager.repairScheduledCovers({ planId: plan.id }); assert.equal(audit.dryRun, true); assert.equal(audit.candidates.length, 1);
    await assert.rejects(manager.repairScheduledCovers({ planId: plan.id, commit: true, confirmation: "yes" }), /exact confirmation/);
    const repaired = await manager.repairScheduledCovers({ planId: plan.id, commit: true, confirmation: "REPAIR COVERS" });
    assert.equal(repaired.repaired, 1); assert.equal(postCalls, 5); assert.equal(createdPosts.length, 4);
    assert.equal(postedBodies.at(-1).posts[0].value[0].image[0].thumbnailTimestamp, 8033);
    const repairedState = JSON.parse(await readFile(join(outputDir, "postiz-schedule-state.json"), "utf8"));
    assert.equal(repairedState.posts["reel:01:instagram"].replacedPostId, "post_1");
    assert.equal(repairedState.posts["reel:01:instagram"].cover.payloadVerified, true);
    assert.equal(repairedState.posts["reel:01:instagram"].cover.exactReviewedCover, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
