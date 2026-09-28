import { it, expect } from "vitest";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKeyFile } from "../src/server/key-file";
it("reads a private regular key file, normalizes case and rejects symlinks/directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-key-file-"));
  try {
    const path = join(dir, "key");
    await writeFile(path, "AB".repeat(32) + "\r\n", { mode: 0o600 });
    expect(await readKeyFile(path)).toBe("ab".repeat(32));
    const link = join(dir, "link");
    await symlink(path, link);
    await expect(readKeyFile(link)).rejects.toThrow("archivo regular");
    await expect(readKeyFile(dir)).rejects.toThrow("archivo regular");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it.each([
  ["ab".repeat(32), 0o644],
  ["ab".repeat(32), 0o640],
  ["private-input-must-not-appear", 0o600],
  ["ab".repeat(33), 0o600],
  ["ab".repeat(32) + "\n\n", 0o600],
])(
  "rejects unsafe or invalid key files without echoing their contents (case %#)",
  async (content, mode) => {
    const dir = await mkdtemp(join(tmpdir(), "harness-key-file-"));
    try {
      const path = join(dir, "key");
      await writeFile(path, content, { mode });
      await expect(readKeyFile(path)).rejects.toThrow("archivo regular");
      try {
        await readKeyFile(path);
      } catch (e) {
        expect((e as Error).message).not.toContain(content);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
