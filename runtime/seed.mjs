import { readFile, mkdir, writeFile, access, rename, lstat } from "node:fs/promises";
import path from "node:path";
const root = "/home/coder/project";
const marker = "/home/coder/.harness-initialized";
try {
  await access(marker);
  process.exit(0);
} catch {}
await mkdir(root, { recursive: true });
const files = JSON.parse(await readFile("/run/seed/files.json", "utf8"));
for (const [name, content] of Object.entries(files)) {
  if (
    !/^[a-zA-Z0-9_.\-/]+$/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid seed path");
  const parts = name.split("/");
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    await mkdir(dir, { recursive: true });
    if ((await lstat(dir)).isSymbolicLink()) throw new Error("Symlink in seed");
  }
  // Never overwrite files if initialization was interrupted.
  try {
    await writeFile(path.join(root, name), content, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}
await writeFile(marker + ".tmp", "1", { mode: 0o600 });
await rename(marker + ".tmp", marker);
