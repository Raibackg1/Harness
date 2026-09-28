import {
  scrypt,
  randomBytes,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [salt, key] = encoded.split(":");
  const calculated = (await derive(password, salt, 64)) as Buffer;
  const expected = Buffer.from(key, "hex");
  return expected.length === calculated.length && timingSafeEqual(expected, calculated);
}
export function encrypt(value: string, key: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((x) => x.toString("base64")).join(".");
}
export function decrypt(value: string, key: string, context: string) {
  const [iv, tag, data] = value.split(".").map((x) => Buffer.from(x, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
export function validPath(path: string) {
  return (
    path.length <= 180 &&
    /^[a-zA-Z0-9_.\-/]+$/.test(path) &&
    !path.startsWith("/") &&
    !path.split("/").some((p) => !p || p === ".." || p === ".")
  );
}
