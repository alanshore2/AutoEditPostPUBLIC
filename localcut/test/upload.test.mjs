import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFileToServer } from "../src/upload-client.mjs";
import { createUploadServer } from "../src/upload-server.mjs";

test("streams an authenticated upload and verifies the server hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "localcut-upload-"));
  const uploadDir = join(root, "server");
  const sourcePath = join(root, "new-media.mp4");
  const source = randomBytes(2 * 1024 * 1024 + 137);
  const token = "acceptance-token-with-more-than-24-characters";
  const instance = createUploadServer({ host: "127.0.0.1", port: 0, uploadDir, token });
  try {
    await writeFile(sourcePath, source);
    const address = await instance.listen();
    const url = `http://127.0.0.1:${address.port}/v1/uploads`;

    const denied = await fetch(url, { method: "POST", body: Buffer.from("denied"), headers: { "content-length": "6", "x-file-name": "denied.mp4" } });
    assert.equal(denied.status, 401);

    const progress = [];
    const receipt = await uploadFileToServer({ filePath: sourcePath, url, token, onProgress: (item) => progress.push(item.percent) });
    assert.equal(receipt.verified, true);
    assert.equal(receipt.bytes, source.length);
    assert.equal(receipt.originalName, "new-media.mp4");
    assert.equal(receipt.sha256, createHash("sha256").update(source).digest("hex"));
    assert.deepEqual(await readFile(receipt.path), source);
    assert.ok(progress.includes(100));
    assert.ok(progress.length > 1);
  } finally {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});
