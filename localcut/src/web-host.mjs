import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"],
  [".mp4", "video/mp4"], [".mov", "video/quicktime"], [".webm", "video/webm"], [".mp3", "audio/mpeg"], [".wav", "audio/wav"],
  [".m4a", "audio/mp4"], [".aac", "audio/aac"], [".json", "application/json; charset=utf-8"], [".md", "text/markdown; charset=utf-8"],
]);
const UPLOAD_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".md", ".txt", ".json"]);
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 * 1024;
const APP_ROUTE = /^\/(?:batches(?:\/[^/]+(?:\/(?:reels\/[^/]+|publishing))?)?|podcast)?\/?$/;

const json = (response, status, value) => {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
  response.end(body);
};
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || "")), b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};
const safeFileName = (value) => basename(String(value || "upload.bin")).replace(/[^a-zA-Z0-9._ -]+/g, "_").slice(0, 180) || "upload.bin";
const encodePath = (path) => Buffer.from(path, "utf8").toString("base64url");
const decodePath = (value) => Buffer.from(value, "base64url").toString("utf8");

function localAddresses(port) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries || []) {
    if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${port}`);
  }
  return [...new Set(urls)];
}

function allowedPath(candidate, roots) {
  const absolute = resolve(candidate), lower = absolute.toLowerCase();
  return roots.some((root) => {
    const base = resolve(root).toLowerCase();
    return lower === base || lower.startsWith(`${base}${sep}`) || (base.startsWith("\\\\") && lower.startsWith(`${base}\\`));
  });
}

function fileUrlToWeb(value) {
  if (typeof value !== "string" || !value.startsWith("file:")) return value;
  try {
    const url = new URL(value), path = fileURLToPath(url);
    return `/media/${encodePath(path)}${url.search || ""}`;
  } catch { return value; }
}

function webValue(value) {
  if (typeof value === "string") return fileUrlToWeb(value);
  if (Array.isArray(value)) return value.map(webValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, webValue(child)]));
}

async function requestBody(request, maximum = MAX_JSON_BYTES) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) throw Object.assign(new Error("Request is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function uniqueDestination(root, requestedName) {
  const name = safeFileName(requestedName), extension = extname(name), stem = name.slice(0, name.length - extension.length);
  let destination = join(root, name), index = 1;
  while (existsSync(destination)) destination = join(root, `${stem}-${index++}${extension}`);
  return destination;
}

export async function createLocalCutWebHost({
  rendererDir, assetsDir, dataDir, rawDir, allowedRoots = [], handlers,
  host = process.env.LOCALCUT_WEB_HOST || "0.0.0.0", port = Number(process.env.LOCALCUT_WEB_PORT || 3210), token = process.env.LOCALCUT_WEB_TOKEN || "",
} = {}) {
  if (!rendererDir || !assetsDir || !dataDir || !rawDir || !handlers) throw new Error("LocalCut web host needs renderer, assets, data, Raw, and handler configuration");
  await mkdir(dataDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  const configPath = join(dataDir, "web.json");
  let config = {};
  try { config = JSON.parse(await readFile(configPath, "utf8")); } catch { /* first run */ }
  const accessToken = String(token || config.token || randomBytes(32).toString("base64url"));
  await writeFile(configPath, `${JSON.stringify({ schema: 1, token: accessToken, host, port, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  const roots = [...new Set([rawDir, dataDir, ...allowedRoots].map((root) => resolve(root)))];
  const eventClients = new Set();
  const emit = (channel, payload) => {
    const message = `data: ${JSON.stringify({ channel, payload: webValue(payload) })}\n\n`;
    for (const client of [...eventClients]) { try { client.write(message); } catch { eventClients.delete(client); } }
  };

  const authorized = (request, url) => {
    const cookie = String(request.headers.cookie || "").split(/;\s*/).find((part) => part.startsWith("localcut_web="))?.slice("localcut_web=".length);
    const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    return safeEqual(cookie, accessToken) || safeEqual(bearer, accessToken) || safeEqual(request.headers["x-localcut-token"], accessToken) || safeEqual(url.searchParams.get("token"), accessToken);
  };

  async function serveStatic(response, path, root) {
    const absolute = resolve(root, `.${path}`);
    if (!allowedPath(absolute, [root])) return json(response, 403, { ok: false, error: "Static path is outside the web application" });
    let info; try { info = await stat(absolute); } catch { return json(response, 404, { ok: false, error: "Not found" }); }
    if (!info.isFile()) return json(response, 404, { ok: false, error: "Not found" });
    response.writeHead(200, { "content-type": MIME.get(extname(absolute).toLowerCase()) || "application/octet-stream", "content-length": info.size,
      "cache-control": extname(absolute) === ".html" ? "no-store" : "public, max-age=300" });
    createReadStream(absolute).pipe(response);
  }

  async function serveAppShell(response) {
    const absolute = resolve(rendererDir, "index.html");
    if (!allowedPath(absolute, [rendererDir])) return json(response, 403, { ok: false, error: "Application shell is outside the web root" });
    let body = await readFile(absolute, "utf8");
    if (!/<base\s/i.test(body)) body = body.includes("<head>")
      ? body.replace("<head>", "<head>\n  <base href=\"/\">")
      : body.replace(/<!doctype html>/i, "$&\n<head><base href=\"/\"></head>");
    const bytes = Buffer.from(body);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store" });
    response.end(bytes);
  }

  async function serveMedia(request, response, encoded) {
    const path = decodePath(encoded);
    if (!allowedPath(path, roots)) return json(response, 403, { ok: false, error: "Media path is outside LocalCut storage" });
    let info; try { info = await stat(path); } catch { return json(response, 404, { ok: false, error: "Media file was not found" }); }
    if (!info.isFile()) return json(response, 400, { ok: false, error: "Media path is not a file" });
    const type = MIME.get(extname(path).toLowerCase()) || "application/octet-stream";
    const range = String(request.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
    if (!range) {
      response.writeHead(200, { "content-type": type, "content-length": info.size, "accept-ranges": "bytes", "cache-control": "private, max-age=60" });
      return createReadStream(path).pipe(response);
    }
    const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(info.size - 1, Number(range[2])) : info.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= info.size) {
      response.writeHead(416, { "content-range": `bytes */${info.size}` }); return response.end();
    }
    response.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}`, "accept-ranges": "bytes", "cache-control": "private, max-age=60" });
    createReadStream(path, { start, end }).pipe(response);
  }

  async function receiveUpload(request, response, url) {
    const originalName = safeFileName(url.searchParams.get("name"));
    const extension = extname(originalName).toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(extension)) return json(response, 415, { ok: false, error: `Unsupported upload type: ${extension || "none"}` });
    const length = Number(request.headers["content-length"] || 0);
    if (length > MAX_UPLOAD_BYTES) return json(response, 413, { ok: false, error: "Upload exceeds the 25 GB LocalCut limit" });
    const destination = await uniqueDestination(rawDir, originalName), temporary = `${destination}.uploading-${randomUUID()}`;
    const hash = createHash("sha256"); let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) return done(Object.assign(new Error("Upload exceeds the 25 GB LocalCut limit"), { statusCode: 413 }));
      hash.update(chunk); emit("upload:progress", { name: originalName, bytes, total: length || null, percent: length ? Math.min(100, bytes / length * 100) : null }); done(null, chunk);
    } });
    try {
      await pipeline(request, meter, createWriteStream(temporary, { flags: "wx", mode: 0o640 }));
      await rename(temporary, destination);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    const receipt = { id: `web_${randomUUID()}`, originalName, storedName: basename(destination), path: destination, bytes, sha256: hash.digest("hex"), receivedAt: new Date().toISOString(), verified: true };
    emit("upload:progress", { ...receipt, percent: 100, completed: true });
    return json(response, 200, receipt);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    try {
      if (url.pathname === "/health") return json(response, 200, { ok: true, service: "LocalCut Web", version: 1 });
      if (safeEqual(url.searchParams.get("token"), accessToken)) {
        url.searchParams.delete("token");
        response.writeHead(302, { location: `${url.pathname}${url.search}`, "set-cookie": `localcut_web=${accessToken}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store" });
        return response.end();
      }
      if (!authorized(request, url)) return json(response, 401, { ok: false, error: "Open LocalCut Web using its secure launch link" });
      if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        response.write(`data: ${JSON.stringify({ channel: "web:ready", payload: { connected: true } })}\n\n`); eventClients.add(response);
        request.on("close", () => eventClients.delete(response)); return;
      }
      if (request.method === "POST" && url.pathname === "/upload") return await receiveUpload(request, response, url);
      if (request.method === "POST" && url.pathname.startsWith("/api/")) {
        const channel = decodeURIComponent(url.pathname.slice(5)), handler = handlers.get(channel);
        if (!handler) return json(response, 404, { ok: false, error: `Unknown LocalCut action: ${channel}` });
        const body = JSON.parse((await requestBody(request)).toString("utf8") || "{}");
        const event = { sender: { send: (name, payload) => emit(name, payload) } };
        const result = await handler(event, ...(Array.isArray(body.args) ? body.args : []));
        return json(response, 200, { ok: true, result: webValue(result) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/media/")) return await serveMedia(request, response, url.pathname.slice(7));
      if (request.method === "GET" && url.pathname.startsWith("/assets/")) return await serveStatic(response, url.pathname.slice("/assets".length), assetsDir);
      if (request.method === "GET") {
        if (APP_ROUTE.test(url.pathname)) return await serveAppShell(response);
        return await serveStatic(response, url.pathname, rendererDir);
      }
      return json(response, 405, { ok: false, error: "Method not allowed" });
    } catch (error) {
      if (!response.headersSent) json(response, Number(error.statusCode || 500), { ok: false, error: error.message || String(error) });
      else response.destroy(error);
    }
  });

  await new Promise((accept, reject) => { server.once("error", reject); server.listen(port, host, accept); });
  const address = server.address(), actualPort = typeof address === "object" && address ? address.port : port;
  const localUrl = `http://127.0.0.1:${actualPort}`;
  const urls = [localUrl, ...localAddresses(actualPort)];
  const launch = { schema: 1, startedAt: new Date().toISOString(), host, port: actualPort, localUrl, urls, launchUrl: `${localUrl}/?token=${accessToken}` };
  await writeFile(join(dataDir, "web-session.json"), `${JSON.stringify(launch, null, 2)}\n`, { mode: 0o600 });
  return { ...launch, token: accessToken, configPath, emit, close: () => new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())) };
}
