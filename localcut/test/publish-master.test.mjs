import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ensureExactCoverPublishMaster } from "../src/publish-master.mjs";
import { prepareLocalMediaBinaries } from "../src/pipeline.mjs";

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => stderr += chunk.toString()); child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1200)}`)));
  });
}

test("publishing master uses the exact reviewed cover without changing the opening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "localcut-exact-cover-"));
  try {
    const { ffmpeg } = await prepareLocalMediaBinaries();
    const source = join(directory, "reel_FINAL.mp4"), cover = join(directory, "reel_cover.jpg");
    await run(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-profile:v", "high",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", source], directory);
    await run(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=0x2451a4:size=320x568",
      "-frames:v", "1", "-q:v", "2", cover], directory);
    const proof = await ensureExactCoverPublishMaster({ video: source, cover });
    assert.equal(proof.headCover, true);
    assert.equal(proof.coverTimestampMs, 0);
    assert.equal(proof.openingStartsAtZero, true);
    assert.ok(proof.coverSimilarity >= 0.94);
    assert.ok(proof.openingSimilarity >= 0.85);
    assert.ok(proof.prependedSeconds > 0 && proof.prependedSeconds <= 0.25);
    const reused = await ensureExactCoverPublishMaster({ video: source, cover });
    assert.equal(reused.reused, true);
    assert.equal(reused.fingerprint, proof.fingerprint);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
