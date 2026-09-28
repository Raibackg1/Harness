import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Config } from "./config.js";
import { Kubernetes, type Project } from "./kubernetes.js";
import { expireRuntimes } from "./runtime-policy.js";
import { assertEncryptionKey } from "./encryption-maintenance.js";
import { decrypt } from "./security.js";
export async function reconcileOne(db: Database, config: Config, k8s: Kubernetes) {
  await assertEncryptionKey(db, config.ENCRYPTION_KEY);
  const leaseId = randomUUID();
  const {
    rows: [p],
  } = await db.query<Project & { lease_id: string }>(
    `UPDATE projects SET lease_until=now()+interval '5 minutes', lease_id=$1 WHERE id=(SELECT id FROM projects WHERE (lease_until IS NULL OR lease_until<now()) AND (desired='running' OR status IN ('starting','stopping','deleting') OR revision<>reconciled_revision) ORDER BY CASE desired WHEN 'deleted' THEN 0 WHEN 'stopped' THEN 1 ELSE 2 END, updated_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
    [leaseId],
  );
  if (!p) return false;
  const heartbeat = setInterval(() => {
    void db
      .query(
        "UPDATE projects SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND lease_id=$2",
        [p.id, leaseId],
      )
      .catch(() => {});
  }, 30000);
  heartbeat.unref();
  try {
    if (p.desired === "deleted") {
      if (await k8s.remove(p.id))
        await db.query("DELETE FROM projects WHERE id=$1 AND lease_id=$2", [p.id, leaseId]);
      else
        await db.query(
          "UPDATE projects SET status='deleting', lease_until=now()+interval '10 seconds' WHERE id=$1 AND lease_id=$2",
          [p.id, leaseId],
        );
      return true;
    }
    let status: string;
    if (p.desired === "stopped") status = await k8s.stop(p.id);
    else {
      // Persist resource intent before the first cluster write, including partial failures.
      await db.query("UPDATE projects SET provisioned=true WHERE id=$1 AND lease_id=$2", [
        p.id,
        leaseId,
      ]);
      const [files, encrypted] = await Promise.all([
        db.query("SELECT path,content FROM project_files WHERE project_id=$1", [p.id]),
        db.query("SELECT name,ciphertext FROM secrets WHERE project_id=$1", [p.id]),
      ]);
      const secrets = Object.fromEntries(
        encrypted.rows.map((s) => [
          s.name,
          decrypt(s.ciphertext, config.ENCRYPTION_KEY!, `${p.id}:${s.name}`),
        ]),
      );
      status = await k8s.ensure(
        p,
        Object.fromEntries(files.rows.map((f) => [f.path, f.content])),
        secrets,
        decrypt(p.runtime_key, config.ENCRYPTION_KEY!, p.id),
      );
    }
    await db.query(
      "UPDATE projects SET status=$1,error=NULL,provisioned=provisioned OR $2,reconciled_revision=$3,lease_until=now()+interval '15 seconds' WHERE id=$4 AND lease_id=$5 AND revision=$3",
      [status, p.desired === "running", p.revision, p.id, leaseId],
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Reconciliation failed";
    await db.query(
      "UPDATE projects SET status='error',error=$1,lease_until=now()+interval '60 seconds' WHERE id=$2 AND lease_id=$3 AND revision=$4",
      [message.slice(0, 500), p.id, leaseId, p.revision],
    );
  } finally {
    clearInterval(heartbeat);
    await db.query(
      "UPDATE projects SET lease_until=NULL WHERE id=$1 AND lease_id=$2 AND revision<>$3",
      [p.id, leaseId, p.revision],
    );
  }
  return true;
}
export function startWorker(
  db: Database,
  config: Config,
  k8s: Kubernetes,
  onError: (e: unknown) => void,
) {
  const workerId = randomUUID();
  let stopped = false;
  const pulse = () =>
    db.query(
      "INSERT INTO worker_health(id,last_seen) VALUES($1,now()) ON CONFLICT(id) DO UPDATE SET last_seen=now()",
      [workerId],
    );
  const healthTimer = setInterval(() => void pulse().catch(onError), 15000);
  healthTimer.unref();
  let active: Promise<void> | undefined;
  let timer: NodeJS.Timeout;
  const tick = () => {
    active = (async () => {
      try {
        await assertEncryptionKey(db, config.ENCRYPTION_KEY);
        await pulse();
        await expireRuntimes(db);
        for (let i = 0; i < 10 && !stopped; i++) {
          await expireRuntimes(db);
          if (!(await reconcileOne(db, config, k8s))) break;
          await db.query("UPDATE worker_health SET last_success=now(),error=NULL WHERE id=$1", [
            workerId,
          ]);
        }
        await db.query("UPDATE worker_health SET last_success=now(),error=NULL WHERE id=$1", [
          workerId,
        ]);
        await db.query("DELETE FROM worker_health WHERE last_seen<now()-interval '24 hours'");
      } catch (e) {
        onError(e);
        await db
          .query("UPDATE worker_health SET error=$1 WHERE id=$2", [
            (e instanceof Error ? e.message : "Worker error").slice(0, 500),
            workerId,
          ])
          .catch(onError);
      } finally {
        if (!stopped) timer = setTimeout(tick, 3000);
      }
    })();
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(healthTimer);
    await active;
    await db.query("DELETE FROM worker_health WHERE id=$1", [workerId]);
  };
}
