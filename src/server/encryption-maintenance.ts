import type { Database, Sql } from "./db.js";
import { decrypt, encrypt, hash } from "./security.js";
import { occupied } from "./runtime-policy.js";

export class EncryptionMaintenanceError extends Error {
  readonly statusCode = 503;
}
export function keyFingerprint(key: string) {
  if (!/^[a-f\d]{64}$/i.test(key))
    throw new EncryptionMaintenanceError(
      "La clave debe contener exactamente 64 caracteres hexadecimales.",
    );
  return hash(`harness-cloud:encryption-key:v1:${key.toLowerCase()}`);
}
const mismatch = () =>
  new EncryptionMaintenanceError(
    "La clave de cifrado no coincide con la base de datos. Mantén el servicio fuera de tráfico y revisa la configuración de claves.",
  );
export async function assertEncryptionKey(sql: Sql, key?: string, lock = false) {
  const {
    rows: [state],
  } = await sql.query(
    `SELECT key_fingerprint FROM encryption_state WHERE id=1${lock ? " FOR SHARE" : ""}`,
  );
  if (!state)
    throw new EncryptionMaintenanceError(
      "Falta el estado de cifrado; aplica las migraciones primero.",
    );
  if (state.key_fingerprint && (!key || keyFingerprint(key) !== state.key_fingerprint))
    throw mismatch();
}
// API encryption mutations already use transactions. Hold a shared key-state lock
// for their full duration, so a queued pre-rotation request cannot write an old-key
// ciphertext after the exclusive rotation commits. Readiness checks alone would race.
export function withEncryptionFence(db: Database, key?: string): Database {
  return {
    ...db,
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await assertEncryptionKey(tx, key, true);
        return fn(tx);
      }),
  };
}
export type EncryptionCounts = {
  secrets: number;
  runtimeKeys: number;
  databaseKeys: number;
  mfaSeeds: number;
  pendingMfaSeeds: number;
};
// Bounded keyset batches: plaintext is never returned, accumulated or logged.
// Caller holds the maintenance/table locks. A single transaction covers ALL batches.
async function visitEncryptedValues(tx: Sql, oldKey?: string, newKey?: string) {
  const counts: EncryptionCounts = {
    secrets: 0,
    runtimeKeys: 0,
    databaseKeys: 0,
    mfaSeeds: 0,
    pendingMfaSeeds: 0,
  };
  const transform = (value: string, context: string) => {
    if (!oldKey) throw mismatch();
    try {
      const plain = decrypt(value, oldKey, context);
      return newKey ? encrypt(plain, newKey, context) : undefined;
    } catch {
      throw new EncryptionMaintenanceError(
        "No se pudo autenticar un valor cifrado. Revisa la clave original o la integridad del backup; no se aplicó la rotación.",
      );
    }
  };
  let cursor: string | null = null,
    name = "";
  while (true) {
    const { rows }: { rows: { project_id: string; name: string; ciphertext: string }[] } =
      await tx.query(
        "SELECT project_id,name,ciphertext FROM secrets WHERE $1::uuid IS NULL OR (project_id,name)>($1::uuid,$2::text) ORDER BY project_id,name LIMIT 100",
        [cursor, name],
      );
    if (!rows.length) break;
    for (const row of rows) {
      const value = transform(row.ciphertext, `${row.project_id}:${row.name}`);
      if (newKey)
        await tx.query("UPDATE secrets SET ciphertext=$1 WHERE project_id=$2 AND name=$3", [
          value,
          row.project_id,
          row.name,
        ]);
      counts.secrets++;
      cursor = row.project_id;
      name = row.name;
    }
  }
  cursor = null;
  while (true) {
    const {
      rows,
    }: { rows: { id: string; runtime_key: string | null; database_key: string | null }[] } =
      await tx.query(
        "SELECT id,runtime_key,database_key FROM projects WHERE (runtime_key IS NOT NULL OR database_key IS NOT NULL) AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 100",
        [cursor],
      );
    if (!rows.length) break;
    for (const row of rows) {
      if (row.runtime_key !== null) {
        const value = transform(row.runtime_key, row.id);
        if (newKey)
          await tx.query("UPDATE projects SET runtime_key=$1 WHERE id=$2", [value, row.id]);
        counts.runtimeKeys++;
      }
      if (row.database_key !== null) {
        const value = transform(row.database_key, `db:${row.id}`);
        if (newKey)
          await tx.query("UPDATE projects SET database_key=$1 WHERE id=$2", [value, row.id]);
        counts.databaseKeys++;
      }
      cursor = row.id;
    }
  }
  cursor = null;
  while (true) {
    const {
      rows,
    }: { rows: { id: string; mfa_secret: string | null; mfa_pending: string | null }[] } =
      await tx.query(
        "SELECT id,mfa_secret,mfa_pending FROM users WHERE (mfa_secret IS NOT NULL OR mfa_pending IS NOT NULL) AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 100",
        [cursor],
      );
    if (!rows.length) break;
    for (const row of rows) {
      for (const [column, count] of [
        ["mfa_secret", "mfaSeeds"],
        ["mfa_pending", "pendingMfaSeeds"],
      ] as const) {
        if (row[column] !== null) {
          const value = transform(row[column], `mfa:${row.id}`);
          if (newKey) await tx.query(`UPDATE users SET ${column}=$1 WHERE id=$2`, [value, row.id]);
          counts[count]++;
        }
      }
      cursor = row.id;
    }
  }
  return counts;
}
async function maintenanceLock(tx: Sql) {
  await tx.query("SET LOCAL lock_timeout='5s'");
  const {
    rows: [state],
  } = await tx.query("SELECT key_fingerprint FROM encryption_state WHERE id=1 FOR UPDATE");
  if (!state)
    throw new EncryptionMaintenanceError(
      "Falta el estado de cifrado; aplica las migraciones primero.",
    );
  return state;
}
// Once per API/worker startup. Legacy databases are authenticated before binding
// their first fingerprint. This does NOT replace the required maintenance window.
export async function initializeEncryptionKey(db: Database, key?: string) {
  if (key) keyFingerprint(key);
  await db.transaction(async (tx) => {
    const state = await maintenanceLock(tx);
    if (state.key_fingerprint) {
      await assertEncryptionKey(tx, key);
      return;
    }
    await tx.query("LOCK TABLE users,projects,secrets IN SHARE ROW EXCLUSIVE MODE");
    await visitEncryptedValues(tx, key);
    if (key)
      await tx.query("UPDATE encryption_state SET key_fingerprint=$1,updated_at=now() WHERE id=1", [
        keyFingerprint(key),
      ]);
  });
}
export async function rotateEncryptionKey(
  db: Database,
  options: {
    oldKey: string;
    newKey: string;
    operator: string;
    apply?: boolean;
    offline?: boolean;
  },
) {
  const from = keyFingerprint(options.oldKey),
    to = keyFingerprint(options.newKey);
  if (from === to)
    throw new EncryptionMaintenanceError("La clave nueva debe ser diferente de la anterior.");
  if (
    !options.operator.trim() ||
    options.operator.length > 120 ||
    /[\x00-\x1f\x7f]/.test(options.operator)
  )
    throw new EncryptionMaintenanceError(
      "Indica un identificador de operador/cambio de 1–120 caracteres sin controles.",
    );
  if (options.apply && !options.offline)
    throw new EncryptionMaintenanceError(
      "Aplicar requiere confirmar --offline tras detener API y worker y verificar los entornos detenidos.",
    );
  return db.transaction(async (tx) => {
    const state = await maintenanceLock(tx);
    if (state.key_fingerprint && state.key_fingerprint !== from) throw mismatch();
    await tx.query("LOCK TABLE users,projects,secrets,worker_health IN SHARE ROW EXCLUSIVE MODE");
    if (options.apply) {
      const {
        rows: [active],
      } = await tx.query(
        `SELECT EXISTS(SELECT 1 FROM projects WHERE ${occupied} OR lease_until>now()) AS runtimes, EXISTS(SELECT 1 FROM worker_health WHERE last_seen>now()-interval '90 seconds') AS workers`,
      );
      if (active.runtimes || active.workers)
        throw new EncryptionMaintenanceError(
          "Hay entornos reservados, leases o workers recientes. Detén y verifica los servicios antes de aplicar.",
        );
    }
    const counts = await visitEncryptedValues(
      tx,
      options.oldKey,
      options.apply ? options.newKey : undefined,
    );
    if (!options.apply) return { dryRun: true, counts, auditId: null };
    await tx.query("UPDATE encryption_state SET key_fingerprint=$1,updated_at=now() WHERE id=1", [
      to,
    ]);
    const {
      rows: [event],
    } = await tx.query(
      "INSERT INTO audit_events(action,detail) VALUES('platform.encryption_key_rotated',$1) RETURNING id",
      [JSON.stringify({ operator: options.operator.trim(), from, to, counts })],
    );
    return { dryRun: false, counts, auditId: event.id as number | string };
  });
}
