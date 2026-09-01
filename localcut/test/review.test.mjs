import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverCandidateTimes, defaultCoverCopy, isFaceSafeCaptionY, normalizeCoverCopy, normalizeSeoPackage } from "../src/review.mjs";
import { computeReelApprovalRevision, resolveReelApproval } from "../src/approval.mjs";

test("cover copy turns a reel title into visible branded typography", () => {
  assert.deepEqual(defaultCoverCopy("Paying for silence", "01"), {
    kicker: "APPOINTMENT AUDIT",
    accent: "Paying",
    headline: "for silence",
  });
  assert.deepEqual(defaultCoverCopy("The boring part", "05"), {
    kicker: "APPOINTMENT AUDIT",
    accent: "The boring",
    headline: "part",
  });
});

test("explicit cover lettering is trimmed, bounded, and preserved", () => {
  assert.deepEqual(normalizeCoverCopy({ kicker: "  Audit  ", accent: "REAL\nCOST", headline: "No response  " }, "Ignored", "01"), {
    kicker: "Audit",
    accent: "REAL COST",
    headline: "No response",
  });
});

test("1270px is recognized as face-safe while face-level captions are not", () => {
  assert.equal(isFaceSafeCaptionY(1270), true);
  assert.equal(isFaceSafeCaptionY(1180), false);
  assert.equal(isFaceSafeCaptionY(460), true);
});

test("cover candidates include the selected frame and span the clean reel", () => {
  const times = coverCandidateTimes(40, 2.75);
  assert.equal(times[0], 2.75);
  assert.ok(times.length >= 8);
  assert.ok(times.every((time) => time >= 0 && time < 40));
  assert.ok(times.some((time) => time > 30));
  assert.ok(times.some((time) => time >= 39.9), "the last frames must be available for smiles and strong expressions");
  assert.equal(new Set(times).size, times.length);
});

test("per-reel SEO packages normalize editable keywords and hashtags", () => {
  assert.deepEqual(normalizeSeoPackage({ primaryPhrase: " appointment conversion ", related: "revenue systems, revenue systems, booked calls", hashtags: "sales ops, #CRM" }), {
    primaryPhrase: "appointment conversion",
    related: ["revenue systems", "booked calls"],
    hashtags: ["#salesops", "#CRM"],
    keywords: ["appointment conversion", "revenue systems", "booked calls"],
    metadataKeywords: "appointment conversion, revenue systems, booked calls",
  });
});

test("reel approval is bound to the exact video, cover, captions, SEO, and QA files", async () => {
  const root = await mkdtemp(join(tmpdir(), "localcut-approval-"));
  try {
    const paths = Object.fromEntries(["video", "cover", "captions", "seo", "qa"].map((name) => [name, join(root, `${name}.asset`)]));
    await Promise.all(Object.entries(paths).map(([name, path]) => writeFile(path, name)));
    const revision = await computeReelApprovalRevision(paths);
    const review = { approval: { status: "approved", revision, approvedAt: "2026-08-11T12:00:00.000Z" } };
    assert.equal(resolveReelApproval(review, revision).approved, true);
    await writeFile(paths.cover, "changed cover bytes");
    const changed = await computeReelApprovalRevision(paths); const expired = resolveReelApproval(review, changed);
    assert.notEqual(changed, revision); assert.equal(expired.approved, false); assert.equal(expired.stale, true); assert.equal(expired.status, "expired");
  } finally { await rm(root, { recursive: true, force: true }); }
});
