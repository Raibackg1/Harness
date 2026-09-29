// End-to-end check of a real deployment on Kubernetes: the control plane and worker from
// infra/k8s, a project started through the public API, its workspace Pod running under
// gVisor, the admission boundary, the gateway reached with an API-issued ticket, and stop.
// Requires kubectl pointing at the cluster and the API reachable at API_URL.
// Usage: API_URL=http://127.0.0.1:3000 APP_ORIGIN=https://cloud.example.com \
//        BOOTSTRAP_TOKEN=... WORKSPACE_DOMAIN=workspaces.example.net node tests/k8s/e2e.mjs
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const run = promisify(execFile);
const env = process.env;
for (const name of ["API_URL", "APP_ORIGIN", "BOOTSTRAP_TOKEN", "WORKSPACE_DOMAIN"])
  if (!env[name]) throw new Error(`${name} is required`);
const api = env.API_URL.replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`ok - ${msg}`);
let cookie = "";

async function call(method, path, body) {
  const res = await fetch(api + path, {
    method,
    headers: {
      origin: env.APP_ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie() };
}
async function must(method, path, body, wanted = [200, 201]) {
  const r = await call(method, path, body);
  if (!wanted.includes(r.status))
    throw new Error(`${method} ${path}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r;
}
const kubectl = async (...args) => (await run("kubectl", args, { maxBuffer: 8 << 20 })).stdout;
async function until(label, fn, timeoutMs, everyMs = 3000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last)?.slice(0, 500)}`);
}
function portForward(namespace, target, localPort, remotePort) {
  const child = spawn(
    "kubectl",
    ["-n", namespace, "port-forward", target, `${localPort}:${remotePort}`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      if (String(d).includes("Forwarding from")) resolve(child);
    });
    child.on("exit", (code) => reject(new Error(`port-forward exited with ${code}`)));
  });
}
function raw(port, path, { host, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { host, ...headers }, timeout: 15000 },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// 1. Account through the bootstrap token, as the first operator of a fresh install.
const email = "operator@k8s-e2e.test",
  password = "k8s-e2e-password-" + Date.now();
const registered = await must("POST", "/api/auth/register", {
  name: "Operador",
  email,
  password,
  bootstrapToken: env.BOOTSTRAP_TOKEN,
});
cookie = registered.setCookie.map((c) => c.split(";")[0]).join("; ");
if (!cookie) throw new Error("register did not return a session cookie");
step("first account created with the bootstrap token");

// 2. The dashboard's own check reaches the cluster, finds gVisor and the admission policies.
const check = await until(
  "the infrastructure check",
  async () => {
    const r = await call("POST", "/api/infrastructure/check", {});
    return r.status === 200 ? r.json : Promise.reject(new Error(r.text.slice(0, 300)));
  },
  120000,
);
if (!check.boundaries?.every((b) => b.ok)) throw new Error("admission boundaries incomplete");
step(
  `infrastructure check passed (Kubernetes ${check.version}, RuntimeClass and admission present)`,
);

// 3. Project and start through the public API.
const project = (
  await must("POST", "/api/projects", { name: "Kubernetes e2e", template: "html" }, [201])
).json;
await must("POST", `/api/projects/${project.id}/runtime`, { action: "start" });
step(`project ${project.id} created and start requested`);
const ns = `hc-${project.id}`;
await until(
  "the worker to report the workspace running",
  async () => {
    const p = (await must("GET", `/api/projects/${project.id}`)).json;
    // An error is final for this revision: stop waiting and show why.
    return p.status === "running" || p.status === "error" ? p : null;
  },
  420000,
  5000,
)
  .then((p) => {
    if (p.status === "error") throw new Error(`worker error: ${p.error}`);
  })
  .catch(async (e) => {
    console.error(await kubectl("-n", ns, "get", "all,pvc,events", "-o", "wide").catch(() => ""));
    console.error(
      await kubectl("-n", ns, "logs", "deployment/workspace", "--tail=100").catch(() => ""),
    );
    throw e;
  });
step("worker reconciled the project to running");

// 4. The Pod really runs in the sandbox the admission policy demands.
const pod = JSON.parse(await kubectl("-n", ns, "get", "pods", "-o", "json")).items.find(
  (p) => p.status?.phase === "Running",
);
if (pod?.spec?.runtimeClassName !== "gvisor")
  throw new Error(`workspace runtimeClassName is ${pod?.spec?.runtimeClassName}`);
const dmesg = await kubectl("-n", ns, "exec", pod.metadata.name, "-c", "workspace", "--", "dmesg");
if (!/gVisor/i.test(dmesg)) throw new Error(`kernel inside the Pod is not gVisor:\n${dmesg}`);
step("workspace Pod runs under gVisor (dmesg reports the gVisor kernel)");
if (pod.spec.automountServiceAccountToken !== false)
  throw new Error("workspace Pod mounts a service account token");
step("workspace Pod has no cluster credentials");

// 5. The admission boundary rejects a Pod without gVisor in a managed namespace.
const rogue = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "rogue", namespace: ns },
  spec: {
    automountServiceAccountToken: false,
    securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
    containers: [
      {
        name: "c",
        image: "registry.k8s.io/pause:3.10",
        securityContext: {
          readOnlyRootFilesystem: true,
          allowPrivilegeEscalation: false,
          capabilities: { drop: ["ALL"] },
          runAsUser: 1000,
        },
      },
    ],
  },
};
const dir = await mkdtemp(join(tmpdir(), "hc-e2e-"));
await writeFile(join(dir, "rogue.json"), JSON.stringify(rogue));
const denied = await run("kubectl", ["create", "-f", join(dir, "rogue.json")]).then(
  () => null,
  (e) => String(e.stderr),
);
if (!denied || !/gVisor or Kata/.test(denied))
  throw new Error(`a Pod without gVisor was not denied by admission: ${denied}`);
step("admission denies a Pod without gVisor in a project namespace");

// 6. The gateway accepts a ticket issued by the API, once, and serves the IDE and the agent.
const hosts = {
  ide: `ide-${project.id}.${env.WORKSPACE_DOMAIN}`,
  agent: `ai-${project.id}.${env.WORKSPACE_DOMAIN}`,
};
const forward = await portForward(ns, `pod/${pod.metadata.name}`, 18088, 8088);
try {
  for (const target of ["ide", "agent"]) {
    const { ticket } = (await must("POST", `/api/projects/${project.id}/launch`, { target })).json;
    const form = {
      host: hosts[target],
      method: "POST",
      headers: {
        origin: env.APP_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "ticket=" + ticket,
    };
    const redeemed = await until(
      `${target} launch`,
      async () => {
        const r = await raw(18088, "/_harness/launch", form);
        // 503 only while the agent is still starting; the ticket stays valid for 60 s.
        return r.status === 503 ? null : r;
      },
      45000,
      2000,
    );
    if (redeemed.status !== 303) throw new Error(`${target} launch: HTTP ${redeemed.status}`);
    const session = String(redeemed.headers["set-cookie"]?.[0] || "").split(";")[0];
    const replay = await raw(18088, "/_harness/launch", form);
    if (replay.status !== 403) throw new Error(`${target} ticket replay: HTTP ${replay.status}`);
    let cookies = [session];
    let location = String(redeemed.headers.location);
    if (target === "agent") {
      const handoff = await raw(18088, location, {
        host: hosts.agent,
        headers: { cookie: session },
      });
      cookies.push(
        ...[handoff.headers["set-cookie"] || []].flat().map((c) => String(c).split(";")[0]),
      );
      location = "/";
    }
    const page = await raw(18088, location, {
      host: hosts[target],
      headers: { cookie: cookies.join("; ") },
    });
    if (page.status !== 200) throw new Error(`${target} through the gateway: HTTP ${page.status}`);
    step(`${target} served through the gateway with an API-issued, single-use ticket`);
  }
} finally {
  forward.kill();
}

// 7. Stop through the API: the worker scales the workspace away.
await must("POST", `/api/projects/${project.id}/runtime`, { action: "stop" });
await until(
  "the workspace Pod to disappear",
  async () => {
    const pods = JSON.parse(await kubectl("-n", ns, "get", "pods", "-o", "json")).items;
    return pods.length === 0;
  },
  240000,
  5000,
);
step("stop through the API removed the workspace Pod");
console.log("kubernetes e2e passed");
