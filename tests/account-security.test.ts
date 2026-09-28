import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";
import { createDatabase, migrate, type Database } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { authenticator, acceptedCounter } from "../src/server/mfa";
import { decrypt, hash } from "../src/server/security";
let db: Database,
  app: Awaited<ReturnType<typeof createApp>>,
  owner = "",
  member = "",
  memberId = "",
  ownerId = "",
  projectId = "",
  secret = "",
  codes: string[] = [];
const password = "security-test-password",
  origin = "http://localhost",
  key = "ab".repeat(32);
const call = (method: any, url: string, body: any = undefined, cookie = member) =>
  app.inject({
    method,
    url,
    headers: {
      origin,
      "content-type": "application/json",
      cookie,
      "user-agent": "Integration browser",
    },
    ...(body === undefined ? {} : { payload: body }),
  });
const session = (r: any) => `${r.cookies[0].name}=${r.cookies[0].value}`;
beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: "memory://",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    APP_ORIGIN: origin,
    ENCRYPTION_KEY: key,
  });
  db = await createDatabase(config);
  await migrate(db);
  app = await createApp(config, db, false);
  const o = await call(
    "POST",
    "/api/auth/register",
    { name: "Owner", email: "owner@security.test", password },
    "",
  );
  owner = session(o);
  ownerId = o.json().user.id;
  const invite = (
    await call("POST", "/api/team/invitations", { email: "member@security.test" }, owner)
  ).json().invitation;
  const m = await call(
    "POST",
    "/api/auth/register",
    { name: "Member", email: "member@security.test", password, invitation: invite },
    "",
  );
  member = session(m);
  memberId = m.json().user.id;
  projectId = (
    await call("POST", "/api/projects", { name: "Private workspace", template: "node" })
  ).json().id;
});
beforeEach(async () => {
  await db.query("DELETE FROM auth_attempts");
});
afterAll(async () => {
  await app.close();
  await db.close();
});
describe("TOTP, recovery and account/session lifecycle", () => {
  it("requires password reauthentication to enroll and encrypts the pending seed", async () => {
    expect((await call("POST", "/api/account/mfa/setup", { password: "wrong" })).statusCode).toBe(
      403,
    );
    const r = await call("POST", "/api/account/mfa/setup", { password });
    expect(r.statusCode).toBe(200);
    secret = r.json().secret;
    expect(r.json().uri).toMatch(/^otpauth:\/\/totp\//);
    expect(r.json().qr).toMatch(/^data:image\/png;base64,/);
    const {
      rows: [u],
    } = await db.query("SELECT * FROM users WHERE id=$1", [memberId]);
    expect(u.mfa_pending).not.toContain(secret);
    expect(decrypt(u.mfa_pending, key, `mfa:${memberId}`)).toBe(secret);
    expect(u.mfa_enabled).toBe(false);
  });
  it("rejects expired enrollment and requires a valid code", async () => {
    await db.query("UPDATE users SET mfa_pending_until=now()-interval '1 second' WHERE id=$1", [
      memberId,
    ]);
    expect(
      (
        await call("POST", "/api/account/mfa/confirm", {
          password,
          code: authenticator(secret).generate(),
        })
      ).statusCode,
    ).toBe(409);
    secret = (await call("POST", "/api/account/mfa/setup", { password })).json().secret;
    expect(
      (await call("POST", "/api/account/mfa/confirm", { password, code: "invalid" })).statusCode,
    ).toBe(403);
  });
  it("activates only on proof, revokes existing sessions, returns backup codes once", async () => {
    const old = member;
    const r = await call("POST", "/api/account/mfa/confirm", {
      password,
      code: authenticator(secret).generate({ timestamp: Date.now() - 30000 }),
    });
    expect(r.statusCode).toBe(200);
    codes = r.json().recoveryCodes;
    expect(codes).toHaveLength(10);
    member = session(r);
    expect((await call("GET", "/api/projects", undefined, old)).statusCode).toBe(401);
    const state = (await call("GET", "/api/account/security")).json();
    expect(state).toMatchObject({ enabled: true, recovery_codes_remaining: 10 });
    expect(JSON.stringify(state)).not.toContain(secret);
    const rows = (
      await db.query("SELECT code_hash FROM recovery_codes WHERE user_id=$1", [memberId])
    ).rows;
    expect(JSON.stringify(rows)).not.toContain(codes[0].replaceAll("-", ""));
    expect((await call("GET", "/api/session")).json().user.mfa_enabled).toBe(true);
  });
  it("does not issue a session after only the password; prevents TOTP replay", async () => {
    const first = await call(
      "POST",
      "/api/auth/login",
      { email: "member@security.test", password },
      "",
    );
    expect(first.json()).toEqual({ mfaRequired: true });
    expect(first.cookies).toHaveLength(0);
    const code = authenticator(secret).generate();
    const r = await call(
      "POST",
      "/api/auth/login",
      { email: "member@security.test", password, code },
      "",
    );
    expect(r.statusCode).toBe(200);
    expect(r.cookies).toHaveLength(1);
    expect(
      (await call("POST", "/api/auth/login", { email: "member@security.test", password, code }, ""))
        .statusCode,
    ).toBe(401);
  });
  it("consumes a recovery code exactly once under concurrent logins", async () => {
    const results = await Promise.all(
      [1, 2].map(() =>
        call(
          "POST",
          "/api/auth/login",
          { email: "member@security.test", password, code: codes[0] },
          "",
        ),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect((await call("GET", "/api/account/security")).json().recovery_codes_remaining).toBe(9);
  });
  it("requires a second factor for a password change and sensitive MFA changes", async () => {
    expect(
      (
        await call("POST", "/api/account/password", {
          current: password,
          password: "new-long-password",
        })
      ).statusCode,
    ).toBe(403);
    expect((await call("POST", "/api/account/mfa/disable", { password })).statusCode).toBe(403);
    expect(
      (await call("POST", "/api/account/mfa/recovery-codes", { password, code: codes[0] }))
        .statusCode,
    ).toBe(403);
  });
  it("lists public session IDs without bearer hashes and isolates revocation", async () => {
    const sessions = (await call("GET", "/api/account/sessions")).json();
    expect(sessions.length).toBeGreaterThan(1);
    expect(sessions.filter((s: any) => s.current)).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain("id_hash");
    expect(sessions[0].client).toBe("Integration browser");
    const other = sessions.find((s: any) => !s.current);
    expect((await call("DELETE", `/api/account/sessions/${other.id}`, {}, owner)).statusCode).toBe(
      404,
    );
    expect((await call("DELETE", `/api/account/sessions/${other.id}`, {})).statusCode).toBe(200);
    await call("POST", "/api/account/sessions/revoke-others", {});
    expect((await call("GET", "/api/account/sessions")).json()).toHaveLength(1);
  });
  it("rotates recovery codes, invalidates old codes and disables 2FA with proof", async () => {
    const r = await call("POST", "/api/account/mfa/recovery-codes", { password, code: codes[1] });
    expect(r.statusCode).toBe(200);
    expect(
      (
        await call(
          "POST",
          "/api/auth/login",
          { email: "member@security.test", password, code: codes[2] },
          "",
        )
      ).statusCode,
    ).toBe(401);
    codes = r.json().recoveryCodes;
    const disabled = await call("POST", "/api/account/mfa/disable", { password, code: codes[0] });
    expect(disabled.statusCode).toBe(200);
    member = session(disabled);
    expect((await call("GET", "/api/account/security")).json()).toMatchObject({
      enabled: false,
      recovery_codes_remaining: 0,
    });
  });
  it("requires owner proof and disallows self-suspension and ordinary-member admin operations", async () => {
    expect(
      (await call("PATCH", `/api/team/members/${ownerId}`, { password, suspended: true }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call("PATCH", `/api/team/members/${ownerId}`, { password, suspended: true }, owner))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          "PATCH",
          `/api/team/members/${memberId}`,
          { password: "wrong", suspended: true },
          owner,
        )
      ).statusCode,
    ).toBe(403);
  });
  it("suspends accounts, revokes sessions and requests stopping workspaces without deleting code", async () => {
    await db.query(
      "UPDATE projects SET desired='running',status='running',provisioned=true,published=true WHERE id=$1",
      [projectId],
    );
    const before = (await db.query("SELECT runtime_key FROM projects WHERE id=$1", [projectId]))
      .rows[0].runtime_key;
    expect(
      (await call("PATCH", `/api/team/members/${memberId}`, { password, suspended: true }, owner))
        .statusCode,
    ).toBe(200);
    expect((await call("GET", "/api/projects")).statusCode).toBe(401);
    expect(
      (await call("POST", "/api/auth/login", { email: "member@security.test", password }, ""))
        .statusCode,
    ).toBe(401);
    const p = (await db.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];
    expect(p).toMatchObject({ desired: "stopped", status: "stopping", published: false });
    expect(p.runtime_key).not.toBe(before);
    expect(
      (await db.query("SELECT path FROM project_files WHERE project_id=$1", [projectId])).rows
        .length,
    ).toBeGreaterThan(0);
  });
  it("reactivation does not resurrect sessions or automatically start workloads", async () => {
    expect(
      (await call("PATCH", `/api/team/members/${memberId}`, { password, suspended: false }, owner))
        .statusCode,
    ).toBe(200);
    expect((await call("GET", "/api/projects")).statusCode).toBe(401);
    expect(
      (await call("POST", "/api/auth/login", { email: "member@security.test", password }, ""))
        .statusCode,
    ).toBe(200);
    expect(
      (await db.query("SELECT desired FROM projects WHERE id=$1", [projectId])).rows[0].desired,
    ).toBe("stopped");
  });
});
describe("TOTP time validation", () => {
  it("rejects stale, malformed and reused codes with a deterministic clock", () => {
    const now = 1800000000000;
    const s = "JBSWY3DPEHPK3PXP";
    const code = authenticator(s).generate({ timestamp: now });
    const counter = acceptedCounter(s, code, -1, now);
    expect(counter).toBe(now / 30000);
    expect(acceptedCounter(s, code, counter!, now)).toBe(null);
    expect(acceptedCounter(s, code, -1, now + 90000)).toBe(null);
    expect(acceptedCounter(s, "123", -1, now)).toBe(null);
  });
});

describe("login attempt budget", () => {
  const email = "owner@security.test";
  const attempts = (body: Record<string, string>) => call("POST", "/api/auth/login", body, "");
  const counter = async (key: string) =>
    (
      await db.query("SELECT coalesce(max(count),0)::int AS n FROM auth_attempts WHERE key=$1", [
        hash(key),
      ])
    ).rows[0].n;
  it("throttles guessing without locking the legitimate owner out", async () => {
    for (let i = 0; i < 12; i++)
      expect((await attempts({ email, password: "not-the-password" })).statusCode).toBe(401);
    // Past the budget a wrong credential is throttled...
    expect((await attempts({ email, password: "not-the-password" })).statusCode).toBe(429);
    expect(await counter(`login:${email}`)).toBe(13);
    // ...while the owner still signs in and resets the account counter.
    expect((await attempts({ email, password })).statusCode).toBe(200);
    expect(await counter(`login:${email}`)).toBe(0);
    // The shared per-IP budget is not laundered by that success, so spraying stays expensive.
    expect(
      (await db.query("SELECT max(count)::int AS n FROM auth_attempts")).rows[0].n,
    ).toBeGreaterThanOrEqual(14);
    expect((await attempts({ email, password: "not-the-password" })).statusCode).toBe(401);
  });
  it("never lets a spent budget block a correct password plus a valid code", async () => {
    const pending = (await call("POST", "/api/account/mfa/setup", { password }, owner)).json()
      .secret;
    const confirmed = await call(
      "POST",
      "/api/account/mfa/confirm",
      { password, code: authenticator(pending).generate() },
      owner,
    );
    expect(confirmed.statusCode).toBe(200);
    owner = session(confirmed);
    for (let i = 0; i < 12; i++)
      expect((await attempts({ email, password, code: "000000" })).statusCode).toBe(401);
    expect((await attempts({ email, password, code: "000000" })).statusCode).toBe(429);
    // A fresh window: the code consumed while enrolling is replay-proof by design.
    expect(
      (
        await attempts({
          email,
          password,
          code: authenticator(pending).generate({ timestamp: Date.now() + 30000 }),
        })
      ).statusCode,
    ).toBe(200);
    expect(await counter(`login:${email}`)).toBe(0);
  });
});
