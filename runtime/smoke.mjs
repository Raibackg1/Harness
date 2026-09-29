// Smoke test for a running workspace container: talks to the gateway exactly as a browser
// launched from Harness Cloud would, and fails on the first unexpected answer.
// Usage: GATEWAY_KEY_FILE=... PROJECT_ID=... APP_ORIGIN=... IDE_HOST=... AI_HOST=... APP_HOST=...
//        node runtime/smoke.mjs [http://127.0.0.1:8088]
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const base = new URL(process.argv[2] || "http://127.0.0.1:8088");
const env = process.env;
for (const name of [
  "GATEWAY_KEY_FILE",
  "PROJECT_ID",
  "APP_ORIGIN",
  "IDE_HOST",
  "AI_HOST",
  "APP_HOST",
])
  if (!env[name]) throw new Error(`${name} is required`);
const key = new TextEncoder().encode((await readFile(env.GATEWAY_KEY_FILE, "utf8")).trim());
const readyTimeout = Number(env.SMOKE_READY_TIMEOUT_MS || 180000);

// node:http, not fetch: the gateway routes on the Host header, which fetch does not let us set.
function call(path, { host, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: base.hostname,
        port: base.port,
        path,
        method,
        headers: { ...(host ? { host } : {}), ...headers },
        timeout: 15000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c.length + text.length > 200000 ? "" : c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout on ${method} ${path} (${host})`)));
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}
function expect(label, actual, wanted) {
  if (actual !== wanted) throw new Error(`${label}: expected ${wanted}, got ${actual}`);
  console.log(`ok - ${label}`);
}
const ticket = (host, target) =>
  new SignJWT({ project: env.PROJECT_ID, target })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("harness-cloud")
    .setAudience(host)
    .setSubject("smoke-user")
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(key);
async function launch(host, target) {
  const raw = await ticket(host, target);
  const form = { "content-type": "application/x-www-form-urlencoded", origin: env.APP_ORIGIN };
  const first = await call("/_harness/launch", {
    host,
    method: "POST",
    headers: form,
    body: "ticket=" + raw,
  });
  expect(`${target}: ticket redeemed`, first.status, 303);
  const cookie = String(first.headers["set-cookie"]?.[0] || "").split(";")[0];
  if (!cookie.startsWith("__Host-harness-workspace="))
    throw new Error(`${target}: gateway did not issue a session cookie`);
  const replay = await call("/_harness/launch", {
    host,
    method: "POST",
    headers: form,
    body: "ticket=" + raw,
  });
  expect(`${target}: same ticket rejected on reuse`, replay.status, 403);
  return { cookie, location: String(first.headers.location || "") };
}

const started = Date.now();
let health = { status: 0 };
while (Date.now() - started < readyTimeout) {
  health = await call("/healthz").catch(() => ({ status: 0 }));
  if (health.status === 200) break;
  await new Promise((r) => setTimeout(r, 2000));
}
expect("gateway reports IDE and agent ready", health.status, 200);
expect("liveness", (await call("/livez")).status, 200);
expect("unknown host refused", (await call("/", { host: "evil.example" })).status, 421);
expect("IDE without session refused", (await call("/", { host: env.IDE_HOST })).status, 401);
expect(
  "ticket from another origin refused",
  (
    await call("/_harness/launch", {
      host: env.IDE_HOST,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: "ticket=" + (await ticket(env.IDE_HOST, "ide")),
    })
  ).status,
  403,
);
const { cookie: ideCookie } = await launch(env.IDE_HOST, "ide");
const ide = await call("/?folder=/home/coder/project", {
  host: env.IDE_HOST,
  headers: { cookie: ideCookie },
});
expect("code-server served through the gateway", ide.status, 200);
if (!/text\/html/.test(String(ide.headers["content-type"])))
  throw new Error(`IDE answered ${ide.headers["content-type"]}, not HTML`);
expect(
  "IDE session cookie is not valid for the agent host",
  (await call("/", { host: env.AI_HOST, headers: { cookie: ideCookie } })).status,
  401,
);
const agent = await launch(env.AI_HOST, "agent");
if (!agent.location.startsWith("/?token="))
  throw new Error(`agent launch did not hand over the dsh web token (Location: ${agent.location})`);
console.log("ok - agent launch hands over the dsh web token");
// The browser follows the redirect; dsh swaps its token for its own cookie.
const handoff = await call(agent.location, {
  host: env.AI_HOST,
  headers: { cookie: agent.cookie },
});
const dshCookies = [handoff.headers["set-cookie"] || []]
  .flat()
  .map((c) => String(c).split(";")[0])
  .filter((c) => !c.startsWith("__Host-harness-workspace="));
if (handoff.status >= 400 || !dshCookies.length)
  throw new Error(`dsh did not accept its token through the gateway (HTTP ${handoff.status})`);
console.log(`ok - dsh accepted its token through the gateway (HTTP ${handoff.status})`);
const agentPage = await call("/", {
  host: env.AI_HOST,
  headers: { cookie: [agent.cookie, ...dshCookies].join("; ") },
});
expect("DeepSeek Harness web served through the gateway", agentPage.status, 200);
expect("unpublished app is not exposed", (await call("/", { host: env.APP_HOST })).status, 404);
console.log(`smoke passed in ${Math.round((Date.now() - started) / 1000)}s`);
