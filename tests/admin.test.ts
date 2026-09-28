import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate, type Database } from "../src/server/db";
import { encrypt, passwordHash, verifyPassword } from "../src/server/security";
it("break-glass CLI preserves MFA unless explicitly reset, revokes sessions and audits recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-admin-"));
  const config = { DATA_DIR: join(dir, "postgres") };
  const id = "10000000-0000-4000-8000-000000000001",
    email = "recovery@example.test",
    key = "ab".repeat(32),
    password = "new-private-test-password";
  let db: Database | undefined;
  async function run(reset = false) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/server/admin.ts", email, ...(reset ? ["--reset-mfa"] : [])],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            DATA_DIR: config.DATA_DIR,
            DATABASE_URL: "",
            KUBERNETES_ENABLED: "false",
            ENCRYPTION_KEY: key,
          },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15000,
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          expect(code, output).toBe(0);
          expect(output).not.toContain(password);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(password);
    });
  }
  try {
    db = await createDatabase(config);
    await migrate(db);
    const sealed = encrypt("test-seed", key, `mfa:${id}`);
    await db.query(
      "INSERT INTO users(id,name,email,password_hash,role,mfa_secret,mfa_pending,mfa_pending_until,mfa_counter) VALUES($1,'Recovery',$2,$3,'owner',$4,$4,now()+interval '10 minutes',7)",
      [id, email, await passwordHash("old-private-test-password"), sealed],
    );
    await db.query(
      "INSERT INTO sessions(id_hash,user_id,expires_at)VALUES('test-session',$1,now()+interval '1 day')",
      [id],
    );
    await db.query("INSERT INTO recovery_codes(user_id,code_hash)VALUES($1,'test-backup-hash')", [
      id,
    ]);
    await db.close();
    db = undefined;
    await run();
    db = await createDatabase(config);
    const preserved = (await db.query("SELECT * FROM users WHERE id=$1", [id])).rows[0];
    expect(await verifyPassword(password, preserved.password_hash)).toBe(true);
    expect(preserved.mfa_secret).toBe(sealed);
    expect(preserved.mfa_enabled).toBe(true);
    expect((await db.query("SELECT * FROM sessions")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM recovery_codes")).rows).toHaveLength(1);
    await db.query(
      "INSERT INTO sessions(id_hash,user_id,expires_at)VALUES('another-session',$1,now()+interval '1 day')",
      [id],
    );
    await db.close();
    db = undefined;
    await run(true);
    db = await createDatabase(config);
    expect((await db.query("SELECT * FROM users WHERE id=$1", [id])).rows[0]).toMatchObject({
      mfa_secret: null,
      mfa_pending: null,
      mfa_pending_until: null,
      mfa_counter: -1,
      mfa_enabled: false,
    });
    expect((await db.query("SELECT * FROM sessions")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM recovery_codes")).rows).toHaveLength(0);
    const actions = (await db.query("SELECT action FROM audit_events")).rows.map((r) => r.action);
    expect(actions.filter((a) => a === "account.password_recovered")).toHaveLength(2);
    expect(actions.filter((a) => a === "account.mfa_recovered")).toHaveLength(1);
  } finally {
    await db?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
