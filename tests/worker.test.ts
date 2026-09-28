import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { reconcileOne } from "../src/server/worker";
import { encrypt } from "../src/server/security";
import type { Kubernetes } from "../src/server/kubernetes";
const config = loadConfig({
  NODE_ENV: "test",
  DATA_DIR: "memory://",
  ENCRYPTION_KEY: "ab".repeat(32),
});
let db: Database;
const user = randomUUID();
beforeAll(async () => {
  db = await createDatabase(config);
  await migrate(db);
  await db.query(
    "INSERT INTO users(id,name,email,password_hash,role)VALUES($1,'Test','test@example.com','unused','owner')",
    [user],
  );
});
afterAll(async () => await db.close());
async function seed() {
  const id = randomUUID();
  await db.query(
    "INSERT INTO projects(id,owner_id,name,template,desired,status,runtime_key,revision)VALUES($1,$2,'Test','react','running','starting',$3,1)",
    [id, user, encrypt("private-key", config.ENCRYPTION_KEY!, id)],
  );
  await db.query(
    "INSERT INTO project_files(project_id,path,content) VALUES($1,'index.js','console.log(1)')",
    [id],
  );
  return id;
}
const driver = () =>
  ({
    ensure: vi.fn(async () => "running"),
    stop: vi.fn(async () => "stopped"),
    remove: vi.fn(async () => true),
  }) as unknown as Kubernetes;
describe("durable reconciler with an explicitly mocked cluster driver", () => {
  it("dequeues intent, passes project files and records observed running state", async () => {
    const id = await seed();
    const cluster = driver();
    expect(await reconcileOne(db, config, cluster)).toBe(true);
    expect(cluster.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ id }),
      { "index.js": "console.log(1)" },
      {},
      "private-key",
    );
    const {
      rows: [p],
    } = await db.query("SELECT * FROM projects WHERE id=$1", [id]);
    expect(p.status).toBe("running");
    expect(p.provisioned).toBe(true);
    expect(p.reconciled_revision).toBe(1);
    await db.query("DELETE FROM projects WHERE id=$1", [id]);
  });
  it("preserves resource intent on partial provisioning failure for later cleanup", async () => {
    const id = await seed();
    const cluster = driver();
    vi.mocked(cluster.ensure).mockRejectedValue(new Error("Cluster is unavailable"));
    await reconcileOne(db, config, cluster);
    const {
      rows: [p],
    } = await db.query("SELECT * FROM projects WHERE id=$1", [id]);
    expect(p.status).toBe("error");
    expect(p.error).toBe("Cluster is unavailable");
    expect(p.provisioned).toBe(true);
    expect(new Date(p.lease_until).getTime()).toBeGreaterThan(Date.now());
    await db.query("DELETE FROM projects WHERE id=$1", [id]);
  });
  it("does not erase metadata until namespace deletion has completed", async () => {
    const id = await seed();
    await db.query("UPDATE projects SET desired='deleted',status='deleting' WHERE id=$1", [id]);
    const cluster = driver();
    vi.mocked(cluster.remove).mockResolvedValueOnce(false);
    await reconcileOne(db, config, cluster);
    expect((await db.query("SELECT * FROM projects WHERE id=$1", [id])).rows).toHaveLength(1);
    await db.query("UPDATE projects SET lease_until=NULL WHERE id=$1", [id]);
    await reconcileOne(db, config, cluster);
    expect((await db.query("SELECT * FROM projects WHERE id=$1", [id])).rows).toHaveLength(0);
  });
  it("rejects stale observations when a stop arrives during provisioning", async () => {
    const id = await seed();
    const cluster = driver();
    vi.mocked(cluster.ensure).mockImplementation(async () => {
      await db.query(
        "UPDATE projects SET desired='stopped',status='stopping',revision=2 WHERE id=$1",
        [id],
      );
      return "running";
    });
    await reconcileOne(db, config, cluster);
    const {
      rows: [p],
    } = await db.query("SELECT * FROM projects WHERE id=$1", [id]);
    expect(p.desired).toBe("stopped");
    expect(p.status).toBe("stopping");
    expect(p.lease_until).toBe(null);
    await reconcileOne(db, config, cluster);
    expect(cluster.stop).toHaveBeenCalledWith(id);
    expect((await db.query("SELECT status FROM projects WHERE id=$1", [id])).rows[0].status).toBe(
      "stopped",
    );
  });
});
