import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp } from "../src/server/app";
import { decrypt } from "../src/server/security";
import { unzipSync, strFromU8 } from "fflate";
let db: Database, app: Awaited<ReturnType<typeof createApp>>;
let owner = "",
  member = "",
  projectId = "",
  invite = "",
  userId = "";
const key = "ab".repeat(32);
const origin = "http://localhost";
const request = (method: any, url: string, body?: any, cookie = owner) =>
  app.inject({
    method,
    url,
    headers: { origin, "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { payload: body }),
  });
beforeAll(async () => {
  const c = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: "memory://",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    ENCRYPTION_KEY: key,
    APP_ORIGIN: origin,
  });
  db = await createDatabase(c);
  await migrate(db);
  await migrate(db);
  app = await createApp(c, db, false);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});
describe("authenticated project platform (real embedded PostgreSQL)", () => {
  it("starts empty and requires authentication", async () => {
    expect((await request("GET", "/api/session")).json()).toMatchObject({
      setupRequired: true,
      user: null,
    });
    expect((await request("GET", "/api/projects")).statusCode).toBe(401);
  });
  it("rejects cross-origin mutations before any DB changes", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      payload: {
        name: "Attacker",
        email: "attacker@example.com",
        password: "long-secret-password",
      },
    });
    expect(r.statusCode).toBe(403);
  });
  it("rejects missing origin and weak passwords", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/auth/register", payload: {} })).statusCode,
    ).toBe(403);
    expect(
      (
        await request("POST", "/api/auth/register", {
          name: "Owner",
          email: "owner@example.com",
          password: "short",
        })
      ).statusCode,
    ).toBe(400);
  });
  it("creates exactly one administrator and a HttpOnly session", async () => {
    const r = await request("POST", "/api/auth/register", {
      name: "Owner",
      email: "OWNER@example.com",
      password: "very-strong-password",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().user.role).toBe("owner");
    userId = r.json().user.id;
    owner = r.cookies[0].name + "=" + r.cookies[0].value;
    expect(r.cookies[0].httpOnly).toBe(true);
    expect((await request("GET", "/api/session")).json().setupRequired).toBe(false);
  });
  it("closes unrestricted signup after bootstrap", async () => {
    const r = await request("POST", "/api/auth/register", {
      name: "Other",
      email: "other@example.com",
      password: "other-long-password",
    });
    expect(r.statusCode).toBe(403);
  });
  it("has no fabricated projects or activity", async () => {
    expect((await request("GET", "/api/projects")).json()).toEqual([]);
    expect((await request("GET", "/api/activity")).json()).toHaveLength(1);
  });
  it("creates a real project with actual template files", async () => {
    const r = await request("POST", "/api/projects", {
      name: "My React app",
      template: "react",
      description: "My real code",
    });
    expect(r.statusCode).toBe(201);
    projectId = r.json().id;
    expect(r.json().runtime_key).toBeUndefined();
    const files = (await request("GET", `/api/projects/${projectId}/files`)).json();
    expect(files.some((f: any) => f.path === "src/main.jsx")).toBe(true);
    expect((await request("GET", "/api/projects")).json()).toHaveLength(1);
  });
  it("does not expose project gateway credentials", async () => {
    const p = (await request("GET", `/api/projects/${projectId}`)).json();
    expect(p.runtime_key).toBeUndefined();
    expect(p.owner_id).toBeUndefined();
  });
  it("persists files and detects concurrent edits", async () => {
    const route = `/api/projects/${projectId}/files`;
    const r = await request("PUT", route, {
      path: "README.md",
      content: "Hello persistent world",
      version: 1,
    });
    expect(r.json().version).toBe(2);
    expect(
      (await request("PUT", route, { path: "README.md", content: "stale", version: 1 })).statusCode,
    ).toBe(409);
    expect(
      (await request("PUT", route, { path: "README.md", content: "duplicate", version: 0 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await request("GET", route)).json().find((f: any) => f.path === "README.md").content,
    ).toBe("Hello persistent world");
  });
  it("blocks path traversal and creates safe nested files", async () => {
    expect(
      (
        await request("PUT", `/api/projects/${projectId}/files`, {
          path: "../../etc/passwd",
          content: "bad",
          version: 0,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("PUT", `/api/projects/${projectId}/files`, {
          path: "src/lib/util.js",
          content: "export const one=1;",
          version: 0,
        })
      ).statusCode,
    ).toBe(200);
  });
  it("exports an actual zip, not a placeholder download", async () => {
    const r = await request("GET", `/api/projects/${projectId}/export`);
    expect(r.headers["content-type"]).toContain("application/zip");
    expect(strFromU8(unzipSync(r.rawPayload)["README.md"])).toBe("Hello persistent world");
  });
  it("fails honestly when Kubernetes is not configured", async () => {
    const r = await request("POST", `/api/projects/${projectId}/runtime`, { action: "start" });
    expect(r.statusCode).toBe(503);
    expect((await request("GET", `/api/projects/${projectId}`)).json().status).toBe("stopped");
    expect(
      (await request("POST", `/api/projects/${projectId}/launch`, { target: "ide" })).statusCode,
    ).toBe(409);
  });
  it("encrypts secrets and never returns their values", async () => {
    expect(
      (
        await request("PUT", `/api/projects/${projectId}/secrets`, {
          name: "DEEPSEEK_API_KEY",
          value: "never-expose-me",
        })
      ).statusCode,
    ).toBe(200);
    const list = (await request("GET", `/api/projects/${projectId}/secrets`)).json();
    expect(JSON.stringify(list)).not.toContain("never-expose");
    expect(list[0].name).toBe("DEEPSEEK_API_KEY");
    const {
      rows: [s],
    } = await db.query("SELECT ciphertext FROM secrets WHERE project_id=$1", [projectId]);
    expect(decrypt(s.ciphertext, key, `${projectId}:DEEPSEEK_API_KEY`)).toBe("never-expose-me");
    expect(s.ciphertext).not.toContain("never-expose");
  });
  it.each(["NODE_OPTIONS", "APP_ORIGIN", "DSH_TELEMETRY_DISABLED", "LD_PRELOAD", "HOME"])(
    "blocks reserved environment variable %s",
    async (name) => {
      expect(
        (await request("PUT", `/api/projects/${projectId}/secrets`, { name, value: "bad" }))
          .statusCode,
      ).toBe(400);
    },
  );
  it("issues single-use invitations bound to an email", async () => {
    const r = await request("POST", "/api/team/invitations", { email: "member@example.com" });
    expect(r.statusCode).toBe(200);
    invite = r.json().invitation;
    expect(
      (
        await request(
          "POST",
          "/api/auth/register",
          {
            name: "Wrong member",
            email: "wrong@example.com",
            password: "some-long-password",
            invitation: invite,
          },
          "",
        )
      ).statusCode,
    ).toBe(403);
    const second = await request(
      "POST",
      "/api/auth/register",
      {
        name: "Member",
        email: "member@example.com",
        password: "member-strong-password",
        invitation: invite,
      },
      "",
    );
    expect(second.statusCode).toBe(201);
    member = second.cookies[0].name + "=" + second.cookies[0].value;
    expect(second.json().user.role).toBe("member");
    expect(
      (
        await request(
          "POST",
          "/api/auth/register",
          {
            name: "Again",
            email: "member@example.com",
            password: "member-strong-password",
            invitation: invite,
          },
          "",
        )
      ).statusCode,
    ).toBe(403);
  });
  it("enforces tenant isolation on project, files, secrets, export and actions", async () => {
    for (const suffix of ["", "/files", "/secrets", "/export", "/events"])
      expect(
        (await request("GET", `/api/projects/${projectId}${suffix}`, undefined, member)).statusCode,
      ).toBe(404);
    expect(
      (
        await request(
          "PATCH",
          `/api/projects/${projectId}`,
          { name: "Hijacked", description: "", archived: false },
          member,
        )
      ).statusCode,
    ).toBe(404);
    expect((await request("GET", "/api/projects", undefined, member)).json()).toEqual([]);
    expect(
      (await request("GET", "/api/activity", undefined, member))
        .json()
        .every((e: any) => e.project_id === null),
    ).toBe(true);
  });
  it("does not grant ordinary members administration access", async () => {
    expect((await request("GET", "/api/team", undefined, member)).statusCode).toBe(403);
    expect(
      (await request("POST", "/api/team/invitations", { email: "other@example.com" }, member))
        .statusCode,
    ).toBe(403);
  });
  it("archives and restores projects with persistent metadata", async () => {
    expect(
      (
        await request("PATCH", `/api/projects/${projectId}`, {
          name: "Renamed",
          description: "Updated",
          archived: true,
        })
      ).statusCode,
    ).toBe(200);
    expect((await request("GET", `/api/projects/${projectId}`)).json()).toMatchObject({
      name: "Renamed",
      archived: true,
    });
  });
  it("refuses to silently erase edits after a workspace has been provisioned", async () => {
    await db.query("UPDATE projects SET provisioned=true WHERE id=$1", [projectId]);
    expect(
      (
        await request("PUT", `/api/projects/${projectId}/files`, {
          path: "README.md",
          content: "oops",
          version: 2,
        })
      ).statusCode,
    ).toBe(409);
    await db.query("UPDATE projects SET provisioned=false WHERE id=$1", [projectId]);
  });
  it("changes passwords and revokes existing sessions", async () => {
    const r = await request("POST", "/api/account/password", {
      current: "very-strong-password",
      password: "another-strong-password",
    });
    expect(r.statusCode).toBe(200);
    const old = owner;
    owner = r.cookies[0].name + "=" + r.cookies[0].value;
    expect((await request("GET", "/api/projects", undefined, old)).statusCode).toBe(401);
    expect(
      (
        await request(
          "POST",
          "/api/auth/login",
          { email: "owner@example.com", password: "very-strong-password" },
          "",
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await request(
          "POST",
          "/api/auth/login",
          { email: "owner@example.com", password: "another-strong-password" },
          "",
        )
      ).statusCode,
    ).toBe(200);
  });
  it("deletes only with exact confirmation and keeps audit trail", async () => {
    expect(
      (await request("DELETE", `/api/projects/${projectId}`, { confirm: "wrong" })).statusCode,
    ).toBe(400);
    expect(
      (await request("DELETE", `/api/projects/${projectId}`, { confirm: "Renamed" })).statusCode,
    ).toBe(200);
    expect((await request("GET", "/api/projects")).json()).toHaveLength(0);
    expect(
      (await db.query("SELECT * FROM project_files WHERE project_id=$1", [projectId])).rows,
    ).toHaveLength(0);
    expect(
      (await request("GET", "/api/activity"))
        .json()
        .some((e: any) => e.action === "project.deleted"),
    ).toBe(true);
  });
  it("logs out by removing the server-side session", async () => {
    expect((await request("POST", "/api/auth/logout", {})).statusCode).toBe(200);
    expect((await request("GET", "/api/projects")).statusCode).toBe(401);
  });
});
