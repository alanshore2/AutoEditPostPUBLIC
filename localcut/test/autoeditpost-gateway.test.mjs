import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createGateway, hashGatewayPassword } from "../deploy/autoeditpost-web-gateway.mjs";

const TOKEN = "test-token-that-is-longer-than-24-characters";
const USERNAME = "studio-owner";
const PASSWORD = "correct horse battery staple";

test("AutoEditPost gateway uses username/password sessions and streams the real LocalCut service", async (context) => {
  const upstream = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    if (request.url === "/media/reel" && request.headers.range === "bytes=2-5") {
      response.writeHead(206, { "content-range": "bytes 2-5/10", "content-length": "4", "accept-ranges": "bytes" });
      response.end("2345");
      return;
    }
    response.writeHead(200, { "content-type": "text/html", "content-length": "17" });
    response.end("<h1>LocalCut</h1>");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(() => upstream.close());

  const gateway = createGateway({
    host: "127.0.0.1", port: 0, token: TOKEN, upstreamToken: TOKEN,
    upstreamUrl: `http://127.0.0.1:${upstream.address().port}`,
    username: USERNAME, passwordHash: hashGatewayPassword(PASSWORD, "fixed-test-salt"), allowTokenLogin: false,
  });
  await gateway.listen();
  context.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;

  const anonymous = await fetch(base, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.get("location"), /^\/login/);
  const loginPage = await fetch(`${base}/login`);
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  assert.match(loginHtml, /name="username"/);
  assert.match(loginHtml, /name="password"/);
  assert.match(loginHtml, /Sign in to LocalCut/);

  const rejected = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: USERNAME, password: "wrong password", next: "/" }), redirect: "manual",
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("set-cookie"), null);
  assert.match(await rejected.text(), /incorrect/);

  const login = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD, next: "/" }), redirect: "manual",
  });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("location"), "/");
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  assert.doesNotMatch(cookie, new RegExp(TOKEN));
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /SameSite=Strict/);
  const page = await fetch(base, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<h1>LocalCut</h1>");

  const tokenHandoff = await fetch(`${base}/?token=${encodeURIComponent(TOKEN)}`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(tokenHandoff.status, 302);
  assert.equal(tokenHandoff.headers.get("location"), "/");
  assert.equal(tokenHandoff.headers.get("set-cookie"), null);
  const cleanAfterLegacyLink = await fetch(`${base}${tokenHandoff.headers.get("location")}`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.match(cleanAfterLegacyLink.headers.get("location"), /^\/login/);

  const media = await fetch(`${base}/media/reel`, { headers: { cookie, range: "bytes=2-5" } });
  assert.equal(media.status, 206);
  assert.equal(media.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await media.text(), "2345");

  const logout = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie }, redirect: "manual" });
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get("location"), "/login");
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, service: "AutoEditPost LocalCut Gateway", version: "1.1.0" });
});

test("gateway keeps token launch compatibility only when password login is not configured", async (context) => {
  const upstream = createServer((_request, response) => response.end("legacy"));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(() => upstream.close());
  const gateway = createGateway({ host: "127.0.0.1", port: 0, token: TOKEN, upstreamToken: TOKEN, upstreamUrl: `http://127.0.0.1:${upstream.address().port}` });
  await gateway.listen();
  context.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = await fetch(`${base}/?token=${encodeURIComponent(TOKEN)}`, { redirect: "manual" });
  assert.equal(login.status, 302);
  assert.ok(login.headers.get("set-cookie"));
});
