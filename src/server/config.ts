import "dotenv/config";
import { z } from "zod";
import { getDomain } from "tldts";
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default(".data/postgres"),
  APP_ORIGIN: z.string().url().optional(),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
  BOOTSTRAP_TOKEN: z.string().min(32).optional(),
  KUBERNETES_ENABLED: z.enum(["true", "false"]).default("false"),
  WORKSPACE_DOMAIN: z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .optional(),
  WORKSPACE_IMAGE: z.string().optional(),
  RUNTIME_CLASS: z.string().default("gvisor"),
  STORAGE_CLASS: z.string().optional(),
  INGRESS_CLASS: z.string().default("nginx"),
  TLS_ISSUER: z.string().default("letsencrypt-prod"),
  MAX_PROJECTS: z.coerce.number().int().min(1).max(100).default(10),
  MAX_RUNNING_PER_USER: z.coerce.number().int().min(1).max(100).default(2),
  MAX_RUNNING_TOTAL: z.coerce.number().int().min(1).max(10000).default(20),
  MAX_RUNTIME_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  PLATFORM_NAMESPACE: z.string().default("harness-system"),
  INGRESS_NAMESPACE: z.string().default("ingress-nginx"),
});
export type Config = z.infer<typeof envSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = envSchema.parse(env);
  if (c.NODE_ENV === "production") {
    for (const key of ["DATABASE_URL", "APP_ORIGIN", "ENCRYPTION_KEY", "BOOTSTRAP_TOKEN"] as const)
      if (!c[key]) throw new Error(`${key} is required in production`);
    if (!c.APP_ORIGIN!.startsWith("https://")) throw new Error("APP_ORIGIN must use HTTPS");
  }
  if (c.KUBERNETES_ENABLED === "true") {
    // The workspace gateway refuses to boot without APP_ORIGIN, and the generated
    // Deployment drops an undefined env value entirely (JSON.stringify), so a missing
    // origin surfaces as a crash-looping workspace or an opaque admission error.
    if (!c.APP_ORIGIN)
      throw new Error(
        "Kubernetes requires APP_ORIGIN: the gateway validates the launch origin of every ticket",
      );
    if (!c.APP_ORIGIN.startsWith("https://"))
      throw new Error("APP_ORIGIN must use HTTPS with Kubernetes workspaces");
    if (!c.WORKSPACE_DOMAIN || !c.WORKSPACE_IMAGE || !c.ENCRYPTION_KEY)
      throw new Error("Kubernetes requires WORKSPACE_DOMAIN, WORKSPACE_IMAGE and ENCRYPTION_KEY");
    if (!/^[-a-zA-Z0-9_./:]+@sha256:[a-f0-9]{64}$/.test(c.WORKSPACE_IMAGE))
      throw new Error("WORKSPACE_IMAGE must be pinned by digest");
    if (c.RUNTIME_CLASS !== "gvisor" && c.RUNTIME_CLASS !== "kata")
      throw new Error("Only gvisor or kata runtimes are allowed");
    let controlHost = "";
    try {
      controlHost = new URL(c.APP_ORIGIN!).hostname;
    } catch {
      throw new Error("APP_ORIGIN must be an absolute URL with a host");
    }
    if (!controlHost) throw new Error("APP_ORIGIN must include a host");
    if (
      !getDomain(c.WORKSPACE_DOMAIN, { allowPrivateDomains: true }) ||
      getDomain(controlHost, { allowPrivateDomains: true }) ===
        getDomain(c.WORKSPACE_DOMAIN, { allowPrivateDomains: true }) ||
      controlHost === c.WORKSPACE_DOMAIN ||
      controlHost.endsWith("." + c.WORKSPACE_DOMAIN) ||
      c.WORKSPACE_DOMAIN.endsWith("." + controlHost)
    )
      throw new Error("Workspaces require an isolated domain");
  }
  return c;
}
