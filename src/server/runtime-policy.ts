import type { Database } from "./db.js";
import type { Config } from "./config.js";
import { HttpError, audit } from "./contracts.js";
import { encrypt, token } from "./security.js";
import { snapshotRelease } from "./releases.js";
// A stopping or uncertain workspace still occupies capacity until observed stopped.
export const occupied =
  "(desired='running' OR status IN ('running','starting','stopping','deleting') OR (provisioned AND status='error'))";
export async function changeRuntime(
  db: Database,
  c: Config,
  userId: string,
  projectId: string,
  action: "start" | "stop" | "restart" | "publish" | "unpublish",
) {
  await db.transaction(async (tx) => {
    // Fixed lock order across API, expiry sweeps, and member suspension.
    await tx.query("SELECT id FROM runtime_capacity WHERE id=1 FOR UPDATE");
    const {
      rows: [u],
    } = await tx.query("SELECT suspended_at FROM users WHERE id=$1 FOR NO KEY UPDATE", [userId]);
    if (!u || u.suspended_at) throw new HttpError(403, "La cuenta no está disponible.");
    const {
      rows: [p],
    } = await tx.query("SELECT * FROM projects WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
      projectId,
      userId,
    ]);
    if (!p) throw new HttpError(404, "Proyecto no encontrado.");
    if (p.desired === "deleted" || (p.archived && action !== "stop"))
      throw new HttpError(409, "El proyecto está archivado o eliminándose.");
    if (["restart", "publish", "unpublish"].includes(action) && p.desired !== "running")
      throw new HttpError(409, "Inicia el entorno primero.");
    if (action === "start" && p.desired !== "running" && p.status !== "stopped")
      throw new HttpError(409, "Espera a que el entorno confirme su detención.");
    const starting = action === "start" && p.desired !== "running";
    if (starting) {
      const {
        rows: [usage],
      } = await tx.query(
        `SELECT count(*)::int AS total,count(*) FILTER (WHERE owner_id=$1)::int AS own FROM projects WHERE ${occupied}`,
        [userId],
      );
      if (usage.own >= c.MAX_RUNNING_PER_USER)
        throw new HttpError(
          409,
          `Límite de ${c.MAX_RUNNING_PER_USER} entornos simultáneos por cuenta. Detén otro entorno primero.`,
        );
      if (usage.total >= c.MAX_RUNNING_TOTAL)
        throw new HttpError(409, "La capacidad global está ocupada. Intenta más tarde.");
    }
    if (
      action !== "stop" &&
      !starting &&
      (!p.runtime_expires_at || new Date(p.runtime_expires_at) <= new Date())
    )
      throw new HttpError(
        409,
        "La sesión de ejecución venció. Detén el entorno antes de volver a iniciarlo.",
      );
    const desired = action === "stop" ? "stopped" : "running";
    await tx.query(
      `UPDATE projects SET desired=$1,status=$2,published=$3,revision=revision+1,error=NULL,runtime_key=COALESCE(runtime_key,$4),runtime_expires_at=CASE WHEN $5 THEN now()+($6 * interval '1 minute') ELSE runtime_expires_at END,updated_at=now() WHERE id=$7`,
      [
        desired,
        desired === "running" ? "starting" : "stopping",
        action === "publish" ? true : ["stop", "unpublish"].includes(action) ? false : p.published,
        encrypt(token(), c.ENCRYPTION_KEY!, p.id),
        starting,
        c.MAX_RUNTIME_MINUTES,
        p.id,
      ],
    );
    await audit(tx, userId, `runtime.${action}`, p.id);
    // Publishing is the moment worth keeping: the live workspace is seeded from exactly these
    // files, so the snapshot is a restore point rather than an invented deploy history.
    if (action === "publish")
      await snapshotRelease(tx, p.id, "Publicación de la revisión " + (p.revision + 1));
  });
}
export async function expireRuntimes(db: Database) {
  return db.transaction(async (tx) => {
    await tx.query("SELECT id FROM runtime_capacity WHERE id=1 FOR UPDATE");
    // NULL includes pre-upgrade running projects: fail closed on unknown leases.
    const { rows } = await tx.query(
      "UPDATE projects SET desired='stopped',status='stopping',published=false,revision=revision+1,updated_at=now() WHERE desired='running' AND (runtime_expires_at IS NULL OR runtime_expires_at<=now()) RETURNING id,owner_id",
    );
    for (const p of rows)
      await audit(
        tx,
        p.owner_id,
        "runtime.expired",
        p.id,
        "Duración máxima de ejecución alcanzada",
      );
    return rows.length;
  });
}
export async function capacityReport(db: Database, c: Config) {
  const {
    rows: [usage],
  } = await db.query(
    `SELECT count(*) FILTER(WHERE ${occupied})::int AS reserved,count(*) FILTER(WHERE status='running')::int AS observed_running,count(*) FILTER(WHERE status='error')::int AS errors,count(*) FILTER(WHERE revision<>reconciled_revision)::int AS pending FROM projects`,
  );
  const { rows: workers } = await db.query(
    "SELECT id,last_seen,last_success,error,last_seen>now()-interval '90 seconds' AS fresh,last_success>now()-interval '5 minutes' AS progressing FROM worker_health WHERE last_seen>now()-interval '24 hours' ORDER BY last_seen DESC",
  );
  return {
    limits: {
      perUser: c.MAX_RUNNING_PER_USER,
      total: c.MAX_RUNNING_TOTAL,
      minutes: c.MAX_RUNTIME_MINUTES,
    },
    usage,
    workers,
    workerHealthy: workers.some((w) => w.fresh && w.progressing && !w.error),
    notice:
      "Capacidad reservada según el plano de control, no consumo medido. La detención por vencimiento necesita un worker operativo.",
  };
}
