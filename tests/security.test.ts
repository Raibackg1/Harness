import { describe, it, expect } from "vitest";
import { passwordHash, verifyPassword, encrypt, decrypt, validPath } from "../src/server/security";
import { loadConfig } from "../src/server/config";
describe("security primitives", () => {
  it("uses salted password hashes and rejects the wrong password", async () => {
    const a = await passwordHash("a strong password");
    const b = await passwordHash("a strong password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("a strong password", a)).toBe(true);
    expect(await verifyPassword("not the password", a)).toBe(false);
  });
  it("authenticates ciphertext, key and tenant context", () => {
    const key = "ab".repeat(32);
    const cipher = encrypt("provider-secret", key, "project1:KEY");
    expect(cipher).not.toContain("provider-secret");
    expect(decrypt(cipher, key, "project1:KEY")).toBe("provider-secret");
    expect(() => decrypt(cipher, key, "project2:KEY")).toThrow();
    expect(() => decrypt(cipher, "cd".repeat(32), "project1:KEY")).toThrow();
    expect(() => decrypt(cipher.slice(0, -3) + "abc", key, "project1:KEY")).toThrow();
  });
  it.each([
    "../etc/passwd",
    "/tmp/evil",
    "src/../../secret",
    "src//a",
    "src/./a",
    "a\\b",
    "a\u0000b",
    "",
    "a/",
  ])("rejects unsafe file path %s", (path) => expect(validPath(path)).toBe(false));
  it.each(["src/main.ts", ".env", "package.json", "a-b/c_d.js"])(
    "accepts relative path %s",
    (path) => expect(validPath(path)).toBe(true),
  );
  it("rejects an insecure production configuration", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow("DATABASE_URL");
    expect(() => loadConfig({ KUBERNETES_ENABLED: "true" })).toThrow("APP_ORIGIN");
  });
  it("requires an https control origin before workspaces are reachable", () => {
    const c = {
      KUBERNETES_ENABLED: "true",
      WORKSPACE_DOMAIN: "workspaces.other.net",
      WORKSPACE_IMAGE: "registry.local/x@sha256:" + "ab".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
    };
    // The workspace gateway validates the ticket origin and issues Secure cookies, so an
    // absent or http origin must fail at startup instead of crash-looping a workspace.
    expect(() => loadConfig({ ...c, APP_ORIGIN: undefined })).toThrow("APP_ORIGIN");
    expect(() => loadConfig({ ...c, APP_ORIGIN: "http://cloud.company.com" })).toThrow("HTTPS");
    expect(() => loadConfig({ ...c, APP_ORIGIN: "https://cloud.other.net" })).toThrow(
      "isolated domain",
    );
    expect(loadConfig({ ...c, APP_ORIGIN: "https://cloud.company.com" }).APP_ORIGIN).toBe(
      "https://cloud.company.com",
    );
  });
  it("rejects a mutable runtime image and non-sandboxed runtime", () => {
    const c = {
      KUBERNETES_ENABLED: "true",
      APP_ORIGIN: "https://cloud.company.com",
      WORKSPACE_DOMAIN: "workspaces.other.net",
      WORKSPACE_IMAGE: "runtime:latest",
      ENCRYPTION_KEY: "ab".repeat(32),
    };
    expect(() => loadConfig(c)).toThrow("digest");
    expect(() =>
      loadConfig({ ...c, WORKSPACE_IMAGE: "x@sha256:" + "ab".repeat(32), RUNTIME_CLASS: "runc" }),
    ).toThrow("Only gvisor");
  });
});
