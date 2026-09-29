import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp } from "../src/server/app";
import { decrypt } from "../src/server/security";
// Optional PostgreSQL per project: the control-plane side (flag, credential, authorization).
const key = "ef".repeat(32);
const origin = "http://localhost";
const password = "database-test-password";
let db: Database;
const apps: Record<string, Awaited<ReturnType<typeof createApp>>> = {};
const cookies: Record<string, string> = {};
let projectId = "";
const as = (app: string, who: string, method: any, url: string, body: any = undefined) =>
  apps[app].inject({
    method,
    url,
    headers: { origin, "content-type": "application/json", cookie: cookies[who] || "" },
    ...(body === undefined ? {} : { payload: body }),
  });
const session = (r: any) => `${r.cookies[0].name}=${r.cookies[0].value}`;
const row = async () =>
  (await db.query("SELECT database,database_key,revision FROM projects WHERE id=$1", [projectId]))
    .rows[0];
beforeAll(async () => {
  const base = {
    NODE_ENV: "test",
    DATA_DIR: "memory://",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    ENCRYPTION_KEY: key,
    APP_ORIGIN: origin,
  };
  db = await createDatabase(loadConfig(base));
  await migrate(db);
  apps.plain = await createApp(loadConfig(base), db, false);
  apps.withImage = await createApp(
    loadConfig({ ...base, DATABASE_IMAGE: "postgres@sha256:" + "12".repeat(32) }),
    db,
    false,
  );
  cookies.owner = session(
    await as("plain", "", "POST", "/api/auth/register", {
      name: "Owner",
      email: "owner@database.test",
      password,
    }),
  );
  const invitation = (
    await as("plain", "owner", "POST", "/api/team/invitations", { email: "editor@database.test" })
  ).json().invitation;
  cookies.editor = session(
    await as("plain", "", "POST", "/api/auth/register", {
      name: "Editor",
      email: "editor@database.test",
      password,
      invitation,
    }),
  );
  projectId = (
    await as("plain", "owner", "POST", "/api/projects", { name: "Con base", template: "node" })
  ).json().id;
  await as("plain", "owner", "PUT", `/api/projects/${projectId}/members`, {
    email: "editor@database.test",
    role: "editor",
  });
});
afterAll(async () => {
  for (const app of Object.values(apps)) await app.close();
  await db.close();
});
describe("project database", () => {
  it("refuses to enable a database when the operator configured no image", async () => {
    const r = await as("plain", "owner", "PUT", `/api/projects/${projectId}/database`, {
      enabled: true,
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toContain("DATABASE_IMAGE");
    expect((await row()).database).toBe(false);
  });
  it("is owner-only", async () => {
    expect(
      (
        await as("withImage", "editor", "PUT", `/api/projects/${projectId}/database`, {
          enabled: true,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("enables with an encrypted credential and asks the worker to reconcile", async () => {
    const before = await row();
    const r = await as("withImage", "owner", "PUT", `/api/projects/${projectId}/database`, {
      enabled: true,
    });
    expect(r.statusCode).toBe(200);
    const after = await row();
    expect(after.database).toBe(true);
    expect(after.revision).toBe(before.revision + 1);
    expect(decrypt(after.database_key, key, `db:${projectId}`)).toMatch(/^[\w-]{20,}$/);
    const detail = (await as("withImage", "owner", "GET", `/api/projects/${projectId}`)).json();
    expect(detail.database).toBe(true);
    expect(detail.database_key).toBeUndefined();
    const listed = (await as("withImage", "owner", "GET", "/api/projects")).json()[0];
    expect(listed.database).toBe(true);
    expect(listed.database_key).toBeUndefined();
  });
  it("keeps the same credential across disable and re-enable, because the data volume stays", async () => {
    const first = (await row()).database_key;
    await as("withImage", "owner", "PUT", `/api/projects/${projectId}/database`, {
      enabled: false,
    });
    expect((await row()).database).toBe(false);
    expect((await row()).database_key).toBe(first);
    await as("withImage", "owner", "PUT", `/api/projects/${projectId}/database`, {
      enabled: true,
    });
    expect((await row()).database_key).toBe(first);
    const actions = (await as("withImage", "owner", "GET", "/api/activity")).json();
    expect(actions.map((a: any) => a.action)).toContain("project.database_enabled");
    expect(actions.map((a: any) => a.action)).toContain("project.database_disabled");
  });
});
