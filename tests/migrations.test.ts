import { it, expect } from "vitest";
import { createDatabase, migrate } from "../src/server/db";
it("upgrades existing v1 accounts, session tokens and projects without erasing data", async () => {
  const db = await createDatabase({ DATA_DIR: "memory://" });
  try {
    // Minimal v1 fixture: the old columns touched by v2; no new authentication schema.
    await db.query(
      "CREATE TABLE schema_migrations(id integer PRIMARY KEY,version integer NOT NULL)",
    );
    await db.query("INSERT INTO schema_migrations VALUES(1,1)");
    await db.query("CREATE TABLE users(id uuid PRIMARY KEY,email text,password_hash text)");
    await db.query("CREATE TABLE sessions(id_hash text PRIMARY KEY,user_id uuid)");
    await db.query("CREATE TABLE projects(id uuid PRIMARY KEY,name text)");
    const id = "10000000-0000-4000-8000-000000000001";
    await db.query("INSERT INTO users VALUES($1,'existing@example.com','existing-password-hash')", [
      id,
    ]);
    await db.query("INSERT INTO sessions VALUES('existing-token-hash',$1)", [id]);
    await db.query("INSERT INTO projects VALUES($1,'Existing project')", [id]);
    await migrate(db);
    await migrate(db);
    expect((await db.query("SELECT * FROM users")).rows[0]).toMatchObject({
      password_hash: "existing-password-hash",
      mfa_enabled: false,
      suspended_at: null,
    });
    expect((await db.query("SELECT * FROM sessions")).rows[0]).toMatchObject({
      id_hash: "existing-token-hash",
      client: "Cliente anterior",
    });
    expect((await db.query("SELECT * FROM sessions")).rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await db.query("SELECT * FROM projects")).rows[0]).toMatchObject({
      name: "Existing project",
      runtime_expires_at: null,
    });
    expect((await db.query("SELECT version FROM schema_migrations")).rows[0].version).toBe(4);
    // v4 adds release history; it must arrive empty and cascade with the project.
    const releases = await db.query("SELECT count(*)::int AS n FROM project_releases");
    expect(releases.rows[0].n).toBe(0);
    await db.query("INSERT INTO project_releases(project_id,note,files) VALUES ($1,'legacy',$2)", [
      id,
      '{"a.txt":"1"}',
    ]);
    await db.query("DELETE FROM projects WHERE id=$1", [id]);
    expect((await db.query("SELECT count(*)::int AS n FROM project_releases")).rows[0].n).toBe(0);
  } finally {
    await db.close();
  }
});
