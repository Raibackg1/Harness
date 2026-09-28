import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate, type Database } from "../src/server/db";
import { encrypt, decrypt } from "../src/server/security";
import { initializeEncryptionKey } from "../src/server/encryption-maintenance";
it("runs the actual CLI: validates by default, requires offline confirmation, applies and never prints keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-rotation-cli-")),
    oldKey = "ab".repeat(32),
    newKey = "cd".repeat(32),
    id = "10000000-0000-4000-8000-000000000001";
  const config = { DATA_DIR: join(dir, "postgres") };
  let db: Database | undefined;
  async function run(args: string[] = []) {
    return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/server/rotate-key.ts",
          "--old-key-file",
          join(dir, "old"),
          "--new-key-file",
          join(dir, "new"),
          "--operator",
          "cli/test",
          ...args,
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            DATABASE_URL: "",
            DATA_DIR: config.DATA_DIR,
            KUBERNETES_ENABLED: "false",
          },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15000,
        },
      );
      let output = "";
      child.stdout.on("data", (c) => (output += c));
      child.stderr.on("data", (c) => (output += c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
  }
  try {
    await writeFile(join(dir, "old"), oldKey + "\n", { mode: 0o600 });
    await writeFile(join(dir, "new"), newKey + "\n", { mode: 0o600 });
    db = await createDatabase(config);
    await migrate(db);
    await db.query(
      "INSERT INTO users(id,email,name,password_hash,role,mfa_pending,mfa_pending_until)VALUES($1,'cli@example.test','CLI','unchanged','owner',$2,now()+interval '10 minutes')",
      [id, encrypt("sensitive-pending-seed", oldKey, `mfa:${id}`)],
    );
    await initializeEncryptionKey(db, oldKey);
    await db.close();
    db = undefined;
    const dry = await run();
    expect(dry.code, dry.output).toBe(0);
    expect(JSON.parse(dry.output)).toMatchObject({ dryRun: true, counts: { pendingMfaSeeds: 1 } });
    const refused = await run(["--apply"]);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("--offline");
    db = await createDatabase(config);
    await initializeEncryptionKey(db, oldKey);
    expect((await db.query("SELECT * FROM audit_events")).rows).toHaveLength(0);
    await db.close();
    db = undefined;
    const applied = await run(["--apply", "--offline"]);
    expect(applied.code, applied.output).toBe(0);
    expect(JSON.parse(applied.output)).toMatchObject({
      dryRun: false,
      counts: { pendingMfaSeeds: 1 },
    });
    for (const output of [dry.output, refused.output, applied.output])
      for (const sensitive of [oldKey, newKey, "sensitive-pending-seed"])
        expect(output).not.toContain(sensitive);
    db = await createDatabase(config);
    await expect(initializeEncryptionKey(db, oldKey)).rejects.toThrow("no coincide");
    await initializeEncryptionKey(db, newKey);
    expect(
      decrypt(
        (await db.query("SELECT mfa_pending FROM users WHERE id=$1", [id])).rows[0].mfa_pending,
        newKey,
        `mfa:${id}`,
      ),
    ).toBe("sensitive-pending-seed");
    expect((await db.query("SELECT * FROM audit_events")).rows).toHaveLength(1);
  } finally {
    await db?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
