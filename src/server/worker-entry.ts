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
const stop = startWorker(db, config, new Kubernetes(config), (e) =>
  console.error(e instanceof Error ? e.message : "Worker failure"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await stop();
    await db.close();
    process.exit(0);
  });
