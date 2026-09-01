import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

function parseResponse(response) {
  return new Promise((resolveResponse, reject) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) response.destroy(new Error("Upload server response is too large"));
    });
    response.on("error", reject);
    response.on("end", () => {
      let data;
      try { data = JSON.parse(body || "{}"); } catch { return reject(new Error(`Upload server returned invalid JSON (${response.statusCode})`)); }
      if ((response.statusCode || 500) >= 400) return reject(new Error(data.error || `Upload server returned ${response.statusCode}`));
      resolveResponse(data);
    });
  });
}

export async function loadUploadConfig({ dataDir } = {}) {
  let file = {};
  const configPath = resolve(process.env.LOCALCUT_UPLOAD_CONFIG || join(dataDir || ".", "upload.json"));
  try { file = JSON.parse(await readFile(configPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const url = process.env.LOCALCUT_UPLOAD_URL || file.url || "";
  const token = process.env.LOCALCUT_UPLOAD_TOKEN || file.token || "";
  return { enabled: Boolean(url && token), url, token, configPath };
}

export async function checkUploadServer(url, timeoutMs = 4000) {
  const healthUrl = new URL("/health", url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Upload server health returned ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

export async function uploadFileToServer({ filePath, url, token, onProgress } = {}) {
  if (!url || !token) throw new Error("Upload server is not configured");
  const absolute = resolve(filePath || "");
  const info = await stat(absolute);
  if (!info.isFile() || info.size <= 0) throw new Error(`Upload source is not a non-empty file: ${absolute}`);
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw new Error("Upload URL must use HTTP or HTTPS");
  const transport = target.protocol === "https:" ? https : http;
  const digest = createHash("sha256");
  let transferred = 0;
  let lastPercent = -1;

  let request;
  const responsePromise = new Promise((resolveResponse, reject) => {
    request = transport.request(target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "content-length": info.size,
        "x-file-name": encodeURIComponent(basename(absolute)),
      },
    }, (response) => parseResponse(response).then(resolveResponse, reject));
    request.on("error", reject);
  });
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      transferred += chunk.length;
      digest.update(chunk);
      const percent = Math.min(100, Math.floor((transferred / info.size) * 100));
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress?.({ filePath: absolute, filename: basename(absolute), transferred, total: info.size, percent });
      }
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(absolute), meter, request);
  const receipt = await responsePromise;
  const clientSha256 = digest.digest("hex");
  if (Number(receipt.bytes) !== info.size) throw new Error(`Upload byte mismatch: sent ${info.size}, server received ${receipt.bytes}`);
  if (String(receipt.sha256).toLowerCase() !== clientSha256) throw new Error("Upload SHA-256 verification failed");
  return { ...receipt, sourcePath: absolute, clientSha256, verified: true };
}
