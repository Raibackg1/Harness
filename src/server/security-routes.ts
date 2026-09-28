import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import QRCode from "qrcode";
import type { Database, Sql } from "./db.js";
import type { Config } from "./config.js";
import { HttpError, audit, type User, type Account } from "./contracts.js";
import { hash, verifyPassword, encrypt, decrypt, token } from "./security.js";
import { acceptedCounter, consumeFactor, newAuthenticator, replaceRecoveryCodes } from "./mfa.js";
export interface SecurityHooks {
  auth: (req: FastifyRequest) => Promise<void>;
  owner: (req: FastifyRequest) => Promise<void>;
  budget: (key: string, limit?: number) => Promise<void>;
  session: (user: User, reply: FastifyReply, req: FastifyRequest, tx?: Sql) => Promise<void>;
}
export async function registerSecurityRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
  h: SecurityHooks,
) {
  const cookieName = config.NODE_ENV === "production" ? "__Host-harness" : "harness_session";
  const current = (r: FastifyRequest) => hash(r.cookies[cookieName] || "");
  const proof = z.object({
    password: z.string().min(1).max(128),
    code: z.string().max(32).default(""),
  });
  async function reauthenticate(
    tx: Sql,
    req: FastifyRequest,
    input: z.infer<typeof proof>,
    factor = true,
  ) {
    const {
      rows: [u],
    } = await tx.query<Account>("SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE", [
      req.user!.id,
    ]);
    if (!u || u.suspended_at || !(await verifyPassword(input.password, u.password_hash)))
      throw new HttpError(403, "No se pudo verificar tu identidad.");
    if (factor && !(await consumeFactor(tx, config, u, input.code)))
      throw new HttpError(403, "Código de segundo factor inválido, vencido o ya utilizado.");
    return u;
  }
  app.get("/api/account/security", { preHandler: h.auth }, async (req) => {
    const {
      rows: [u],
    } = await db.query(
      "SELECT mfa_secret IS NOT NULL AS enabled,(SELECT count(*)::int FROM recovery_codes WHERE user_id=users.id) AS recovery_codes_remaining FROM users WHERE id=$1",
      [req.user!.id],
    );
    return { ...u, available: !!config.ENCRYPTION_KEY };
  });
  app.post("/api/account/mfa/setup", { preHandler: h.auth }, async (req) => {
    const input = proof.parse(req.body);
    await h.budget(`mfa:${req.user!.id}`);
    if (!config.ENCRYPTION_KEY)
      throw new HttpError(
        503,
        "Configura ENCRYPTION_KEY en el servidor antes de activar el segundo factor.",
      );
    const data = await db.transaction(async (tx) => {
      const u = await reauthenticate(tx, req, input, false);
      if (u.mfa_secret) throw new HttpError(409, "El segundo factor ya está activo.");
      const data = newAuthenticator(u.email);
      await tx.query(
        "UPDATE users SET mfa_pending=$1,mfa_pending_until=now()+interval '10 minutes' WHERE id=$2",
        [encrypt(data.secret, config.ENCRYPTION_KEY!, `mfa:${u.id}`), u.id],
      );
      return data;
    });
    return {
      ...data,
      qr: await QRCode.toDataURL(data.uri, { errorCorrectionLevel: "M", width: 240 }),
      expiresIn: 600,
    };
  });
  app.post("/api/account/mfa/confirm", { preHandler: h.auth }, async (req, reply) => {
    const input = proof.parse(req.body);
    await h.budget(`mfa:${req.user!.id}`);
    const recoveryCodes = await db.transaction(async (tx) => {
      const u = await reauthenticate(tx, req, input, false);
      if (
        u.mfa_secret ||
        !u.mfa_pending ||
        !u.mfa_pending_until ||
        new Date(u.mfa_pending_until) <= new Date()
      )
        throw new HttpError(
          409,
          "La configuración venció o el segundo factor ya está activo. Iníciala de nuevo.",
        );
      const counter = acceptedCounter(
        decrypt(u.mfa_pending, config.ENCRYPTION_KEY!, `mfa:${u.id}`),
        input.code,
        -1,
      );
      if (counter === null) throw new HttpError(403, "Código de autenticador inválido.");
      await tx.query(
        "UPDATE users SET mfa_secret=mfa_pending,mfa_pending=NULL,mfa_pending_until=NULL,mfa_counter=$1 WHERE id=$2",
        [counter, u.id],
      );
      const codes = await replaceRecoveryCodes(tx, u.id);
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
      await h.session(u, reply, req, tx);
      await audit(tx, u.id, "account.mfa_enabled");
      return codes;
    });
    return { recoveryCodes };
  });
  app.post("/api/account/mfa/disable", { preHandler: h.auth }, async (req, reply) => {
    const input = proof.parse(req.body);
    await h.budget(`mfa:${req.user!.id}`);
    await db.transaction(async (tx) => {
      const u = await reauthenticate(tx, req, input);
      if (!u.mfa_secret) throw new HttpError(409, "El segundo factor no está activo.");
      await tx.query(
        "UPDATE users SET mfa_secret=NULL,mfa_pending=NULL,mfa_pending_until=NULL,mfa_counter=-1 WHERE id=$1",
        [u.id],
      );
      await tx.query("DELETE FROM recovery_codes WHERE user_id=$1", [u.id]);
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
      await h.session(u, reply, req, tx);
      await audit(tx, u.id, "account.mfa_disabled");
    });
    return { ok: true };
  });
  app.post("/api/account/mfa/recovery-codes", { preHandler: h.auth }, async (req) => {
    const input = proof.parse(req.body);
    await h.budget(`mfa:${req.user!.id}`);
    const recoveryCodes = await db.transaction(async (tx) => {
      const u = await reauthenticate(tx, req, input);
      if (!u.mfa_secret) throw new HttpError(409, "Activa el segundo factor primero.");
      const codes = await replaceRecoveryCodes(tx, u.id);
      await audit(tx, u.id, "account.recovery_codes_rotated");
      return codes;
    });
    return { recoveryCodes };
  });
  app.get(
    "/api/account/sessions",
    { preHandler: h.auth },
    async (req) =>
      (
        await db.query(
          "SELECT id,client,created_at,expires_at,id_hash=$2 AS current FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC",
          [req.user!.id, current(req)],
        )
      ).rows,
  );
  app.delete("/api/account/sessions/:id", { preHandler: h.auth }, async (req, reply) => {
    const id = z
      .string()
      .uuid()
      .parse((req.params as any).id);
    const {
      rows: [s],
    } = await db.query("DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING id_hash", [
      id,
      req.user!.id,
    ]);
    if (!s) throw new HttpError(404, "Sesión no encontrada.");
    if (s.id_hash === current(req)) reply.clearCookie(cookieName, { path: "/" });
    await audit(db, req.user!.id, "account.session_revoked");
    return { ok: true, current: s.id_hash === current(req) };
  });
  app.post("/api/account/sessions/revoke-others", { preHandler: h.auth }, async (req) => {
    await db.transaction(async (tx) => {
      await tx.query("DELETE FROM sessions WHERE user_id=$1 AND id_hash<>$2", [
        req.user!.id,
        current(req),
      ]);
      await audit(tx, req.user!.id, "account.sessions_revoked");
    });
    return { ok: true };
  });
  app.patch("/api/team/members/:id", { preHandler: h.owner }, async (req) => {
    const id = z
      .string()
      .uuid()
      .parse((req.params as any).id);
    const input = proof.extend({ suspended: z.boolean() }).parse(req.body);
    await h.budget(`admin:${req.user!.id}`);
    if (id === req.user!.id) throw new HttpError(409, "No puedes suspender tu propia cuenta.");
    await db.transaction(async (tx) => {
      await tx.query("SELECT id FROM runtime_capacity WHERE id=1 FOR UPDATE");
      await reauthenticate(tx, req, input);
      const {
        rows: [u],
      } = await tx.query<Account>("SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE", [id]);
      if (!u) throw new HttpError(404, "Cuenta no encontrada.");
      if (u.role === "owner")
        throw new HttpError(
          409,
          "No se puede suspender una cuenta administradora desde este panel.",
        );
      await tx.query(
        "UPDATE users SET suspended_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE id=$2",
        [input.suspended, id],
      );
      if (input.suspended) {
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);
        await tx.query("DELETE FROM invitations WHERE email=$1 AND used_at IS NULL", [u.email]);
        const { rows: projects } = await tx.query(
          "SELECT id FROM projects WHERE owner_id=$1 AND desired<>'deleted' FOR UPDATE",
          [id],
        );
        for (const p of projects)
          await tx.query(
            "UPDATE projects SET desired='stopped',status=CASE WHEN provisioned OR desired='running' THEN 'stopping' ELSE 'stopped' END,published=false,revision=revision+1,runtime_key=$1,updated_at=now() WHERE id=$2",
            [config.ENCRYPTION_KEY ? encrypt(token(), config.ENCRYPTION_KEY, p.id) : null, p.id],
          );
      }
      await audit(
        tx,
        req.user!.id,
        input.suspended ? "member.suspended" : "member.reactivated",
        null,
        u.email,
      );
    });
    return { ok: true };
  });
}
