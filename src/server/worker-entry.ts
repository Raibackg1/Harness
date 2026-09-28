import { loadConfig } from "./config.js";
import { createDatabase, migrate } from "./db.js";
import { Kubernetes } from "./kubernetes.js";
import { startWorker } from "./worker.js";
import { initializeEncryptionKey } from "./encryption-maintenance.js";
const config = loadConfig();
if (config.KUBERNETES_ENABLED !== "true") throw new Error("Worker requires Kubernetes.");
const db = await createDatabase(config);
await migrate(db);
await initializeEncryptionKey(db, config.ENCRYPTION_KEY);
const k8s = new Kubernetes(config);
// Fail closed: the worker's cluster-scoped RBAC is only bounded by the admission
// policies. Reconciling without them would let a compromised worker touch any namespace.
const boundaries = await k8s.sandboxBoundaries();
if (!boundaries.ok)
  throw new Error(
    `Admission boundary incomplete: ${boundaries.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.name} (${c.problems.join("; ")})`)
      .join(" | ")}. Install infra/k8s/admission.yaml before reconciling.`,
  );
const stop = startWorker(db, config, k8s, (e) =>
  console.error(e instanceof Error ? e.message : "Worker failure"),
);

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await stop();
    await db.close();
    process.exit(0);
  });
