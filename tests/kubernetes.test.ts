import { describe, it, expect } from "vitest";
import { workspaceResources, hosts, namespace, type Project } from "../src/server/kubernetes";
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
