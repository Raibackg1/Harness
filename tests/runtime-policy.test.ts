import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { changeRuntime, expireRuntimes, capacityReport } from "../src/server/runtime-policy";
import { listReleases } from "../src/server/releases";
import { startWorker } from "../src/server/worker";
import type { Kubernetes } from "../src/server/kubernetes";
let db: Database;
const u1 = randomUUID(),
  u2 = randomUUID();
const c = loadConfig({
  NODE_ENV: "test",
  DATA_DIR: "memory://",
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  ENCRYPTION_KEY: "ab".repeat(32),
  MAX_RUNNING_PER_USER: "1",
  MAX_RUNNING_TOTAL: "2",
  MAX_RUNTIME_MINUTES: "60",
});
beforeAll(async () => {
  db = await createDatabase(c);
  await migrate(db);
  for (const u of [u1, u2])
    await db.query(
      "INSERT INTO users(id,name,email,password_hash,role)VALUES($1,'Test',$2,'unused','member')",
      [u, `${u}@test.example`],
    );
});
beforeEach(async () => {
  await db.query("DELETE FROM projects");
  await db.query("DELETE FROM worker_health");
  await db.query("UPDATE users SET suspended_at=NULL");
});
afterAll(async () => await db.close());
async function project(owner = u1) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO projects(id,owner_id,name,template,reconciled_revision)VALUES($1,$2,'Test','node',0)",
    [id, owner],
  );
  return id;
}
describe("durable capacity and bounded execution sessions", () => {
  it("serializes racing starts so one account cannot overbook its quota", async () => {
    const ids = await Promise.all([project(), project()]);
    const results = await Promise.allSettled(
      ids.map((id) => changeRuntime(db, c, u1, id, "start")),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await capacityReport(db, c)).usage.reserved).toBe(1);
  });
  it("enforces the global limit across accounts and counts stopping/error environments", async () => {
    const a = await project(),
      b = await project(u2),
      d = await project(u2);
    await changeRuntime(db, c, u1, a, "start");
    await changeRuntime(db, c, u2, b, "start");
    const roomy = { ...c, MAX_RUNNING_PER_USER: 5 };
    await expect(changeRuntime(db, roomy, u2, d, "start")).rejects.toThrow("global");
    await changeRuntime(db, c, u1, a, "stop");
    await expect(changeRuntime(db, roomy, u2, d, "start")).rejects.toThrow("global");
    await db.query("UPDATE projects SET status='error',provisioned=true WHERE id=$1", [a]);
    await expect(changeRuntime(db, roomy, u2, d, "start")).rejects.toThrow("global");
    await db.query("UPDATE projects SET status='stopped' WHERE id=$1", [a]);
    await expect(changeRuntime(db, roomy, u2, d, "start")).resolves.toBeUndefined();
  });
  it("sets a deadline and does not renew it on restart, publish or repeated start", async () => {
    const id = await project();
    await changeRuntime(db, c, u1, id, "start");
    const deadline = (await db.query("SELECT runtime_expires_at FROM projects WHERE id=$1", [id]))
      .rows[0].runtime_expires_at;
    for (const action of ["restart", "publish", "unpublish", "start"] as const)
      await changeRuntime(db, c, u1, id, action);
    expect(
      (await db.query("SELECT runtime_expires_at FROM projects WHERE id=$1", [id])).rows[0]
        .runtime_expires_at,
    ).toEqual(deadline);
  });
  it("expires active and legacy sessions atomically and audits once", async () => {
    const id = await project();
    await changeRuntime(db, c, u1, id, "start");
    await db.query(
      "UPDATE projects SET runtime_expires_at=now()-interval '1 second',published=true WHERE id=$1",
      [id],
    );
    expect(await expireRuntimes(db)).toBe(1);
    expect(await expireRuntimes(db)).toBe(0);
    expect(
      (await db.query("SELECT desired,status,published FROM projects WHERE id=$1", [id])).rows[0],
    ).toEqual({ desired: "stopped", status: "stopping", published: false });
    expect(
      (
        await db.query(
          "SELECT * FROM audit_events WHERE project_id=$1 AND action='runtime.expired'",
          [id],
        )
      ).rows,
    ).toHaveLength(1);
    await expect(changeRuntime(db, c, u1, id, "start")).rejects.toThrow("detención");
  });
  it("refuses to renew an expired running session and rejects other tenants/suspended users", async () => {
    const id = await project();
    await expect(changeRuntime(db, c, u2, id, "start")).rejects.toThrow("encontrado");
    await changeRuntime(db, c, u1, id, "start");
    await db.query("UPDATE projects SET runtime_expires_at=now()-interval '1 second' WHERE id=$1", [
      id,
    ]);
    await expect(changeRuntime(db, c, u1, id, "restart")).rejects.toThrow("venció");
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [u1]);
    await expect(changeRuntime(db, c, u1, id, "start")).rejects.toThrow("disponible");
  });
  it("publishes actual worker progress and removes its registration on shutdown", async () => {
    const errors: unknown[] = [];
    const cluster = { stop: vi.fn(async () => "stopped") } as unknown as Kubernetes;
    const stop = startWorker(db, c, cluster, (e) => errors.push(e));
    try {
      await vi.waitFor(async () => expect((await capacityReport(db, c)).workerHealthy).toBe(true), {
        timeout: 3000,
      });
    } finally {
      await stop();
    }
    expect(errors).toEqual([]);
    expect((await capacityReport(db, c)).workerHealthy).toBe(false);
  });
  it("never treats a stale worker heartbeat as healthy", async () => {
    await db.query(
      "INSERT INTO worker_health(id,last_seen,last_success)VALUES($1,now()-interval '3 minutes',now()-interval '3 minutes')",
      [randomUUID()],
    );
    expect((await capacityReport(db, c)).workerHealthy).toBe(false);
  });
});

describe("what a publication records", () => {
  it("snapshots the seeded code once per publication and bounds the history", async () => {
    const id = await project();
    await db.query(
      "INSERT INTO project_files(project_id,path,content) VALUES ($1,'index.js','1')",
      [id],
    );
    await db.query(
      "INSERT INTO secrets(project_id,name,ciphertext) VALUES ($1,'KEY','iv.tag.data')",
      [id],
    );
    await changeRuntime(db, c, u1, id, "start");
    await changeRuntime(db, c, u1, id, "publish");
    expect(await listReleases(db, id)).toMatchObject([
      { file_count: 1, secret_names: ["KEY"], note: "Publicación de la revisión 2" },
    ]);
    for (let i = 0; i < 30; i++) await changeRuntime(db, c, u1, id, "publish");
    const kept = await listReleases(db, id);
    expect(kept).toHaveLength(20);
    expect(kept[0].note).toBe("Publicación de la revisión 32");
    // A stop is not a publication, so it never invents a restore point.
    await changeRuntime(db, c, u1, id, "stop");
    expect(await listReleases(db, id)).toHaveLength(20);
  });
});
