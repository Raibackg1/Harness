import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { createDatabase, migrate, type Database } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp } from "../src/server/app";
// Project sharing: every route is checked from the owner, an editor, a viewer and an outsider.
let db: Database, app: Awaited<ReturnType<typeof createApp>>;
const cookies: Record<string, string> = {};
let projectId = "";
const origin = "http://localhost";
const password = "sharing-test-password";
const as = (who: string, method: any, url: string, body: any = undefined) =>
  app.inject({
    method,
    url,
    headers: { origin, "content-type": "application/json", cookie: cookies[who] || "" },
    ...(body === undefined ? {} : { payload: body }),
  });
const session = (r: any) => `${r.cookies[0].name}=${r.cookies[0].value}`;
const zip = (files: Record<string, string>) =>
  Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
  ).toString("base64");
const status = async (who: string, method: any, url: string, body: any = undefined) =>
  (await as(who, method, url, body)).statusCode;
beforeAll(async () => {
  const c = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: "memory://",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    ENCRYPTION_KEY: "cd".repeat(32),
    APP_ORIGIN: origin,
  });
  db = await createDatabase(c);
  await migrate(db);
  app = await createApp(c, db, false);
  await app.ready();
  cookies.owner = session(
    await as("", "POST", "/api/auth/register", {
      name: "Owner",
      email: "owner@sharing.test",
      password,
    }),
  );
  for (const who of ["editor", "viewer", "outsider"]) {
    const email = `${who}@sharing.test`;
    const invitation = (await as("owner", "POST", "/api/team/invitations", { email })).json()
      .invitation;
    cookies[who] = session(
      await as("", "POST", "/api/auth/register", { name: who, email, password, invitation }),
    );
  }
  projectId = (
    await as("owner", "POST", "/api/projects", { name: "Compartido", template: "html" })
  ).json().id;
});
afterAll(async () => {
  await app.close();
  await db.close();
});
describe("project members", () => {
  it("lets only the owner add existing accounts, with a valid role", async () => {
    const add = (who: string, email: string, role: string) =>
      as(who, "PUT", `/api/projects/${projectId}/members`, { email, role });
    expect((await add("owner", "nobody@sharing.test", "editor")).statusCode).toBe(404);
    expect((await add("owner", "owner@sharing.test", "editor")).statusCode).toBe(400);
    expect((await add("owner", "editor@sharing.test", "admin")).statusCode).toBe(400);
    expect((await add("owner", "editor@sharing.test", "editor")).statusCode).toBe(200);
    expect((await add("owner", "viewer@sharing.test", "viewer")).statusCode).toBe(200);
    // Members cannot grant access, and outsiders cannot even see the project exists.
    expect((await add("editor", "outsider@sharing.test", "viewer")).statusCode).toBe(403);
    expect((await add("outsider", "outsider@sharing.test", "viewer")).statusCode).toBe(404);
    const members = (await as("viewer", "GET", `/api/projects/${projectId}/members`)).json();
    expect(members.map((m: any) => [m.email, m.role])).toEqual([
      ["owner@sharing.test", "owner"],
      ["editor@sharing.test", "editor"],
      ["viewer@sharing.test", "viewer"],
    ]);
    expect(await status("outsider", "GET", `/api/projects/${projectId}/members`)).toBe(404);
  });
  it("lists shared projects with the member's role, and hides them from others", async () => {
    const listed = (who: string) =>
      as(who, "GET", "/api/projects").then((r) => r.json().find((p: any) => p.id === projectId));
    expect((await listed("owner")).role).toBe("owner");
    expect((await listed("editor")).role).toBe("editor");
    expect((await listed("viewer")).role).toBe("viewer");
    expect(await listed("outsider")).toBeUndefined();
    const detail = (await as("viewer", "GET", `/api/projects/${projectId}`)).json();
    expect(detail.role).toBe("viewer");
    expect(detail.runtime_key).toBeUndefined();
    expect(detail.owner_id).toBeUndefined();
  });
  it("gives viewers read access only", async () => {
    const base = `/api/projects/${projectId}`;
    expect(await status("viewer", "GET", `${base}/files`)).toBe(200);
    expect(await status("viewer", "GET", `${base}/export`)).toBe(200);
    expect(await status("viewer", "GET", `${base}/bundle`)).toBe(200);
    expect(await status("viewer", "GET", `${base}/releases`)).toBe(200);
    const file = (await as("viewer", "GET", `${base}/files`)).json()[0];
    expect(
      await status("viewer", "PUT", `${base}/files`, {
        path: file.path,
        content: "x",
        version: file.version,
      }),
    ).toBe(403);
    expect(
      await status("viewer", "POST", `${base}/import`, { archive: zip({ "a.txt": "a" }) }),
    ).toBe(403);
    expect(await status("viewer", "POST", `${base}/releases`, { note: "v" })).toBe(403);
    expect(await status("viewer", "POST", `${base}/launch`, { target: "ide" })).toBe(403);
    expect(await status("viewer", "POST", `${base}/runtime`, { action: "start" })).toBe(403);
  });
  it("lets editors change code and releases, but not settings, secrets, runtime or members", async () => {
    const base = `/api/projects/${projectId}`;
    const file = (await as("editor", "GET", `${base}/files`)).json()[0];
    expect(
      await status("editor", "PUT", `${base}/files`, {
        path: file.path,
        content: "editado por colaborador",
        version: file.version,
      }),
    ).toBe(200);
    expect(
      (await as("owner", "GET", `${base}/files`)).json().find((f: any) => f.path === file.path)
        .content,
    ).toBe("editado por colaborador");
    expect(
      await status("editor", "POST", `${base}/import`, { archive: zip({ "nuevo.txt": "n" }) }),
    ).toBe(200);
    const release = (await as("editor", "POST", `${base}/releases`, { note: "del editor" })).json();
    expect(release.id).toBeGreaterThan(0);
    expect(
      await status("editor", "POST", `${base}/releases/${release.id}/rollback`, { force: true }),
    ).toBe(200);
    // Launch passes authorization and stops at readiness: no cluster in this test.
    expect(await status("editor", "POST", `${base}/launch`, { target: "ide" })).toBe(409);
    expect(await status("editor", "POST", `${base}/runtime`, { action: "start" })).toBe(403);
    expect(
      await status("editor", "PATCH", base, {
        name: "Renombrado",
        description: "",
        archived: false,
      }),
    ).toBe(403);
    expect(await status("editor", "GET", `${base}/secrets`)).toBe(403);
    expect(await status("editor", "PUT", `${base}/secrets`, { name: "MY_TOKEN", value: "y" })).toBe(
      403,
    );
    expect(await status("editor", "DELETE", base, { confirm: "Compartido" })).toBe(403);
  });
  it("returns 404 to outsiders on every project route", async () => {
    const base = `/api/projects/${projectId}`;
    for (const [method, url, body] of [
      ["GET", base],
      ["GET", `${base}/files`],
      ["GET", `${base}/export`],
      ["GET", `${base}/bundle`],
      ["GET", `${base}/releases`],
      ["GET", `${base}/events`],
      ["PUT", `${base}/files`, { path: "index.html", content: "x", version: 1 }],
      ["POST", `${base}/launch`, { target: "ide" }],
      ["POST", `${base}/runtime`, { action: "start" }],
    ] as const)
      expect(await status("outsider", method, url, body)).toBe(404);
  });
  it("revokes access when the owner removes a member, and only the owner can", async () => {
    const members = (await as("owner", "GET", `/api/projects/${projectId}/members`)).json();
    const viewer = members.find((m: any) => m.role === "viewer");
    expect(
      await status("editor", "DELETE", `/api/projects/${projectId}/members/${viewer.id}`, {}),
    ).toBe(403);
    expect(
      await status("owner", "DELETE", `/api/projects/${projectId}/members/${viewer.id}`, {}),
    ).toBe(200);
    expect(await status("viewer", "GET", `/api/projects/${projectId}`)).toBe(404);
    expect(
      (await as("viewer", "GET", "/api/projects")).json().some((p: any) => p.id === projectId),
    ).toBe(false);
  });
  it("records sharing changes in the owner's activity", async () => {
    const actions = (await as("owner", "GET", "/api/activity")).json().map((a: any) => a.action);
    expect(actions).toContain("project.member_added");
    expect(actions).toContain("project.member_removed");
  });
});
