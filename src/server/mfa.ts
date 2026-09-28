import { Secret, TOTP } from "otpauth";
import { randomBytes } from "node:crypto";
import { decrypt, hash } from "./security.js";
import type { Sql } from "./db.js";
import type { Config } from "./config.js";
export const authenticator = (secret: string, email = "") =>
  new TOTP({
    issuer: "Harness Cloud",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
export const newAuthenticator = (email: string) => {
  const secret = new Secret({ size: 20 }).base32;
  return { secret, uri: authenticator(secret, email).toString() };
};
export function acceptedCounter(secret: string, code: string, last: number, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = authenticator(secret).validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  const counter = Math.floor(now / 30000) + delta;
  return counter > last ? counter : null;
}
// Caller MUST hold the users row lock. Recovery-code consumption and TOTP counters
// are committed in the same transaction as the authenticated operation.
export async function consumeFactor(
  tx: Sql,
  config: Config,
  user: { id: string; mfa_secret: string | null; mfa_counter: number | string },
  code: string,
) {
  if (!user.mfa_secret) return true;
  if (!config.ENCRYPTION_KEY) return false;
  const normalized = code.trim().replace(/[- ]/g, "").toUpperCase();
  if (/^[0-9A-F]{16}$/.test(normalized)) {
    const result = await tx.query(
      "DELETE FROM recovery_codes WHERE user_id=$1 AND code_hash=$2 RETURNING user_id",
      [user.id, hash(`${user.id}:${normalized}`)],
    );
    return result.rows.length === 1;
  }
  const secret = decrypt(user.mfa_secret, config.ENCRYPTION_KEY, `mfa:${user.id}`);
  const counter = acceptedCounter(secret, normalized, Number(user.mfa_counter));
  if (counter === null) return false;
  await tx.query("UPDATE users SET mfa_counter=$1 WHERE id=$2", [counter, user.id]);
  return true;
}
export async function replaceRecoveryCodes(tx: Sql, userId: string) {
  const codes = Array.from({ length: 10 }, () => randomBytes(8).toString("hex").toUpperCase());
  await tx.query("DELETE FROM recovery_codes WHERE user_id=$1", [userId]);
  for (const code of codes)
    await tx.query("INSERT INTO recovery_codes(user_id,code_hash)VALUES($1,$2)", [
      userId,
      hash(`${userId}:${code}`),
    ]);
  return codes.map((c) => c.match(/.{4}/g)!.join("-"));
}
