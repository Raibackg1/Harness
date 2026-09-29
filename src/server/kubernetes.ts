import https from "node:https";
import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";
export interface Project {
  id: string;
  name: string;
  template: string;
  desired: string;
  status: string;
  revision: number;
  published: boolean;
  provisioned: boolean;
  runtime_key: string;
}
export const namespace = (id: string) => `hc-${id}`;
export const hosts = (id: string, domain: string) => ({
  ide: `ide-${id}.${domain}`,
  agent: `ai-${id}.${domain}`,
  app: `app-${id}.${domain}`,
});
// The worker's ClusterRole grants cluster-scoped mutations; these three policies and
// their Deny bindings are the only thing that keeps it inside hc-<project> namespaces.
// Neither the API nor the dashboard can assume the operator installed them, so both
// verify them and the worker refuses to reconcile otherwise.
export const SANDBOX_POLICIES = [
  "harness-worker-namespace-boundary",
  "harness-worker-resource-boundary",
  "harness-workspace-sandbox",
] as const;
export type BoundaryCheck = { name: string; ok: boolean; problems: string[] };
export type SandboxBoundaries = { ok: boolean; checks: BoundaryCheck[] };
const eventMessages: Record<string, string> = {
  FailedScheduling:
    "El clúster todavía no pudo programar el entorno: falta capacidad o un nodo elegible.",
  FailedMount: "El volumen del entorno no se pudo montar.",
  FailedAttachVolume: "El volumen del entorno no se pudo conectar al nodo.",
  Pulling: "Se está descargando la imagen del entorno.",
  ErrImagePull: "La imagen del entorno no se pudo descargar; verifica el digest y el registry.",
  ImagePullBackOff: "La imagen del entorno no se pudo descargar; verifica el digest y el registry.",
  BackOff: "El entorno reinició repetidamente y quedó en espera.",
  Created: "El entorno se creó.",
  Started: "El entorno inició.",
  Killing: "Se está deteniendo el entorno.",
  Preempted: "El clúster desalojó el entorno; vuelve a iniciarlo.",
  Evicted: "El clúster desalojó el entorno por presión de recursos.",
};
export const publicEventMessage = (reason?: string) =>
  eventMessages[reason || ""] ||
  "Evento del entorno. El detalle del clúster queda disponible para la persona administradora.";
export class Kubernetes {
  constructor(public config: Config) {}
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    contentType = "application/json",
  ): Promise<any> {
    const base = "/var/run/secrets/kubernetes.io/serviceaccount";
    const [token, ca] = await Promise.all([
      readFile(`${base}/token`, "utf8"),
      readFile(`${base}/ca` + ".crt"),
    ]);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc",
          port: Number(process.env.KUBERNETES_SERVICE_PORT || 443),
          path,
          method,
          ca,
          headers: {
            Authorization: `Bearer ${token.trim()}`,
            "Content-Type": contentType,
            Accept: "application/json",
          },
          timeout: 10000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
            if (data.length > 4_000_000) req.destroy(new Error("Kubernetes response too large"));
          });
          res.on("end", () => {
            if (res.statusCode === 404) return resolve(null);
            if (!res.statusCode || res.statusCode >= 300) {
              const error = new Error(
                `Kubernetes ${method} ${path.split("?")[0]}: HTTP ${res.statusCode}`,
              ) as Error & { detail?: string };
              // The API server's reason (quota, admission, RBAC) is for operator logs only:
              // it can name cluster internals, so it is not part of the user-facing message.
              try {
                error.detail = String(JSON.parse(data).message || "").slice(0, 1000);
              } catch {}
              return reject(error);
            }
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch {
              reject(new Error("Invalid Kubernetes response"));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Kubernetes timed out")));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async apply(path: string, body: unknown) {
    const result = await this.request(
      path + "?fieldManager=harness-cloud&force=true",
      "PATCH",
      body,
      "application/apply-patch+yaml",
    );
    if (!result) throw new Error("Kubernetes resource endpoint not found");
    return result;
  }
  async check() {
    const runtime = await this.request(
      `/apis/node.k8s.io/v1/runtimeclasses/${this.config.RUNTIME_CLASS}`,
    );
    if (!runtime) throw new Error(`RuntimeClass ${this.config.RUNTIME_CLASS} no disponible`);
    return this.request("/version");
  }
  private async readAdmission(kind: string, name: string) {
    try {
      return { value: await this.request(`/apis/admissionregistration.k8s.io/v1/${kind}/${name}`) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "admission read failed" };
    }
  }
  async sandboxBoundaries(): Promise<SandboxBoundaries> {
    const checks: BoundaryCheck[] = [];
    for (const name of SANDBOX_POLICIES) {
      const problems: string[] = [];
      const policy = await this.readAdmission("validatingadmissionpolicies", name);
      if (policy.error) problems.push(`policy unreadable: ${policy.error}`);
      else if (!policy.value) problems.push("policy not installed");
      else if (policy.value.spec?.failurePolicy !== "Fail")
        problems.push(`failurePolicy must be Fail, found ${policy.value.spec?.failurePolicy}`);
      const binding = await this.readAdmission("validatingadmissionpolicybindings", name);
      if (binding.error) problems.push(`binding unreadable: ${binding.error}`);
      else if (!binding.value) problems.push("binding not installed");
      else {
        if (binding.value.spec?.policyName !== name)
          problems.push("binding refers to a different policy");
        if (!(binding.value.spec?.validationActions || []).includes("Deny"))
          problems.push("binding does not Deny");
      }
      checks.push({ name, ok: problems.length === 0, problems });
    }
    return { ok: checks.every((c) => c.ok), checks };
  }
  async ensure(
    project: Project,
    files: Record<string, string>,
    secrets: Record<string, string>,
    key: string,
  ) {
    for (const r of workspaceResources(this.config, project, files, secrets, key))
      await this.apply(r.path, r.body);
    return this.observe(project.id);
  }
  async observe(id: string) {
    const n = namespace(id);
    const dep = await this.request(`/apis/apps/v1/namespaces/${n}/deployments/workspace`);
    if (!dep || (!dep.spec?.replicas && !dep.status?.replicas)) {
      const pods = await this.request(
        `/api/v1/namespaces/${n}/pods?labelSelector=${encodeURIComponent("harness.cloud/project=" + id)}`,
      );
      return (pods?.items || []).some(
        (pod: any) => !["Succeeded", "Failed"].includes(pod.status?.phase),
      )
        ? "stopping"
        : "stopped";
    }
    if (
      dep.spec?.replicas &&
      dep.status?.observedGeneration >= dep.metadata?.generation &&
      dep.status?.availableReplicas > 0
    )
      return "running";
    return dep.spec?.replicas ? "starting" : "stopping";
  }
  async stop(id: string) {
    const n = namespace(id);
    const dep = await this.request(`/apis/apps/v1/namespaces/${n}/deployments/workspace`);
    if (dep)
      await this.request(
        `/apis/apps/v1/namespaces/${n}/deployments/workspace/scale`,
        "PATCH",
        { spec: { replicas: 0 } },
        "application/merge-patch+json",
      );
    return this.observe(id);
  }
  async remove(id: string) {
    const path = `/api/v1/namespaces/${namespace(id)}`;
    const ns = await this.request(path);
    if (!ns) return true;
    if (ns.metadata?.labels?.["app.kubernetes.io/managed-by"] !== "harness-cloud")
      throw new Error("Namespace ownership mismatch");
    if (!ns.metadata.deletionTimestamp)
      await this.request(path, "DELETE", {
        apiVersion: "v1",
        kind: "DeleteOptions",
        propagationPolicy: "Foreground",
      });
    return false;
  }
  async logs(id: string) {
    // Events rather than process logs: user secrets and arbitrary code output must not leak
    // to control-plane logs. The raw event message is kept away from members too, because it
    // names storage classes, node hosts and CNI internals that belong to the operator.
    const result = await this.request(`/api/v1/namespaces/${namespace(id)}/events`);
    return (result?.items || []).slice(-40).map((e: any) => ({
      time: e.lastTimestamp || e.metadata.creationTimestamp,
      type: e.type,
      reason: e.reason,
      message: publicEventMessage(e.reason),
    }));
  }
}
export function workspaceResources(
  c: Config,
  p: Project,
  files: Record<string, string>,
  secrets: Record<string, string>,
  key: string,
) {
  const n = namespace(p.id),
    h = hosts(p.id, c.WORKSPACE_DOMAIN!);
  const labels = { "app.kubernetes.io/managed-by": "harness-cloud", "harness.cloud/project": p.id };
  const metadata = (name: string) => ({ name, namespace: n, labels });
  const core = `/api/v1/namespaces/${n}`;
  const resources: { path: string; body: any }[] = [];
  const add = (path: string, body: any) => resources.push({ path, body });
  add(`/api/v1/namespaces/${n}`, {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: n,
      labels: {
        ...labels,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
    },
  });
  add(`${core}/resourcequotas/budget`, {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: metadata("budget"),
    spec: {
      hard: {
        "requests.cpu": "2",
        "requests.memory": "4Gi",
        "limits.cpu": "2",
        "limits.memory": "4Gi",
        pods: "1",
        persistentvolumeclaims: "1",
        "requests.storage": "5Gi",
        "count/services": "1",
        "count/secrets": "4",
        // Kubernetes publishes kube-root-ca.crt into every namespace; with "1" the seed
        // ConfigMap exceeded the quota (HTTP 403) and no workspace could ever start.
        "count/configmaps": "2",
      },
    },
  });
  add(`${core}/limitranges/defaults`, {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: metadata("defaults"),
    spec: {
      limits: [
        {
          type: "Container",
          default: { cpu: "2", memory: "4Gi" },
          defaultRequest: { cpu: "250m", memory: "512Mi" },
        },
      ],
    },
  });
  add(`/apis/networking.k8s.io/v1/namespaces/${n}/networkpolicies/isolation`, {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: metadata("isolation"),
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": c.INGRESS_NAMESPACE },
              },
            },
          ],
          ports: [{ port: 8088, protocol: "TCP" }],
        },
      ],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { port: 53, protocol: "UDP" },
            { port: 53, protocol: "TCP" },
          ],
        },
        {
          to: [
            {
              ipBlock: {
                cidr: "0.0.0.0/0",
                except: [
                  "0.0.0.0/8",
                  "10.0.0.0/8",
                  "100.64.0.0/10",
                  "127.0.0.0/8",
                  "169.254.0.0/16",
                  "172.16.0.0/12",
                  "192.0.0.0/24",
                  "192.168.0.0/16",
                  "198.18.0.0/15",
                  "224.0.0.0/4",
                  "240.0.0.0/4",
                ],
              },
            },
          ],
          ports: [
            { port: 80, protocol: "TCP" },
            { port: 443, protocol: "TCP" },
          ],
        },
      ],
    },
  });
  add(`${core}/persistentvolumeclaims/home`, {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: metadata("home"),
    spec: {
      accessModes: ["ReadWriteOnce"],
      ...(c.STORAGE_CLASS ? { storageClassName: c.STORAGE_CLASS } : {}),
      resources: { requests: { storage: "5Gi" } },
    },
  });
  add(`${core}/configmaps/seed`, {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: metadata("seed"),
    data: { "files.json": JSON.stringify(files) },
  });
  add(`${core}/secrets/gateway`, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: metadata("gateway"),
    type: "Opaque",
    data: { key: Buffer.from(key).toString("base64") },
  });
  add(`${core}/secrets/environment`, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: metadata("environment"),
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries(secrets).map(([k, v]) => [k, Buffer.from(v).toString("base64")]),
    ),
  });
  add(`/apis/apps/v1/namespaces/${n}/deployments/workspace`, {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: metadata("workspace"),
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { "harness.cloud/project": p.id } },
      template: {
        metadata: { labels, annotations: { "harness.cloud/revision": String(p.revision) } },
        spec: {
          runtimeClassName: c.RUNTIME_CLASS,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 30,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "workspace",
              image: c.WORKSPACE_IMAGE,
              imagePullPolicy: "IfNotPresent",
              ports: [{ containerPort: 8088 }],
              envFrom: [{ secretRef: { name: "environment" } }],
              env: [
                { name: "PROJECT_ID", value: p.id },
                { name: "APP_ORIGIN", value: c.APP_ORIGIN },
                { name: "IDE_HOST", value: h.ide },
                { name: "AI_HOST", value: h.agent },
                { name: "APP_HOST", value: h.app },
                { name: "PUBLISHED", value: String(p.published) },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: { cpu: "250m", memory: "512Mi" },
                limits: { cpu: "2", memory: "4Gi" },
              },
              startupProbe: {
                httpGet: { path: "/healthz", port: 8088 },
                failureThreshold: 60,
                periodSeconds: 5,
              },
              readinessProbe: { httpGet: { path: "/healthz", port: 8088 }, periodSeconds: 10 },
              livenessProbe: { httpGet: { path: "/livez", port: 8088 }, periodSeconds: 20 },
              volumeMounts: [
                { name: "home", mountPath: "/home/coder" },
                { name: "tmp", mountPath: "/tmp" },
                { name: "seed", mountPath: "/run/seed", readOnly: true },
                { name: "gateway", mountPath: "/run/gateway", readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: "home", persistentVolumeClaim: { claimName: "home" } },
            { name: "tmp", emptyDir: { sizeLimit: "512Mi" } },
            { name: "seed", configMap: { name: "seed" } },
            { name: "gateway", secret: { secretName: "gateway", defaultMode: 292 } },
          ],
        },
      },
    },
  });
  add(`${core}/services/workspace`, {
    apiVersion: "v1",
    kind: "Service",
    metadata: metadata("workspace"),
    spec: {
      selector: { "harness.cloud/project": p.id },
      ports: [{ name: "http", port: 8088, targetPort: 8088 }],
    },
  });
  const allHosts = p.published ? [h.ide, h.agent, h.app] : [h.ide, h.agent];
  add(`/apis/networking.k8s.io/v1/namespaces/${n}/ingresses/workspace`, {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      ...metadata("workspace"),
      annotations: {
        "cert-manager.io/cluster-issuer": c.TLS_ISSUER,
        "nginx.ingress.kubernetes.io/ssl-redirect": "true",
        "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
        "nginx.ingress.kubernetes.io/proxy-body-size": "10m",
      },
    },
    spec: {
      ingressClassName: c.INGRESS_CLASS,
      tls: [{ hosts: allHosts, secretName: "workspace-tls" }],
      rules: allHosts.map((host) => ({
        host,
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: { service: { name: "workspace", port: { number: 8088 } } },
            },
          ],
        },
      })),
    },
  });
  return resources;
}
