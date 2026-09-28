import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate } from "../src/server/db";
it("persists PostgreSQL data across database process lifecycles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-persistence-"));
  const config = { DATA_DIR: join(dir, "postgres") };
  try {
    const first = await createDatabase(config);
    await migrate(first);
    await first.query(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES('00000000-0000-4000-8000-000000000001','Persistence','p@example.com','not-an-auth-test','owner')",
    );
    await first.close();
    const second = await createDatabase(config);
    await migrate(second);
    expect(
      (await second.query("SELECT name FROM users WHERE email='p@example.com'")).rows[0].name,
    ).toBe("Persistence");
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
