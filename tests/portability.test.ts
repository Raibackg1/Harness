import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { createDatabase, migrate, type Database } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp } from "../src/server/app";
let db: Database, app: Awaited<ReturnType<typeof createApp>>;
let owner = "",
  other = "",
  projectId = "";
const origin = "http://localhost";
const password = "portability-test-password";
const call = (method: any, url: string, body: any = undefined, cookie = owner) =>
  app.inject({
    method,
    url,
    headers: { origin, "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { payload: body }),
  });
const session = (r: any) => `${r.cookies[0].name}=${r.cookies[0].value}`;
const archive = (files: Record<string, string>) => {
  const zipped = zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  );
  return Buffer.from(zipped).toString("base64");
};
const unzipped = (raw: Buffer) =>
  Object.fromEntries(
    Object.entries(unzipSync(new Uint8Array(raw))).map(([k, v]) => [k, strFromU8(v)]),
  );
beforeAll(async () => {
  const c = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: "memory://",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    ENCRYPTION_KEY: "ab".repeat(32),
    APP_ORIGIN: origin,
  });
  db = await createDatabase(c);
  await migrate(db);
  app = await createApp(c, db, false);
  await app.ready();
  owner = session(
    await call(
      "POST",
      "/api/auth/register",
      { name: "Owner", email: "owner@portability.test", password },
      "",
    ),
  );
  const invite = (
    await call("POST", "/api/team/invitations", { email: "other@portability.test" })
  ).json().invitation;
  other = session(
    await call(
      "POST",
      "/api/auth/register",
      { name: "Other", email: "other@portability.test", password, invitation: invite },
      "",
    ),
  );
});
afterAll(async () => {
  await app.close();
  await db.close();
});
describe("bring your own code, and get it back out", () => {
  it("creates a project from a ZIP instead of a template, and requires auth to export", async () => {
    const created = await call("POST", "/api/projects", {
      name: "Traido de GitHub",
      template: "node",
      archive: archive({
        "myrepo-main/package.json": '{"name":"x"}\n',
        "myrepo-main/index.js": "1\n",
      }),
    });
    expect(created.statusCode).toBe(201);
    projectId = created.json().id;
    const paths = (await call("GET", `/api/projects/${projectId}/files`))
      .json()
      .map((f: any) => f.path);
    expect(paths).toEqual(["index.js", "package.json"]);
    expect((await call("GET", `/api/projects/${projectId}/bundle`, undefined, "")).statusCode).toBe(
      401,
    );
  });
  it("exports a bundle that runs outside the platform, without secret values", async () => {
    expect(
      (
        await call("PUT", `/api/projects/${projectId}/secrets`, {
          name: "PROVIDER_KEY",
          value: "super-secret-value",
        })
      ).statusCode,
    ).toBe(200);
    const bundle = await call("GET", `/api/projects/${projectId}/bundle`);
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers["content-disposition"]).toContain("-bundle.zip");
    const files = unzipped(bundle.rawPayload);
    expect(Object.keys(files).sort()).toEqual([
      ".env.example",
      "Dockerfile",
      "docker-compose.yml",
      "harness-export.json",
      "index.js",
      "package.json",
    ]);
    expect(files["Dockerfile"]).toContain("FROM node:22-bookworm-slim");
    expect(files[".env.example"]).toContain("PROVIDER_KEY=");
    expect(JSON.stringify(files)).not.toContain("super-secret-value");
    expect(JSON.parse(files["harness-export.json"]).secretNames).toEqual(["PROVIDER_KEY"]);
  });
  it("imports a new revision, replacing or merging files", async () => {
    const merged = await call("POST", `/api/projects/${projectId}/import`, {
      archive: archive({ "README.md": "nuevo\n", "index.js": "2\n" }),
    });
    expect(merged.json().imported).toBe(2);
    const afterMerge = (await call("GET", `/api/projects/${projectId}/files`)).json();
    expect(afterMerge.map((f: any) => f.path)).toEqual(["README.md", "index.js", "package.json"]);
    expect(afterMerge.find((f: any) => f.path === "index.js").content).toBe("2\n");
    const replaced = await call("POST", `/api/projects/${projectId}/import`, {
      archive: archive({ "solo.js": "3\n" }),
      mode: "replace",
    });
    expect(replaced.json().imported).toBe(1);
    expect((await call("GET", `/api/projects/${projectId}/files`)).json()).toHaveLength(1);
    // An optimistic save from a stale editor must not silently win over an import.
    expect(
      (
        await call("PUT", `/api/projects/${projectId}/files`, {
          path: "solo.js",
          content: "stale\n",
          version: 99,
        })
      ).statusCode,
    ).toBe(409);
  });
});
describe("release history of the seeded code", () => {
  it("snapshots, lists and restores the initial files", async () => {
    expect(
      (
        await call("POST", `/api/projects/${projectId}/releases`, { note: "Antes de tocar nada" })
      ).json().id,
    ).toBeGreaterThan(0);
    const listed = await call("GET", `/api/projects/${projectId}/releases`);
    expect(listed.json()[0]).toMatchObject({
      note: "Antes de tocar nada",
      file_count: 1,
      secret_names: ["PROVIDER_KEY"],
    });
    await call("PUT", `/api/projects/${projectId}/files`, {
      path: "extra.js",
      content: "4\n",
      version: 0,
    });
    const blocked = await call("POST", `/api/projects/${projectId}/releases/1/rollback`, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("Confirma el reemplazo");
    expect(
      (await call("POST", `/api/projects/${projectId}/releases/1/rollback`, { force: true }))
        .statusCode,
    ).toBe(200);
    const restored = (await call("GET", `/api/projects/${projectId}/files`)).json();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ path: "solo.js", content: "3\n" });
  });
  it("never lets an editor opened before a restore or a replacing import overwrite it", async () => {
    const files = async () => (await call("GET", `/api/projects/${projectId}/files`)).json();
    const save = (version: number) =>
      call("PUT", `/api/projects/${projectId}/files`, {
        path: "solo.js",
        content: "stale\n",
        version,
      });
    await call("POST", `/api/projects/${projectId}/import`, {
      archive: archive({ "solo.js": "Y\n" }),
      mode: "replace",
    });
    const releaseY = (
      await call("POST", `/api/projects/${projectId}/releases`, { note: "Y" })
    ).json().id;
    await call("POST", `/api/projects/${projectId}/import`, {
      archive: archive({ "solo.js": "X\n" }),
      mode: "replace",
    });
    const staleBeforeRestore = (await files())[0];
    expect(staleBeforeRestore.content).toBe("X\n");
    expect(
      (
        await call("POST", `/api/projects/${projectId}/releases/${releaseY}/rollback`, {
          force: true,
        })
      ).statusCode,
    ).toBe(200);
    expect((await save(staleBeforeRestore.version)).statusCode).toBe(409);
    const staleBeforeImport = (await files())[0];
    expect(staleBeforeImport.content).toBe("Y\n");
    await call("POST", `/api/projects/${projectId}/import`, {
      archive: archive({ "solo.js": "Z\n" }),
      mode: "replace",
    });
    expect((await save(staleBeforeImport.version)).statusCode).toBe(409);
    expect((await files())[0].content).toBe("Z\n");
  });
  it("enforces the project-wide file limits when merging an import", async () => {
    const batch = (prefix: string, n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}.js`, "x\n"]));
    const count = async () => (await call("GET", `/api/projects/${projectId}/files`)).json().length;
    expect(
      (
        await call("POST", `/api/projects/${projectId}/import`, {
          archive: archive(batch("a", 40)),
        })
      ).statusCode,
    ).toBe(200);
    const before = await count();
    const over = await call("POST", `/api/projects/${projectId}/import`, {
      archive: archive(batch("b", 40)),
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toContain("Máximo 50 archivos iniciales");
    expect(await count()).toBe(before);
    const big = "y".repeat(90_000);
    const heavy = await call("POST", `/api/projects/${projectId}/import`, {
      archive: archive({
        "h1.txt": big,
        "h2.txt": big,
        "h3.txt": big,
        "h4.txt": big,
        "h5.txt": big,
      }),
    });
    expect(heavy.statusCode).toBe(409);
    expect(heavy.json().error).toContain("450 KB");
    expect(await count()).toBe(before);
  });
  it("keeps releases private to the owner and bounded", async () => {
    expect(
      (await call("GET", `/api/projects/${projectId}/releases`, undefined, other)).statusCode,
    ).toBe(404);
    expect(
      (await call("POST", `/api/projects/${projectId}/releases/1/rollback`, { force: true }, other))
        .statusCode,
    ).toBe(404);
    for (let i = 0; i < 25; i++)
      expect(
        (await call("POST", `/api/projects/${projectId}/releases`, { note: "ciclo " + i }))
          .statusCode,
      ).toBe(200);
    const rows = (await call("GET", `/api/projects/${projectId}/releases`)).json();
    expect(rows).toHaveLength(20);
    expect(rows[0].note).toBe("ciclo 24");
    await db.query("DELETE FROM project_releases");
    expect((await db.query("SELECT count(*)::int AS n FROM project_releases")).rows[0].n).toBe(0);
  });
});
