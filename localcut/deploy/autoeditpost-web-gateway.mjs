import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const VERSION = "1.1.0";
const COOKIE_NAME = "localcut_autoeditpost_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_LOGIN_BYTES = 16 * 1024;
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const entry of cookies) {
    const [key, ...parts] = entry.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

export function hashGatewayPassword(password, salt = randomBytes(16).toString("hex")) {
  if (String(password || "").length < 8) throw new Error("LocalCut web password must contain at least 8 characters");
  return `scrypt$${salt}$${scryptSync(String(password), salt, 64).toString("hex")}`;
}

function verifyPassword(password, encoded) {
  const [algorithm, salt, digest] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !salt || !digest) return false;
  try { return safeEqual(scryptSync(String(password || ""), salt, 64).toString("hex"), digest); }
  catch { return false; }
}

function sessionValue(username, secret, now = Date.now()) {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  const nonce = randomBytes(18).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${username}.${expires}.${nonce}`).digest("base64url");
  return `${expires}.${nonce}.${signature}`;
}

function validSession(request, username, secret, now = Date.now()) {
  const [expiresText, nonce, signature] = cookieValue(request, COOKIE_NAME).split(".");
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(now / 1000) || !nonce || !signature) return false;
  const expected = createHmac("sha256", secret).update(`${username}.${expires}.${nonce}`).digest("base64url");
  return safeEqual(signature, expected);
}

function tokenAuthorized(request, token) {
  const authorization = String(request.headers.authorization || "");
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return safeEqual(bearer, token);
}

function responseHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || name.toLowerCase() === "set-cookie") continue;
    if (value !== undefined) output[name] = value;
  }
  output["x-content-type-options"] = "nosniff";
  output["referrer-policy"] = "same-origin";
  return output;
}

function proxyHeaders(request, upstream, upstreamToken) {
  const output = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "cookie" || lower === "authorization") continue;
    if (value !== undefined) output[name] = value;
  }
  output.host = upstream.host;
  output.authorization = `Bearer ${upstreamToken}`;
  output["x-forwarded-host"] = request.headers.host || "";
  output["x-forwarded-proto"] = "http";
  output["x-forwarded-for"] = request.socket.remoteAddress || "";
  return output;
}

function json(response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "content-length": body.length,
    "cache-control": "no-store", "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function safeNext(value) {
  const next = String(value || "/");
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function loginPage({ failed = false, next = "/" } = {}) {
  const message = failed ? '<div class="error" role="alert">That username or password is incorrect.</div>' : "";
  const destination = safeNext(next).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Sign in · LocalCut</title>
<style>
:root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f7f5ff;background:#090a10}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 15%,#34205b 0,transparent 34%),radial-gradient(circle at 85% 80%,#132b45 0,transparent 31%),#090a10}
.shell{width:min(440px,100%);padding:1px;border-radius:24px;background:linear-gradient(135deg,#9f7aea,#3b82f6 48%,#252938);box-shadow:0 28px 80px #0009}
.card{border-radius:23px;padding:38px;background:linear-gradient(155deg,#191a26f5,#101119f8);border:1px solid #ffffff10}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:30px}.mark{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,#a855f7,#3b82f6);font-size:24px;box-shadow:0 10px 30px #7c3aed55}.brand strong{font-size:20px}.brand span{display:block;margin-top:3px;color:#9ca3b5;font-size:12px;letter-spacing:.08em;text-transform:uppercase}
h1{font-size:30px;letter-spacing:-.03em;margin:0 0 8px}.sub{color:#a8adbb;margin:0 0 26px;line-height:1.5}.error{margin:0 0 18px;padding:12px 14px;border:1px solid #ef444466;border-radius:11px;background:#7f1d1d55;color:#fecaca;font-size:14px}
label{display:block;margin:16px 0 7px;color:#d9dbea;font-size:13px;font-weight:700}input{width:100%;height:50px;border:1px solid #343748;border-radius:12px;padding:0 14px;background:#0d0f17;color:#fff;font:inherit;outline:none}input:focus{border-color:#9f7aea;box-shadow:0 0 0 3px #8b5cf633}
button{width:100%;height:52px;margin-top:24px;border:0;border-radius:12px;background:linear-gradient(135deg,#8b5cf6,#4f8df7);color:#fff;font:700 15px inherit;cursor:pointer;box-shadow:0 12px 30px #5b21b655}button:hover{filter:brightness(1.08)}.note{margin:20px 0 0;color:#6f7586;text-align:center;font-size:12px}
</style></head><body><main class="shell"><section class="card">
<div class="brand"><div class="mark">✂</div><div><strong>LocalCut</strong><span>AutoEditPost Studio</span></div></div>
<h1>Welcome back</h1><p class="sub">Sign in to review, edit, upload, and schedule your production batches.</p>${message}
<form method="post" action="/auth/login"><input type="hidden" name="next" value="${destination}">
<label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in to LocalCut</button></form><p class="note">Private access · AutoEditPost</p>
</section></main></body></html>`;
}

function html(response, status, body) {
  const payload = Buffer.from(body);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "content-length": payload.length, "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  });
  response.end(payload);
}

async function formBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_LOGIN_BYTES) throw Object.assign(new Error("Login request is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function unauthorized(request, response) {
  const acceptsHtml = request.method === "GET" && String(request.headers.accept || "").includes("text/html");
  if (acceptsHtml) {
    const next = safeNext(request.url || "/");
    response.writeHead(302, { location: `/login?next=${encodeURIComponent(next)}`, "cache-control": "no-store" });
    return response.end();
  }
  return json(response, 401, { ok: false, error: "Sign in to LocalCut to continue" });
}

export function createGateway({
  host = "0.0.0.0", port = 80, token, upstreamToken = token,
  upstreamUrl = "http://127.0.0.1:3210", username = "", passwordHash = "", password = "", allowTokenLogin = false,
} = {}) {
  if (!token || String(token).length < 24) throw new Error("LOCALCUT_GATEWAY_TOKEN must contain at least 24 characters");
  if (!upstreamToken || String(upstreamToken).length < 24) throw new Error("LOCALCUT_UPSTREAM_TOKEN must contain at least 24 characters");
  const loginUsername = String(username || "").trim();
  const loginPasswordHash = String(passwordHash || (password ? hashGatewayPassword(password) : ""));
  const credentialLogin = Boolean(loginUsername && loginPasswordHash);
  if ((loginUsername && !loginPasswordHash) || (!loginUsername && loginPasswordHash)) throw new Error("LocalCut web username and password hash must be configured together");
  const upstream = new URL(upstreamUrl);
  if (!["http:", "https:"].includes(upstream.protocol)) throw new Error("LOCALCUT_UPSTREAM_URL must use HTTP or HTTPS");
  const requestUpstream = upstream.protocol === "https:" ? httpsRequest : httpRequest;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "autoeditpost"}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, service: "AutoEditPost LocalCut Gateway", version: VERSION });
      if (credentialLogin && request.method === "GET" && url.pathname === "/login") {
        if (validSession(request, loginUsername, token)) {
          response.writeHead(302, { location: safeNext(url.searchParams.get("next")), "cache-control": "no-store" });
          return response.end();
        }
        return html(response, 200, loginPage({ failed: url.searchParams.get("failed") === "1", next: url.searchParams.get("next") }));
      }
      if (credentialLogin && request.method === "POST" && url.pathname === "/auth/login") {
        const form = await formBody(request);
        const next = safeNext(form.get("next"));
        const accepted = safeEqual(form.get("username"), loginUsername) && verifyPassword(form.get("password"), loginPasswordHash);
        if (!accepted) return html(response, 401, loginPage({ failed: true, next }));
        const session = sessionValue(loginUsername, token);
        response.writeHead(302, {
          location: next,
          "set-cookie": `${COOKIE_NAME}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
          "cache-control": "no-store", "x-content-type-options": "nosniff",
        });
        return response.end();
      }
      if (credentialLogin && request.method === "POST" && url.pathname === "/auth/logout") {
        response.writeHead(302, {
          location: "/login", "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, "cache-control": "no-store",
        });
        return response.end();
      }

      const suppliedToken = url.searchParams.get("token") || "";
      if (suppliedToken) {
        url.searchParams.delete("token");
        const cleanLocation = `${url.pathname}${url.search}${url.hash}` || "/";
        const headers = { location: cleanLocation, "cache-control": "no-store", "x-content-type-options": "nosniff" };
        if ((!credentialLogin || allowTokenLogin) && safeEqual(suppliedToken, token)) {
          headers["set-cookie"] = `${COOKIE_NAME}=${encodeURIComponent(sessionValue(loginUsername || "token", token))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
        }
        response.writeHead(302, headers);
        return response.end();
      }

      const authenticated = credentialLogin
        ? validSession(request, loginUsername, token) || tokenAuthorized(request, token)
        : tokenAuthorized(request, token) || validSession(request, "token", token);
      if (!authenticated) return unauthorized(request, response);

      const targetPath = `${upstream.pathname.replace(/\/$/, "")}${url.pathname}${url.search}` || "/";
      const upstreamRequest = requestUpstream({
        protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        method: request.method, path: targetPath, headers: proxyHeaders(request, upstream, upstreamToken),
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers));
        upstreamResponse.pipe(response);
      });
      upstreamRequest.setTimeout(0);
      upstreamRequest.on("error", (error) => {
        if (!response.headersSent) json(response, 502, { error: "LocalCut engine is unavailable", detail: error.message });
        else response.destroy(error);
      });
      request.on("aborted", () => upstreamRequest.destroy());
      request.pipe(upstreamRequest);
    } catch (error) {
      if (!response.headersSent) json(response, Number(error.statusCode || 500), { ok: false, error: error.message || String(error) });
      else response.destroy(error);
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolve(); });
      });
      return { host, port, upstream: upstream.origin, version: VERSION, credentialLogin };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function startFromEnv() {
  const gateway = createGateway({
    host: process.env.LOCALCUT_GATEWAY_HOST || "0.0.0.0",
    port: Number(process.env.LOCALCUT_GATEWAY_PORT || 80),
    token: process.env.LOCALCUT_GATEWAY_TOKEN,
    upstreamToken: process.env.LOCALCUT_UPSTREAM_TOKEN,
    upstreamUrl: process.env.LOCALCUT_UPSTREAM_URL || "http://127.0.0.1:3210",
    username: process.env.LOCALCUT_GATEWAY_USERNAME || "",
    passwordHash: process.env.LOCALCUT_GATEWAY_PASSWORD_HASH || "",
    allowTokenLogin: process.env.LOCALCUT_GATEWAY_ALLOW_TOKEN_LOGIN === "1",
  });
  const address = await gateway.listen();
  process.stdout.write(`${JSON.stringify({ ready: true, ...address })}\n`);
  const stop = async () => { await gateway.close(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return gateway;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startFromEnv().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}
