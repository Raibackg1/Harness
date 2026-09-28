import { jwtVerify, SignJWT } from "jose";
export const COOKIE = "__Host-harness-workspace";
export function hostTarget(host, env) {
  if (host === env.IDE_HOST) return "ide";
  if (host === env.AI_HOST) return "agent";
  if (host === env.APP_HOST) return "app";
  return null;
}
export async function verifyTicket(ticket, key, host, project) {
  const { payload } = await jwtVerify(ticket, key, {
    algorithms: ["HS256"],
    issuer: "harness-cloud",
    audience: host,
    maxTokenAge: "65s",
    requiredClaims: ["exp", "iat", "sub", "jti"],
  });
  if (
    payload.project !== project ||
    !payload.jti ||
    !payload.sub ||
    !["ide", "agent"].includes(payload.target)
  )
    throw new Error("Invalid launch ticket");
  return payload;
}
export async function issueSession(payload, key, host) {
  return new SignJWT({ project: payload.project, target: payload.target })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("harness-workspace")
    .setAudience(host)
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(key);
}
export async function sessionClaims(cookie, key, host, project) {
  try {
    const raw = (cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(COOKIE + "="))
      ?.slice(COOKIE.length + 1);
    if (!raw) return null;
    const { payload } = await jwtVerify(raw, key, {
      algorithms: ["HS256"],
      issuer: "harness-workspace",
      requiredClaims: ["exp", "iat", "sub"],
      maxTokenAge: "30m",
      audience: host,
    });
    return payload.project === project ? payload : null;
  } catch {
    return null;
  }
}
export function stripPlatformCookies(cookie = "") {
  return cookie
    .split(";")
    .map((s) => s.trim())
    .filter(
      (s) =>
        !s.startsWith(COOKIE + "=") &&
        !s.startsWith("__Host-harness=") &&
        !s.startsWith("harness_session="),
    )
    .join("; ");
}

export async function authorized(cookie, key, host, project) {
  return !!(await sessionClaims(cookie, key, host, project));
}
