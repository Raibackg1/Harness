import { describe, it, expect } from "vitest";
import { zipSync, strToU8, strFromU8 } from "fflate";
import { bundleExtras, readArchive, containerPort, archiveLimits } from "../src/server/bundle";
const b64 = (entries: Record<string, string | Uint8Array>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(entries).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]),
      ),
    ),
  ).toString("base64");
const project = {
  name: "Mi API",
  template: "node",
  files: { "index.js": "console.log(1)\n", "package.json": "{}\n" },
  secretNames: ["DATABASE_URL", "PROVIDER_KEY"],
};
describe("runnable export bundle", () => {
  it("adds a Dockerfile, compose file, env template and manifest per template", () => {
    for (const template of ["react", "node", "python", "fastapi", "html"]) {
      const { files, generated } = bundleExtras({ ...project, template });
      expect(generated).toEqual([
        "Dockerfile",
        "docker-compose.yml",
        ".env.example",
        "harness-export.json",
      ]);
      expect(files["Dockerfile"]).toContain("FROM");
      expect(files["Dockerfile"]).toContain("EXPOSE " + containerPort(template));
      expect(files["docker-compose.yml"]).toContain("3000:" + containerPort(template));
      const manifest = JSON.parse(files["harness-export.json"]);
      expect(manifest).toMatchObject({
        manifestVersion: 1,
        template,
        containerPort: containerPort(template),
        fileCount: 2,
      });
      expect(manifest.secretNames).toEqual(project.secretNames);
    }
    expect(containerPort("html")).toBe(80);
    expect(bundleExtras({ ...project, template: "html" }).files["Dockerfile"]).toContain("nginx");
  });
  it("never overrides a build the project already owns", () => {
    const owned = bundleExtras({
      ...project,
      files: {
        ...project.files,
        Dockerfile: "FROM my/base\n",
        "docker-compose.yml": "services: {}\n",
      },
    });
    expect(owned.generated).toEqual([".env.example", "harness-export.json"]);
    expect(owned.files).not.toHaveProperty("Dockerfile");
    expect(owned.files[".env.example"]).toBe(
      "# Variables declaradas en Harness Cloud. Los valores nunca se exportan.\n" +
        "# Cárgalos en el entorno de ejecución y, si usas compose, copia este archivo a .env.\nDATABASE_URL=\nPROVIDER_KEY=\n",
    );
  });
  it("adds an empty PostgreSQL to compose when the project has a database, without a password", () => {
    const { files } = bundleExtras({
      name: "Con base",
      template: "node",
      files: { "index.js": "1" },
      secretNames: ["API_KEY"],
      database: true,
    });
    const compose = files["docker-compose.yml"];
    expect(compose).toContain("image: postgres:17.6");
    expect(compose).toContain("DATABASE_URL: postgresql://app:${POSTGRES_PASSWORD}@db:5432/app");
    expect(compose).toContain("${POSTGRES_PASSWORD:?");
    expect(files[".env.example"]).toContain("POSTGRES_PASSWORD=\n");
    expect(JSON.parse(files["harness-export.json"]).database).toEqual({
      engine: "postgresql",
      version: "17",
      data: "not exported",
    });
    const plain = bundleExtras({ name: "x", template: "node", files: {}, secretNames: [] }).files;
    expect(plain["docker-compose.yml"]).not.toContain("postgres");
    expect(JSON.parse(plain["harness-export.json"]).database).toBeNull();
  });
  it("falls back to a generic recipe for an unknown template", () => {
    const { files } = bundleExtras({ ...project, template: "cobol" });
    expect(files["Dockerfile"]).toContain("node:22-bookworm-slim");
    expect(JSON.parse(files["harness-export.json"]).language).toBe(null);
  });
});
describe("bounded ZIP import", () => {
  it("reads a forge archive and strips the single shared top folder", () => {
    const read = readArchive(
      b64({ "myrepo-main/README.md": "hola\n", "myrepo-main/src/app.js": "1\n" }),
    );
    expect(Object.keys(read.files)).toEqual(["README.md", "src/app.js"]);
    expect(read.files["README.md"]).toBe("hola\n");
    expect(read.skipped).toEqual([]);
  });
  it("skips directories, junk, node_modules, its own manifest, binaries and unsafe paths", () => {
    const read = readArchive(
      b64({
        "a/": "",
        "src/index.js": "ok\n",
        "node_modules/dep/index.js": "x\n",
        "__MACOSX/._file": "x\n",
        ".DS_Store": "x\n",
        "harness-export.json": "{}",
        "img.bin": new Uint8Array([70, 73, 76, 0, 1, 2]),
        "../escape": "no\n",
        "/etc/passwd": "no\n",
      }),
    );
    expect(Object.keys(read.files)).toEqual(["src/index.js"]);
    expect(read.skipped.map((s) => s.why).sort()).toEqual([
      "binario o UTF-8 inválido",
      "ruta inválida o absoluta",
      "ruta inválida o absoluta",
    ]);
  });
  it("enforces the same budgets as the file editor", () => {
    const big = "x".repeat(archiveLimits.maxFileBytes + 1);
    const oversized = readArchive(b64({ "big.txt": big, "ok.txt": "1\n" }));
    expect(oversized.skipped[0]).toMatchObject({ path: "big.txt" });
    expect(oversized.skipped[0].why).toContain("límite por archivo");
    expect(Object.keys(oversized.files)).toEqual(["ok.txt"]);
    // An archive where nothing can be imported is an error, not a silent no-op.
    expect(() => readArchive(b64({ "big.txt": big }))).toThrow("no contiene archivos de texto");
    const many = Object.fromEntries(
      Array.from({ length: archiveLimits.maxFiles + 5 }, (_, i) => [`f${i}.txt`, "1\n"]),
    );
    const read = readArchive(b64(many));
    expect(Object.keys(read.files)).toHaveLength(archiveLimits.maxFiles);
    expect(read.skipped.every((s) => s.why === "demasiados archivos")).toBe(true);
    const fat = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, "y".repeat(20_000)]),
    );
    const total = readArchive(b64(fat));
    expect(Object.keys(total.files).length).toBeLessThan(30);
    expect(total.skipped.some((s) => s.why.includes("presupuesto total"))).toBe(true);
  });
  it("rejects what is not a readable archive instead of importing nothing", () => {
    expect(() => readArchive("not-a-zip")).toThrow("ZIP válido");
    expect(() => readArchive("")).toThrow("demasiado grande");
    expect(() => readArchive(b64({ "readme.txt": "x" }))).not.toThrow();
  });
});
