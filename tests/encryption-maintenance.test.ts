import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/db";
import {
  assertEncryptionKey,
  initializeEncryptionKey,
  keyFingerprint,
  withEncryptionFence,
  rotateEncryptionKey,
} from "../src/server/encryption-maintenance";
import { encrypt, decrypt, passwordHash, hash } from "../src/server/security";
import { authenticator, newAuthenticator } from "../src/server/mfa";
import { createApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { reconcileOne } from "../src/server/worker";
import type { Kubernetes } from "../src/server/kubernetes";
const oldKey = "ab".repeat(32),
  newKey = "cd".repeat(32),
  thirdKey = "ef".repeat(32);
const user = "10000000-0000-4000-8000-000000000001",
  project = "20000000-0000-4000-8000-000000000001";
const secret = newAuthenticator("rotation@example.test").secret,
  password = "rotation-test-password";
const options = { oldKey, newKey, operator: "operator/change-2026", apply: true, offline: true };
let db: Database, encoded: string;
beforeAll(async () => {
  db = await createDatabase({ DATA_DIR: "memory://", DATABASE_URL: process.env.TEST_DATABASE_URL });
  await migrate(db);
  encoded = await passwordHash(password);
});
beforeEach(async () => {
  await db.query("TRUNCATE users,projects,worker_health,audit_events CASCADE");
  await db.query("UPDATE encryption_state SET key_fingerprint=NULL WHERE id=1");
  await db.query(
    "INSERT INTO users(id,email,name,password_hash,role,mfa_secret,mfa_pending,mfa_pending_until,mfa_counter) VALUES($1,'rotation@example.test','Rotation',$2,'owner',$3,$3,now()+interval '10 minutes',7)",
    [user, encoded, encrypt(secret, oldKey, `mfa:${user}`)],
  );
  await db.query(
    "INSERT INTO projects(id,owner_id,name,template,runtime_key,database,database_key) VALUES($1,$2,'Rotation','node',$3,true,$4)",
    [
      project,
      user,
      encrypt("gateway-signing-key", oldKey, project),
      encrypt("app-database-password", oldKey, `db:${project}`),
    ],
  );
  for (const name of ["FIRST_KEY", "SECOND_KEY"])
    await db.query("INSERT INTO secrets(project_id,name,ciphertext)VALUES($1,$2,$3)", [
      project,
      name,
      encrypt("provider-private-" + name, oldKey, `${project}:${name}`),
    ]);
  await db.query(
    "INSERT INTO sessions(id_hash,user_id,expires_at)VALUES($1,$2,now()+interval '1 day')",
    [hash("existing-session"), user],
  );
  await db.query(
    "INSERT INTO recovery_codes(user_id,code_hash)VALUES($1,'unchanged-backup-hash')",
    [user],
  );
});
afterAll(async () => db.close());
async function snapshot() {
  return {
    users: (await db.query("SELECT * FROM users ORDER BY id")).rows,
    projects: (await db.query("SELECT * FROM projects ORDER BY id")).rows,
    secrets: (await db.query("SELECT * FROM secrets ORDER BY project_id,name")).rows,
    sessions: (await db.query("SELECT * FROM sessions ORDER BY id")).rows,
    recovery: (await db.query("SELECT * FROM recovery_codes ORDER BY user_id")).rows,
    key: (await db.query("SELECT * FROM encryption_state")).rows,
    audit: (await db.query("SELECT * FROM audit_events ORDER BY id")).rows,
  };
}
describe("offline authenticated key rotation", () => {
  it("binds legacy ciphertext only after authenticating all values and normalizes hex case", async () => {
    await expect(initializeEncryptionKey(db)).rejects.toThrow("clave");
    await expect(initializeEncryptionKey(db, newKey)).rejects.toThrow("autenticar");
    expect((await snapshot()).key[0].key_fingerprint).toBeNull();
    await initializeEncryptionKey(db, oldKey.toUpperCase());
    expect((await snapshot()).key[0].key_fingerprint).toBe(keyFingerprint(oldKey));
    await expect(assertEncryptionKey(db, newKey)).rejects.toThrow("no coincide");
    await expect(initializeEncryptionKey(db)).rejects.toThrow("no coincide");
  });
  it("defaults to validation only, with no ciphertext, fingerprint or audit changes", async () => {
    const before = await snapshot();
    const result = await rotateEncryptionKey(db, { oldKey, newKey, operator: "validation" });
    expect(result).toEqual({
      dryRun: true,
      counts: { secrets: 2, runtimeKeys: 1, databaseKeys: 1, mfaSeeds: 1, pendingMfaSeeds: 1 },
      auditId: null,
    });
    expect(await snapshot()).toEqual(before);
  });
  it("rewraps all four categories, preserving plaintext, AAD, credentials and unrelated metadata", async () => {
    await initializeEncryptionKey(db, oldKey);
    const before = await snapshot();
    const result = await rotateEncryptionKey(db, options);
    const after = await snapshot();
    expect(result.dryRun).toBe(false);
    expect(result.auditId).toBeTruthy();
    for (const row of after.secrets) {
      expect(decrypt(row.ciphertext, newKey, `${row.project_id}:${row.name}`)).toBe(
        "provider-private-" + row.name,
      );
      expect(() => decrypt(row.ciphertext, oldKey, `${row.project_id}:${row.name}`)).toThrow();
      expect(() => decrypt(row.ciphertext, newKey, `${row.project_id}:OTHER_KEY`)).toThrow();
    }
    expect(decrypt(after.projects[0].runtime_key, newKey, project)).toBe("gateway-signing-key");
    expect(decrypt(after.projects[0].database_key, newKey, `db:${project}`)).toBe(
      "app-database-password",
    );
    expect(() => decrypt(after.projects[0].database_key, oldKey, `db:${project}`)).toThrow();
    for (const column of ["mfa_secret", "mfa_pending"])
      expect(decrypt(after.users[0][column], newKey, `mfa:${user}`)).toBe(secret);
    expect(after.users[0].password_hash).toBe(encoded);
    expect(Number(after.users[0].mfa_counter)).toBe(7);
    expect(after.users[0].mfa_pending_until).toEqual(before.users[0].mfa_pending_until);
    expect(after.projects[0].revision).toBe(before.projects[0].revision);
    expect(after.projects[0].updated_at).toEqual(before.projects[0].updated_at);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.recovery).toEqual(before.recovery);
    expect(after.key[0].key_fingerprint).toBe(keyFingerprint(newKey));
    const audit = JSON.parse(after.audit[0].detail);
    expect(audit).toMatchObject({ operator: options.operator, counts: result.counts });
    for (const privateValue of [
      oldKey,
      newKey,
      secret,
      "provider-private-FIRST_KEY",
      "gateway-signing-key",
    ])
      expect(JSON.stringify(result) + after.audit[0].detail).not.toContain(privateValue);
  });
  it("rolls back earlier rewrites and key metadata when the last category is corrupt", async () => {
    await initializeEncryptionKey(db, oldKey);
    await db.query("UPDATE users SET mfa_pending='corrupt-ciphertext' WHERE id=$1", [user]);
    const before = await snapshot();
    await expect(rotateEncryptionKey(db, options)).rejects.toThrow("autenticar");
    expect(await snapshot()).toEqual(before);
  });
  it("rejects a wrong original key and duplicate keys without changing the database", async () => {
    await initializeEncryptionKey(db, oldKey);
    const before = await snapshot();
    await expect(rotateEncryptionKey(db, { ...options, oldKey: thirdKey })).rejects.toThrow(
      "no coincide",
    );
    await expect(
      rotateEncryptionKey(db, { ...options, newKey: oldKey.toUpperCase() }),
    ).rejects.toThrow("diferente");
    expect(await snapshot()).toEqual(before);
  });
  it("requires an explicit maintenance acknowledgement and valid operator identifier", async () => {
    await expect(rotateEncryptionKey(db, { ...options, offline: false })).rejects.toThrow(
      "--offline",
    );
    await expect(rotateEncryptionKey(db, { ...options, operator: "\n" })).rejects.toThrow(
      "operador",
    );
    await expect(rotateEncryptionKey(db, { ...options, newKey: "invalid" })).rejects.toThrow("64");
  });
  it.each([
    ["running", "running", false],
    ["stopped", "stopping", false],
    ["stopped", "error", true],
  ])("refuses occupied runtimes (%s/%s)", async (desired, status, provisioned) => {
    await db.query("UPDATE projects SET desired=$1,status=$2,provisioned=$3 WHERE id=$4", [
      desired,
      status,
      provisioned,
      project,
    ]);
    const before = await snapshot();
    await expect(rotateEncryptionKey(db, options)).rejects.toThrow("entornos");
    expect(await snapshot()).toEqual(before);
  });
  it("refuses outstanding leases and fresh worker registrations, even with zero running intent", async () => {
    await db.query("UPDATE projects SET lease_until=now()+interval '1 minute' WHERE id=$1", [
      project,
    ]);
    await expect(rotateEncryptionKey(db, options)).rejects.toThrow("leases");
    await db.query("UPDATE projects SET lease_until=NULL");
    await db.query("INSERT INTO worker_health(id)VALUES($1)", [user]);
    await expect(rotateEncryptionKey(db, options)).rejects.toThrow("workers");
    await db.query("UPDATE worker_health SET last_seen=now()-interval '2 minutes'");
    await expect(rotateEncryptionKey(db, options)).resolves.toMatchObject({ dryRun: false });
  });
  it("serializes two competing rotations so the old key cannot overwrite a successful rotation", async () => {
    await initializeEncryptionKey(db, oldKey);
    const results = await Promise.allSettled([
      rotateEncryptionKey(db, options),
      rotateEncryptionKey(db, { ...options, newKey: thirdKey }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await snapshot()).audit).toHaveLength(1);
  });
  it("walks more than one batch in every category without skipping or repeating records", async () => {
    await db.transaction(async (tx) => {
      for (let i = 2; i <= 103; i++) {
        const id = `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
        await tx.query(
          "INSERT INTO users(id,email,name,password_hash,role,mfa_secret)VALUES($1,$2,'Batch','unused','member',$3)",
          [id, `batch${i}@example.test`, encrypt(secret, oldKey, `mfa:${id}`)],
        );
        await tx.query(
          "INSERT INTO projects(id,owner_id,name,template,runtime_key)VALUES($1,$1,'Batch','node',$2)",
          [id, encrypt("gateway-signing-key", oldKey, id)],
        );
        for (const name of ["FIRST_KEY", "SECOND_KEY"])
          await tx.query("INSERT INTO secrets(project_id,name,ciphertext)VALUES($1,$2,$3)", [
            id,
            name,
            encrypt("provider-private-" + name, oldKey, `${id}:${name}`),
          ]);
      }
    });
    const result = await rotateEncryptionKey(db, options);
    expect(result.counts).toEqual({
      secrets: 206,
      runtimeKeys: 103,
      databaseKeys: 1,
      mfaSeeds: 103,
      pendingMfaSeeds: 1,
    });
    const verified = await rotateEncryptionKey(db, {
      ...options,
      oldKey: newKey,
      newKey: thirdKey,
      apply: false,
    });
    expect(verified.counts).toEqual(result.counts);
  });
  it("rejects stale API/worker keys and allows MFA login after restarting with the new key", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: "memory://",
      ENCRYPTION_KEY: oldKey,
      APP_ORIGIN: "http://localhost",
    });
    const stale = await createApp(config, db, false);
    try {
      await rotateEncryptionKey(db, options);
      expect((await stale.inject({ url: "/readyz" })).statusCode).toBe(503);
      expect((await stale.inject({ url: "/api/session" })).statusCode).toBe(503);
      expect((await stale.inject({ url: "/healthz" })).statusCode).toBe(200);
      await expect(createApp(config, db, false)).rejects.toThrow("no coincide");
      const cluster = { ensure: vi.fn() } as unknown as Kubernetes;
      await expect(reconcileOne(db, config, cluster)).rejects.toThrow("no coincide");
      expect(cluster.ensure).not.toHaveBeenCalled();
      const fresh = await createApp({ ...config, ENCRYPTION_KEY: newKey }, db, false);
      try {
        expect((await fresh.inject({ url: "/readyz" })).statusCode).toBe(200);
        const response = await fresh.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: "http://localhost" },
          payload: {
            email: "rotation@example.test",
            password,
            code: authenticator(secret).generate(),
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.cookies).toHaveLength(1);
      } finally {
        await fresh.close();
      }
    } finally {
      await stale.close();
    }
  });
});

it("fences a queued old-key transaction before its mutation executes", async () => {
  await initializeEncryptionKey(db, oldKey);
  const stale = withEncryptionFence(db, oldKey),
    mutation = vi.fn(async () => undefined);
  await rotateEncryptionKey(db, options);
  await expect(stale.transaction(mutation)).rejects.toThrow("no coincide");
  expect(mutation).not.toHaveBeenCalled();
});
it("waits for a fenced in-flight write and includes it in the rotation", async () => {
  await initializeEncryptionKey(db, oldKey);
  const fenced = withEncryptionFence(db, oldKey);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const writing = fenced.transaction(async (tx) => {
    entered();
    await gate;
    await tx.query("UPDATE secrets SET ciphertext=$1 WHERE project_id=$2 AND name='FIRST_KEY'", [
      encrypt("concurrent-value", oldKey, `${project}:FIRST_KEY`),
      project,
    ]);
  });
  await started;
  if (db.kind === "postgresql") {
    // NOWAIT proves the first transaction actually retains a row-share table lock;
    // a plain SELECT would permit this EXCLUSIVE probe and leave a stale-write race.
    // PGlite serializes transactions on one connection, so only pg can test this.
    try {
      await expect(
        db.transaction((tx) => tx.query("LOCK TABLE encryption_state IN EXCLUSIVE MODE NOWAIT")),
      ).rejects.toMatchObject({ code: "55P03" });
    } catch (error) {
      release();
      await writing;
      throw error;
    }
  }
  const rotating = rotateEncryptionKey(db, options);
  release();
  await writing;
  await rotating;
  const row = (
    await db.query("SELECT ciphertext FROM secrets WHERE project_id=$1 AND name='FIRST_KEY'", [
      project,
    ])
  ).rows[0];
  expect(decrypt(row.ciphertext, newKey, `${project}:FIRST_KEY`)).toBe("concurrent-value");
});
