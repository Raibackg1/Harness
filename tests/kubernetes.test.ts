import { describe, it, expect } from "vitest";
import {
  workspaceResources,
  hosts,
  namespace,
  Kubernetes,
  SANDBOX_POLICIES,
  publicEventMessage,
  type Project,
} from "../src/server/kubernetes";
import { loadConfig } from "../src/server/config";
const config = loadConfig({
  KUBERNETES_ENABLED: "true",
  ENCRYPTION_KEY: "ab".repeat(32),
  APP_ORIGIN: "https://cloud.company.com",
  WORKSPACE_DOMAIN: "runtime.sandbox.net",
  WORKSPACE_IMAGE: "image@sha256:" + "ab".repeat(32),
});
const project = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test",
  template: "react",
  desired: "running",
  status: "starting",
  revision: 1,
  published: false,
  provisioned: false,
  runtime_key: "encrypted",
} as Project;
const all = workspaceResources(
  config,
  project,
  { "index.html": "<h1>Hi</h1>" },
  { DEEPSEEK_API_KEY: "private" },
  "gateway-key",
);
const get = (kind: string) => all.find((r) => r.body.kind === kind)!.body;
describe("Kubernetes workload policy manifests", () => {
  it("isolates each project in a namespace enforcing restricted pod security", () => {
    const ns = get("Namespace");
    expect(ns.metadata.name).toBe(namespace(project.id));
    expect(ns.metadata.labels["pod-security.kubernetes.io/enforce"]).toBe("restricted");
  });
  it("requires a sandboxed runtime without platform service account credentials", () => {
    const pod = get("Deployment").spec.template.spec;
    expect(pod.runtimeClassName).toBe("gvisor");
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.enableServiceLinks).toBe(false);
    expect(pod.hostNetwork).toBeUndefined();
    expect(pod.hostPID).toBeUndefined();
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    const c = pod.containers[0];
    expect(c.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(c.image).toContain("@sha256:");
    expect(c.resources.limits).toEqual({ cpu: "2", memory: "4Gi" });
  });
  it("denies lateral ingress and blocks private and metadata egress", () => {
    const policy = get("NetworkPolicy").spec;
    expect(policy.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(policy.ingress).toHaveLength(1);
    expect(policy.ingress[0].ports).toEqual([{ port: 8088, protocol: "TCP" }]);
    expect(policy.egress[1].to[0].ipBlock.except).toContain("169.254.0.0/16");
    expect(policy.egress[1].to[0].ipBlock.except).toContain("10.0.0.0/8");
    expect(policy.egress[1].ports.map((p: any) => p.port)).toEqual([80, 443]);
  });
  it("retains workspace files on a bounded PVC, uses Recreate strategy", () => {
    expect(get("PersistentVolumeClaim").spec.resources.requests.storage).toBe("5Gi");
    expect(get("Deployment").spec.strategy.type).toBe("Recreate");
    expect(get("ResourceQuota").spec.hard.pods).toBe("1");
    // kube-root-ca.crt is published into every namespace and counts against this quota,
    // next to the seed ConfigMap; a quota of 1 made every workspace start fail with 403.
    expect(Number(get("ResourceQuota").spec.hard["count/configmaps"])).toBeGreaterThanOrEqual(2);
  });
  it("does not create public app ingress until explicitly enabled", () => {
    expect(get("Ingress").spec.rules).toHaveLength(2);
    const published = workspaceResources(
      config,
      { ...project, published: true },
      {},
      {},
      "key",
    ).find((r) => r.body.kind === "Ingress")!.body;
    expect(published.spec.rules).toHaveLength(3);
    expect(published.spec.rules[2].host).toBe(hosts(project.id, config.WORKSPACE_DOMAIN!).app);
  });
  it("keeps credentials out of deployments and configmaps", () => {
    expect(JSON.stringify(get("Deployment"))).not.toContain("private");
    expect(JSON.stringify(get("ConfigMap"))).not.toContain("gateway-key");
    const secret = all.find((r) => r.body.metadata.name === "environment")!.body;
    expect(Buffer.from(secret.data.DEEPSEEK_API_KEY, "base64").toString()).toBe("private");
  });
});

describe("physical stop observations (Kubernetes response fixtures)", () => {
  it("does not release capacity while a terminating pod still exists", async () => {
    const { Kubernetes } = await import("../src/server/kubernetes");
    const k = new Kubernetes(config);
    k.request = async (path) =>
      path.includes("/deployments/")
        ? { spec: { replicas: 0 }, status: { replicas: 0 } }
        : {
            items: [
              {
                metadata: { deletionTimestamp: new Date().toISOString() },
                status: { phase: "Running" },
              },
            ],
          };
    expect(await k.observe(project.id)).toBe("stopping");
  });
  it("treats orphan active pods as stopping even if their Deployment disappeared", async () => {
    const { Kubernetes } = await import("../src/server/kubernetes");
    const k = new Kubernetes(config);
    k.request = async (path) =>
      path.includes("/deployments/") ? null : { items: [{ status: { phase: "Running" } }] };
    expect(await k.observe(project.id)).toBe("stopping");
  });
  it("confirms stopped when replicas are zero and no active pods remain", async () => {
    const { Kubernetes } = await import("../src/server/kubernetes");
    const k = new Kubernetes(config);
    k.request = async (path) =>
      path.includes("/deployments/")
        ? { spec: { replicas: 0 }, status: { replicas: 0 } }
        : { items: [{ status: { phase: "Failed" } }] };
    expect(await k.observe(project.id)).toBe("stopped");
  });
});

describe("worker admission boundary self-check", () => {
  const name = (path: string) => path.split("/").pop() as string;
  const enforcing = (path: string) =>
    path.includes("policybindings")
      ? { spec: { policyName: name(path), validationActions: ["Deny"] } }
      : { spec: { failurePolicy: "Fail" } };
  const cluster = (handler: (path: string) => unknown) => {
    const k = new Kubernetes(config);
    k.request = async (path) => handler(path);
    return k;
  };
  it("accepts only failing-closed policies with denying bindings", async () => {
    const report = await cluster(enforcing).sandboxBoundaries();
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([...SANDBOX_POLICIES]);
  });
  it("flags a policy that is absent, open or not enforced by its binding", async () => {
    const absent = await cluster((path) =>
      path.includes("policies/harness-workspace-sandbox") ? null : enforcing(path),
    ).sandboxBoundaries();
    expect(absent.ok).toBe(false);
    expect(absent.checks.find((c) => c.name === "harness-workspace-sandbox")?.problems).toContain(
      "policy not installed",
    );
    const open = await cluster((path) =>
      path.includes("policybindings") ? enforcing(path) : { spec: { failurePolicy: "Ignore" } },
    ).sandboxBoundaries();
    expect(open.checks[0].problems.join()).toContain("failurePolicy must be Fail");
    const audit = await cluster((path) =>
      path.includes("policybindings")
        ? { spec: { policyName: name(path), validationActions: ["Audit"] } }
        : enforcing(path),
    ).sandboxBoundaries();
    expect(audit.checks[0].problems.join()).toContain("does not Deny");
    const foreign = await cluster((path) =>
      path.includes("policybindings")
        ? { spec: { policyName: "something-else", validationActions: ["Deny"] } }
        : enforcing(path),
    ).sandboxBoundaries();
    expect(foreign.checks[0].problems.join()).toContain("different policy");
  });
  it("fails when the cluster refuses to answer instead of trusting silence", async () => {
    const report = await cluster(() => {
      throw new Error("Kubernetes GET /apis/admissionregistration.k8s.io: HTTP 403");
    }).sandboxBoundaries();
    expect(report.ok).toBe(false);
    expect(report.checks.every((c) => c.problems.some((p) => p.includes("unreadable")))).toBe(true);
  });
});

describe("cluster events surfaced to project members", () => {
  const withEvents = async (items: unknown[]) => {
    const k = new Kubernetes(config);
    k.request = async () => ({ items });
    return k.logs(project.id);
  };
  it("keeps storage, node and CNI details away from members", async () => {
    const [event] = await withEvents([
      {
        type: "Warning",
        reason: "FailedMount",
        message: "unable to attach volume fast-ssd-pool to node ip-10-0-3-4",
        lastTimestamp: "2026-01-01T00:00:00Z",
        metadata: {},
      },
    ]);
    expect(event.reason).toBe("FailedMount");
    expect(event.time).toBe("2026-01-01T00:00:00Z");
    expect(event.message).not.toContain("fast-ssd-pool");
    expect(event.message).not.toContain("ip-10-0-3-4");
    expect(event.message).toContain("volumen");
  });
  it("maps known reasons and uses one stable fallback otherwise", () => {
    expect(publicEventMessage("FailedScheduling")).toContain("programar");
    expect(publicEventMessage("UnregisteredReason")).toContain("administradora");
    expect(publicEventMessage(undefined)).toContain("administradora");
  });
});
describe("optional PostgreSQL per project", () => {
  const withDb = loadConfig({
    KUBERNETES_ENABLED: "true",
    ENCRYPTION_KEY: "ab".repeat(32),
    APP_ORIGIN: "https://cloud.company.com",
    WORKSPACE_DOMAIN: "runtime.sandbox.net",
    WORKSPACE_IMAGE: "image@sha256:" + "ab".repeat(32),
    DATABASE_IMAGE: "postgres@sha256:" + "cd".repeat(32),
  });
  const resources = workspaceResources(
    withDb,
    { ...project, database: true },
    { "index.html": "<h1>Hi</h1>" },
    {},
    "gateway-key",
    "app-db-password",
  );
  const byName = (kind: string, name: string) =>
    resources.find((r) => r.body.kind === kind && r.body.metadata.name === name)!.body;
  it("runs the database in the same sandbox rules as the workspace", () => {
    const pod = byName("Deployment", "database").spec.template.spec;
    expect(pod.runtimeClassName).toBe("gvisor");
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    const c = pod.containers[0];
    expect(c.image).toBe(withDb.DATABASE_IMAGE);
    expect(c.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(byName("PersistentVolumeClaim", "database").spec.resources.requests.storage).toBe("2Gi");
  });
  it("never lets the database join the workspace Service or the project's pod label", () => {
    const labels = byName("Deployment", "database").spec.template.metadata.labels;
    expect(labels["harness.cloud/project"]).toBeUndefined();
    const workspaceSelector = byName("Service", "workspace").spec.selector;
    expect(Object.entries(workspaceSelector).every(([k, v]) => labels[k] === v)).toBe(false);
  });
  it("hands the workspace a DATABASE_URL from a Secret and allows 5432 only inside the namespace", () => {
    expect(Buffer.from(byName("Secret", "database").data.password, "base64").toString()).toBe(
      "app-db-password",
    );
    const env = byName("Deployment", "workspace").spec.template.spec.containers[0].env;
    expect(env.find((e: any) => e.name === "DATABASE_URL").valueFrom.secretKeyRef).toEqual({
      name: "database",
      key: "url",
    });
    const policy = resources.find((r) => r.body.kind === "NetworkPolicy")!.body.spec;
    const internal = policy.ingress.find((r: any) => r.ports[0].port === 5432);
    expect(internal.from).toEqual([{ podSelector: {} }]);
    expect(policy.egress.some((r: any) => r.ports?.[0]?.port === 5432 && r.to[0].podSelector)).toBe(
      true,
    );
    // The public egress rule still excludes private ranges.
    expect(policy.egress.find((r: any) => r.to[0].ipBlock).to[0].ipBlock.except).toContain(
      "10.0.0.0/8",
    );
    const quota = resources.find((r) => r.body.kind === "ResourceQuota")!.body.spec.hard;
    expect(quota.pods).toBe("2");
    expect(quota.persistentvolumeclaims).toBe("2");
  });
  it("creates no database resources for projects that did not enable it", () => {
    expect(all.some((r) => r.body.metadata?.name === "database")).toBe(false);
    const env = get("Deployment").spec.template.spec.containers[0].env;
    expect(env.some((e: any) => e.name === "DATABASE_URL")).toBe(false);
  });
});
