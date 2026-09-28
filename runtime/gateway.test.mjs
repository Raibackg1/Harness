import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  verifyTicket,
  issueSession,
  authorized,
  COOKIE,
  hostTarget,
  stripPlatformCookies,
} from "./auth.mjs";
const key = new TextEncoder().encode("a-strong-project-specific-secret-32-bytes");
const ticket = () =>
  new SignJWT({ project: "p1", target: "ide" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("harness-cloud")
    .setAudience("ide-p1.runtime.net")
    .setSubject("user-1")
    .setJti("one-time")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(key);
test("authenticates launch tickets and binds them to project and audience", async () => {
  const t = await ticket();
  const p = await verifyTicket(t, key, "ide-p1.runtime.net", "p1");
  assert.equal(p.sub, "user-1");
  await assert.rejects(verifyTicket(t, key, "ide-p2.runtime.net", "p1"));
  await assert.rejects(verifyTicket(t, key, "ide-p1.runtime.net", "p2"));
});
test("requires a valid session; never accepts a launch ticket as a session", async () => {
  const t = await ticket();
  assert.equal(await authorized(`${COOKIE}=${t}`, key, "ide-p1.runtime.net", "p1"), false);
  const p = await verifyTicket(t, key, "ide-p1.runtime.net", "p1");
  const session = await issueSession(p, key, "ide-p1.runtime.net");
  assert.equal(await authorized(`${COOKIE}=${session}`, key, "ide-p1.runtime.net", "p1"), true);
  assert.equal(await authorized(`${COOKIE}=${session}`, key, "ide-p1.runtime.net", "p2"), false);
  assert.equal(await authorized("", key, "ide-p1.runtime.net", "p1"), false);
});
test("routes only exact configured hosts", () => {
  const env = { IDE_HOST: "ide.example", AI_HOST: "ai.example", APP_HOST: "app.example" };
  assert.equal(hostTarget("ide.example", env), "ide");
  assert.equal(hostTarget("ide.example.evil", env), null);
  assert.equal(hostTarget("app.example", env), "app");
});
test("removes gateway and control cookies before reaching user code", () => {
  assert.equal(
    stripPlatformCookies(
      `${COOKIE}=secret; __Host-harness=control; harness_session=local; upstream=ok`,
    ),
    "upstream=ok",
  );
});
