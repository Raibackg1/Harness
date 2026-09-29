import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { createGateway } from "./gateway-core.mjs";
import { COOKIE } from "./auth.mjs";
// Integration tests run actual loopback HTTP and WebSocket services; no Kubernetes is claimed.
// Node's built-in WebSocket client cannot override Host/Origin, so these tests use ws.
import { WebSocket, WebSocketServer } from "ws";
const key = new TextEncoder().encode("gateway-integration-test-key-not-for-production");
const env = {
  PROJECT_ID: "integration",
  APP_ORIGIN: "https://control.example.com",
  IDE_HOST: "ide.runtime.net",
  AI_HOST: "ai.runtime.net",
  APP_HOST: "app.runtime.net",
  PUBLISHED: "false",
};
let backend, gateway, base, wss, agentGateway, agentBase;
let agentToken = null;
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)),
  );
const close = (server) => new Promise((resolve) => server.close(resolve));
before(async () => {
  backend = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/cookie")
      res.setHeader("Set-Cookie", [
        `${COOKIE}=hijack; Secure; Path=/; HttpOnly`,
        "app_session=ok; Path=/",
      ]);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () =>
      res.end(
        JSON.stringify({
          url: req.url,
          host: req.headers.host,
          cookie: req.headers.cookie,
          authorization: req.headers.authorization,
          forwarded: req.headers["x-forwarded-host"],
          body,
        }),
      ),
    );
  });
  wss = new WebSocketServer({ server: backend });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send(m)));
  const upstream = await listen(backend);
  gateway = createGateway({ env, key, targets: { ide: upstream, agent: upstream, app: upstream } });
  base = await listen(gateway);
  agentGateway = createGateway({
    env,
    key,
    targets: { ide: upstream, agent: upstream, app: upstream },
    agentToken: async () => agentToken,
  });
  agentBase = await listen(agentGateway);
});
after(async () => {
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  gateway.closeAllConnections();
  agentGateway.closeAllConnections();
  backend.closeAllConnections();
  await close(gateway);
  await close(agentGateway);
  await close(backend);
});
function call(
  path = "/",
  { method = "GET", host = env.IDE_HOST, origin, cookie, body = "", headers = {}, via = base } = {},
) {
  return new Promise((resolve, reject) => {
    const req = request(
      via + path,
      {
        method,
        headers: { host, ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const ticket = (host = env.IDE_HOST, target = "ide") =>
  new SignJWT({ project: env.PROJECT_ID, target })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("harness-cloud")
    .setAudience(host)
    .setSubject("user")
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(key);
async function login() {
  const t = await ticket();
  const r = await call("/_harness/launch", {
    method: "POST",
    origin: env.APP_ORIGIN,
    body: new URLSearchParams({ ticket: t }).toString(),
  });
  assert.equal(r.status, 303);
  return r.headers["set-cookie"][0].split(";")[0];
}
test("unknown hosts and anonymous IDE/agent requests are denied", async () => {
  assert.equal((await call("/", { host: "evil.example" })).status, 421);
  assert.equal((await call()).status, 401);
  assert.equal((await call("/", { host: env.AI_HOST })).status, 401);
});
test("POST launch checks origin, exchanges once, redirects without leaking tickets", async () => {
  const t = await ticket();
  const body = new URLSearchParams({ ticket: t }).toString();
  assert.equal(
    (await call("/_harness/launch", { method: "POST", origin: "https://evil.example", body }))
      .status,
    403,
  );
  const r = await call("/_harness/launch", { method: "POST", origin: env.APP_ORIGIN, body });
  assert.equal(r.status, 303);
  assert.ok(!r.headers.location.includes(t));
  assert.match(r.headers["set-cookie"][0], /Secure; HttpOnly; SameSite=Lax/);
  assert.equal(
    (await call("/_harness/launch", { method: "POST", origin: env.APP_ORIGIN, body })).status,
    403,
  );
});
test("agent launch hands over the dsh web process token, and waits until it exists", async () => {
  const launch = async (t) =>
    call("/_harness/launch", {
      method: "POST",
      host: env.AI_HOST,
      origin: env.APP_ORIGIN,
      body: new URLSearchParams({ ticket: t }).toString(),
      via: agentBase,
    });
  agentToken = null;
  const early = await ticket(env.AI_HOST, "agent");
  const waiting = await launch(early);
  assert.equal(waiting.status, 503);
  assert.equal(waiting.headers["set-cookie"], undefined);
  agentToken = "process-token/with+chars";
  // The ticket was not burnt while the agent was starting, so the same launch can be retried.
  const ready = await launch(early);
  assert.equal(ready.status, 303);
  assert.equal(ready.headers.location, "/?token=" + encodeURIComponent(agentToken));
  assert.match(ready.headers["set-cookie"][0], /Secure; HttpOnly; SameSite=Lax/);
  assert.equal((await launch(early)).status, 403);
  // The IDE never receives the agent's token.
  const ide = await call("/_harness/launch", {
    method: "POST",
    origin: env.APP_ORIGIN,
    body: new URLSearchParams({ ticket: await ticket() }).toString(),
    via: agentBase,
  });
  assert.equal(ide.status, 303);
  assert.ok(!ide.headers.location.includes("token"));
});
test("authenticated HTTP proxies path/body and strips platform cookies and forwarded headers", async () => {
  const cookie = await login();
  const r = await call("/files?path=src", {
    method: "POST",
    cookie: cookie + "; app_session=hello; __Host-harness=private",
    origin: `https://${env.IDE_HOST}`,
    body: "actual-body",
    headers: { "x-forwarded-host": "evil.example" },
  });
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body);
  assert.equal(data.url, "/files?path=src");
  assert.equal(data.body, "actual-body");
  assert.equal(data.cookie, "app_session=hello");
  assert.equal(data.forwarded, undefined);
});
test("cross-origin authenticated mutations are denied and sessions are host-bound", async () => {
  const cookie = await login();
  assert.equal(
    (await call("/", { cookie, method: "POST", origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await call("/", { cookie, host: env.AI_HOST })).status, 401);
});
test("upstream cannot overwrite the gateway cookie", async () => {
  const r = await call("/cookie", { cookie: await login() });
  assert.deepEqual(r.headers["set-cookie"], ["app_session=ok; Path=/"]);
});
test("application publishing is explicit and preserves application bearer auth", async () => {
  assert.equal((await call("/", { host: env.APP_HOST })).status, 404);
  env.PUBLISHED = "true";
  const r = await call("/api", {
    host: env.APP_HOST,
    headers: { authorization: "Bearer user-application-token" },
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).authorization, "Bearer user-application-token");
  env.PUBLISHED = "false";
  assert.equal((await call("/", { host: env.APP_HOST })).status, 404);
});
test("real WebSocket traffic requires session and same-origin and echoes application frames", async () => {
  const cookie = await login();
  const denied = new WebSocket(base.replace("http:", "ws:"), {
    headers: { host: env.IDE_HOST, origin: `https://${env.IDE_HOST}` },
  });
  await new Promise((resolve) => denied.once("error", resolve));
  const ws = new WebSocket(base.replace("http:", "ws:"), {
    headers: { host: env.IDE_HOST, origin: `https://${env.IDE_HOST}`, cookie },
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const echoed = new Promise((resolve) => ws.once("message", (m) => resolve(m.toString())));
  ws.send("actual-terminal-frame");
  assert.equal(await echoed, "actual-terminal-frame");
  ws.terminate();
});
test(
  "upgraded sockets close when the session expires, not just on the next HTTP request",
  { timeout: 7000 },
  async () => {
    const jwt = await new SignJWT({ project: env.PROJECT_ID, target: "ide" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("harness-workspace")
      .setAudience(env.IDE_HOST)
      .setSubject("user")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 2)
      .sign(key);
    const ws = new WebSocket(base.replace("http:", "ws:"), {
      headers: {
        host: env.IDE_HOST,
        origin: `https://${env.IDE_HOST}`,
        cookie: `${COOKIE}=${jwt}`,
      },
    });
    const closed = new Promise((resolve) => ws.once("close", resolve));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await closed;
    assert.equal(ws.readyState, WebSocket.CLOSED);
  },
);
