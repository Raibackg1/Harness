import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { createDatabase, type Database } from "./db.js";
import { EncryptionMaintenanceError, rotateEncryptionKey } from "./encryption-maintenance.js";
import { readKeyFile } from "./key-file.js";
let db: Database | undefined;
try {
  const { values } = parseArgs({
    options: {
      "old-key-file": { type: "string" },
      "new-key-file": { type: "string" },
      operator: { type: "string" },
      apply: { type: "boolean" },
      offline: { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Usage: node build/server/rotate-key.js --old-key-file /private/old --new-key-file /private/new --operator CHANGE-ID [--apply --offline]\nDefault: validation only. Applying requires maintenance: stop API/worker and verify workspaces stopped. Keys are never accepted in argv or printed. Apply schema migrations beforehand.",
    );
  } else {
    if (!values["old-key-file"] || !values["new-key-file"] || !values.operator)
      throw new EncryptionMaintenanceError(
        "Faltan --old-key-file, --new-key-file o --operator. Consulta --help.",
      );
    const oldKey = await readKeyFile(values["old-key-file"]),
      newKey = await readKeyFile(values["new-key-file"]);
    // The file is authoritative; do not depend on the ambient ENCRYPTION_KEY.
    db = await createDatabase(loadConfig({ ...process.env, ENCRYPTION_KEY: oldKey }));
    const {
      rows: [schema],
    } = await db.query("SELECT version FROM schema_migrations WHERE id=1");
    if (schema?.version !== 3)
      throw new EncryptionMaintenanceError(
        "La herramienta requiere esquema v3. Aplica las migraciones de esta versión primero.",
      );
    const result = await rotateEncryptionKey(db, {
      oldKey,
      newKey,
      operator: values.operator,
      apply: values.apply,
      offline: values.offline,
    });
    console.log(JSON.stringify(result));
  }
} catch (e) {
  console.error(
    e instanceof EncryptionMaintenanceError
      ? e.message
      : "No se pudo completar la operación. Revisa los argumentos, conexión, esquema y ventana de mantenimiento. No se imprimen detalles sensibles.",
  );
  process.exitCode = 1;
} finally {
  await db?.close();
}
