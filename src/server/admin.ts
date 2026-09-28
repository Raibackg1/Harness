import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createDatabase, migrate } from "./db.js";
import { passwordHash } from "./security.js";
// Break-glass CLI. Passwords are read from stdin, never argv or log output.
const resetMfa = process.argv.includes("--reset-mfa");
const email = process.argv[2]?.trim().toLowerCase();
const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (!email || password.length < 12 || password.length > 128)
  throw new Error(
    "Usage: pipe a 12–128 character password on stdin; provide account email and optional --reset-mfa.",
  );
const db = await createDatabase(loadConfig());
try {
  await migrate(db);
  const encoded = await passwordHash(password);
  await db.transaction(async (tx) => {
    const {
      rows: [u],
    } = await tx.query("UPDATE users SET password_hash=$1 WHERE email=$2 RETURNING id", [
      encoded,
      email,
    ]);
    if (!u) throw new Error("Account not found.");
    await tx.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
    if (resetMfa) {
      await tx.query(
        "UPDATE users SET mfa_secret=NULL,mfa_pending=NULL,mfa_pending_until=NULL,mfa_counter=-1 WHERE id=$1",
        [u.id],
      );
      await tx.query("DELETE FROM recovery_codes WHERE user_id=$1", [u.id]);
      await tx.query(
        "INSERT INTO audit_events(user_id,action,detail) VALUES($1,'account.mfa_recovered','Explicit operator --reset-mfa recovery')",
        [u.id],
      );
    }
    await tx.query(
      "INSERT INTO audit_events(user_id,action,detail) VALUES($1,'account.password_recovered','Operator break-glass recovery')",
      [u.id],
    );
  });
  console.log(
    `Password changed${resetMfa ? "; MFA and recovery codes reset" : ""}; control-plane sessions revoked. Workspace sessions expire in at most 30 minutes. For emergency revocation, stop workspaces and verify physical termination.`,
  );
} finally {
  await db.close();
}
