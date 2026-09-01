import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const VERSION = "0.8.5";
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024 * 1024;

function json(response, status, body) {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
    "cache-control": "no-store",
  });
  response.end(encoded);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeFilename(value) {
  let decoded;
  try { decoded = decodeURIComponent(String(value || "")); } catch { decoded = String(value || ""); }
  const cleaned = basename(decoded).replace(/[^a-zA-Z0-9._ -]+/g, "_").replace(/^\.+/, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw Object.assign(new Error("A valid x-file-name header is required"), { statusCode: 400 });
  return cleaned.slice(0, 180);
}

function authorized(request, token) {
  return safeEqual(request.headers.authorization || "", `Bearer ${token}`);
}

export function createUploadServer({
  host = "0.0.0.0",
  port = 4178,
  uploadDir = "/srv/localcut/uploads",
  token,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!token || String(token).length < 24) throw new Error("LOCALCUT_UPLOAD_TOKEN must contain at least 24 characters");
  const root = resolve(uploadDir);

  async function receive(request, response) {
    if (!authorized(request, token)) return json(response, 401, { error: "unauthorized" });
    const declared = Number(request.headers["content-length"] || 0);
    if (!Number.isSafeInteger(declared) || declared <= 0) return json(response, 411, { error: "A positive Content-Length is required" });
    if (declared > maxBytes) return json(response, 413, { error: `Upload exceeds ${maxBytes} bytes` });

    const originalName = safeFilename(request.headers["x-file-name"]);
    const id = randomUUID();
    const storedName = `${id}-${originalName}`;
    const finalPath = join(root, storedName);
    const temporaryPath = join(root, `.${id}.uploading`);
    const metadataPath = join(root, `${id}.json`);
    const digest = createHash("sha256");
    let bytes = 0;
    await mkdir(root, { recursive: true });

    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes || bytes > declared) return callback(Object.assign(new Error("Upload body exceeds declared size"), { statusCode: 413 }));
        digest.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(request, meter, createWriteStream(temporaryPath, { flags: "wx", mode: 0o640 }));
      if (bytes !== declared) throw Object.assign(new Error(`Received ${bytes} of ${declared} bytes`), { statusCode: 400 });
      const sha256 = digest.digest("hex");
      const claimedHash = String(request.headers["x-content-sha256"] || "").toLowerCase();
      if (claimedHash && !safeEqual(claimedHash, sha256)) throw Object.assign(new Error("Client and server SHA-256 differ"), { statusCode: 422 });
      await rename(temporaryPath, finalPath);
      const receipt = {
        id, originalName, storedName, path: finalPath, bytes, sha256,
        contentType: request.headers["content-type"] || "application/octet-stream",
        receivedAt: new Date().toISOString(),
      };
      await writeFile(metadataPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o640 });
      json(response, 201, receipt);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (!response.headersSent) json(response, error.statusCode || 500, { error: error.message || String(error) });
      else response.destroy(error);
    }
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localcut.invalid");
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true, service: "localcut-upload", version: VERSION });
    }
    if (request.method === "POST" && url.pathname === "/v1/uploads") {
      receive(request, response).catch((error) => {
        if (!response.headersSent) json(response, 500, { error: error.message || String(error) });
        else response.destroy(error);
      });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  return {
    server,
    async listen() {
      await mkdir(root, { recursive: true });
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolveListen(); });
      });
      const address = server.address();
      return { host, port: typeof address === "object" ? address.port : port, uploadDir: root, version: VERSION };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    },
  };
}

export async function startUploadServerFromEnv() {
  const instance = createUploadServer({
    host: process.env.LOCALCUT_UPLOAD_HOST || "0.0.0.0",
    port: Number(process.env.LOCALCUT_UPLOAD_PORT || 4178),
    uploadDir: process.env.LOCALCUT_UPLOAD_DIR || "/srv/localcut/uploads",
    token: process.env.LOCALCUT_UPLOAD_TOKEN,
    maxBytes: Number(process.env.LOCALCUT_UPLOAD_MAX_BYTES || DEFAULT_MAX_BYTES),
  });
  const address = await instance.listen();
  process.stdout.write(`${JSON.stringify({ ready: true, ...address })}\n`);
  const stop = async () => { await instance.close(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return instance;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startUploadServerFromEnv().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}
