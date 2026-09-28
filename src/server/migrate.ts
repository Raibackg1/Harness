import { loadConfig } from "./config.js";
import { createDatabase, migrate } from "./db.js";
const db = await createDatabase(loadConfig());
try {
  await migrate(db);
  console.log("Database schema is up to date.");
} finally {
  await db.close();
}
