import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.js";
export interface Sql {
  query<T extends Record<string, any> = Record<string, any>>(
    text: string,
    params?: any[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}
export interface Database extends Sql {
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: "postgresql" | "embedded-postgresql";
}
export async function createDatabase(
  config: Pick<Config, "DATABASE_URL" | "DATA_DIR">,
): Promise<Database> {
  if (config.DATABASE_URL) {
    const pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    });
    return {
      kind: "postgresql",
      query: <T extends Record<string, any>>(t: string, p?: any[]) => pool.query<T>(t, p),
      close: () => pool.end(),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
    };
  }
  if (!config.DATA_DIR.includes("://")) await mkdir(dirname(config.DATA_DIR), { recursive: true });
  const pglite = new PGlite(config.DATA_DIR);
  await pglite.waitReady;
  return {
    kind: "embedded-postgresql",
    query: async (t, p) => pglite.query(t, p),
    transaction: (fn) => pglite.transaction((tx) => fn({ query: async (t, p) => tx.query(t, p) })),
    close: () => pglite.close(),
  };
}
export async function migrate(db: Database) {
  // Serialized using the migration row, safe for multiple API replicas.
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, version integer NOT NULL)",
  );
  await db.query("INSERT INTO schema_migrations (id,version) VALUES (1,0) ON CONFLICT DO NOTHING");
  await db.transaction(async (tx) => {
    const {
      rows: [row],
    } = await tx.query("SELECT version FROM schema_migrations WHERE id=1 FOR UPDATE");
    if (row.version < 1) {
      for (const sql of schema.split("-- statement").filter((s) => s.trim())) await tx.query(sql);
      await tx.query("UPDATE schema_migrations SET version=1 WHERE id=1");
    }
    if (row.version < 2) {
      for (const sql of securitySchema.split("-- statement").filter((s) => s.trim()))
        await tx.query(sql);
      await tx.query("UPDATE schema_migrations SET version=2 WHERE id=1");
    }
    if (row.version < 3) {
      await tx.query(
        "CREATE TABLE encryption_state(id integer PRIMARY KEY CHECK(id=1),key_fingerprint text,updated_at timestamptz NOT NULL DEFAULT now())",
      );
      await tx.query("INSERT INTO encryption_state(id) VALUES(1)");
      await tx.query("UPDATE schema_migrations SET version=3 WHERE id=1");
    }
    if (row.version < 4) {
      // Release history of the versioned initial files, captured when a project is
      // published. Secret VALUES are never copied here: only the names that existed.
      await tx.query(
        "CREATE TABLE project_releases (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, note text NOT NULL DEFAULT '', files jsonb NOT NULL, secret_names jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now())",
      );
      await tx.query("CREATE INDEX releases_project ON project_releases(project_id,id DESC)");
      await tx.query("UPDATE schema_migrations SET version=4 WHERE id=1");
    }
  });
}
const schema = `
CREATE TABLE users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, password_hash text NOT NULL, role text NOT NULL CHECK (role IN ('owner','member')), created_at timestamptz NOT NULL DEFAULT now());
-- statement
CREATE TABLE sessions (id_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
-- statement
CREATE INDEX sessions_expiry ON sessions(expires_at);
-- statement
CREATE TABLE invitations (id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL, email text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, used_at timestamptz);
-- statement
CREATE TABLE projects (id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, description text NOT NULL DEFAULT '', template text NOT NULL, desired text NOT NULL DEFAULT 'stopped' CHECK (desired IN ('running','stopped','deleted')), status text NOT NULL DEFAULT 'stopped', error text, archived boolean NOT NULL DEFAULT false, provisioned boolean NOT NULL DEFAULT false, published boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 0, reconciled_revision integer NOT NULL DEFAULT -1, runtime_key text, lease_until timestamptz, lease_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
-- statement
CREATE INDEX projects_owner ON projects(owner_id,created_at DESC);
-- statement
CREATE TABLE project_files (project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, path text NOT NULL, content text NOT NULL, version integer NOT NULL DEFAULT 1, PRIMARY KEY(project_id,path));
-- statement
CREATE TABLE secrets (project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name text NOT NULL, ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,name));
-- statement
CREATE TABLE audit_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid REFERENCES users(id), project_id uuid, action text NOT NULL, detail text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
-- statement
CREATE INDEX audit_user_time ON audit_events(user_id,created_at DESC);
-- statement
CREATE TABLE auth_attempts (key text PRIMARY KEY, count integer NOT NULL DEFAULT 1, reset_at timestamptz NOT NULL);
`;

const securitySchema = `
ALTER TABLE users ADD COLUMN suspended_at timestamptz, ADD COLUMN mfa_secret text, ADD COLUMN mfa_pending text, ADD COLUMN mfa_pending_until timestamptz, ADD COLUMN mfa_counter bigint NOT NULL DEFAULT -1;
-- statement
ALTER TABLE users ADD COLUMN mfa_enabled boolean GENERATED ALWAYS AS (mfa_secret IS NOT NULL) STORED;
-- statement
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(), ADD COLUMN client text NOT NULL DEFAULT 'Cliente anterior';
-- statement
CREATE UNIQUE INDEX sessions_public_id ON sessions(id);
-- statement
CREATE TABLE recovery_codes (user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash text NOT NULL, PRIMARY KEY(user_id,code_hash));
-- statement
ALTER TABLE projects ADD COLUMN runtime_expires_at timestamptz;
-- statement
CREATE TABLE runtime_capacity (id integer PRIMARY KEY CHECK(id=1));
-- statement
INSERT INTO runtime_capacity(id) VALUES(1);
-- statement
CREATE TABLE worker_health (id uuid PRIMARY KEY, last_seen timestamptz NOT NULL DEFAULT now(), last_success timestamptz, error text);
`;
