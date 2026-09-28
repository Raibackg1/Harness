import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { EncryptionMaintenanceError } from "./encryption-maintenance.js";
// No symlinks, directories, group/world permissions or unbounded reads. Secret
// projections must be copied to operator-owned 0600 files before running the CLI.
export async function readKeyFile(path: string) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 64 || stat.size > 66)
      throw new Error("Invalid key file");
    const data = Buffer.alloc(67);
    try {
      const { bytesRead } = await file.read(data, 0, data.length, 0);
      const value = data.subarray(0, bytesRead).toString("utf8");
      if (!/^[a-f\d]{64}(?:\r?\n)?$/i.test(value)) throw new Error("Invalid key file");
      return value.trim().toLowerCase();
    } finally {
      data.fill(0);
    }
  } catch {
    throw new EncryptionMaintenanceError(
      "No se pudo leer una clave: usa un archivo regular privado (0600/0400), sin enlaces, con 64 caracteres hexadecimales.",
    );
  } finally {
    await file?.close();
  }
}
