import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { SignJWT } from "jose";
import { zipSync, strToU8 } from "fflate";
import type { Config } from "./config.js";
import type { Database, Sql } from "./db.js";
import {
  hash,
  token,
  passwordHash,
  verifyPassword,
  encrypt,
  decrypt,
  validPath,
} from "./security.js";
import { Kubernetes, hosts } from "./kubernetes.js";
import { templates, type TemplateId } from "../shared/templates.js";
import { HttpError, audit, type User, type Account } from "./contracts.js";
import { consumeFactor } from "./mfa.js";
import { bundleExtras, readArchive } from "./bundle.js";
import { listReleases, restoreRelease, snapshotRelease, writeProjectFiles } from "./releases.js";
import { registerSecurityRoutes } from "./security-routes.js";
import { changeRuntime, capacityReport } from "./runtime-policy.js";
import {
  initializeEncryptionKey,
  assertEncryptionKey,
  withEncryptionFence,
} from "./encryption-maintenance.js";
export { HttpError } from "./contracts.js";
declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12, "Usa al menos 12 caracteres.").max(128);
const uuid = z.string().uuid();
const id = (r: FastifyRequest) => uuid.parse((r.params as any).id);
const userFields = "id,name,email,role,mfa_enabled";
// One source of truth for templates: a new entry in shared/templates.ts is accepted
// by the API, seeded and downloadable without touching this file.
const templateIds = Object.keys(templates) as [TemplateId, ...TemplateId[]];
const publicProject = `id,name,description,template,desired,status,error,archived,provisioned,published,revision,created_at,updated_at,runtime_expires_at`;
export async function createApp(config: Config, db: Database, logging = true) {
  await initializeEncryptionKey(db, config.ENCRYPTION_KEY);
  db = withEncryptionFence(db, config.ENCRYPTION_KEY);
  const app = Fastify({
    logger: logging
      ? {
          level: "info",
          redact: ["req.headers.cookie", "req.headers.authorization", "res.headers.set-cookie"],
          serializers: {
            req: (r) => ({ method: r.method, url: r.url?.split("?")[0], hostname: r.hostname }),
            err: (e) => ({ type: e.name, message: e.message, stack: "" }),
          },
        }
      : false,
    bodyLimit: 600_000,
    trustProxy: false,
  });
  const k8s = new Kubernetes(config);
  app.decorateRequest("user", null);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy:
      config.NODE_ENV === "production"
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:"],
              connectSrc: ["'self'"],
              frameAncestors: ["'none'"],
              formAction: [
                "'self'",
                ...(config.WORKSPACE_DOMAIN ? [`https://*.${config.WORKSPACE_DOMAIN}`] : []),
              ],
              objectSrc: ["'none'"],
              baseUri: ["'self'"],
            },
          }
        : false,
    frameguard: config.NODE_ENV === "production" ? { action: "deny" } : false,
  });
  await app.register(rateLimit, {
    hook: "preHandler",
    max: 180,
    timeWindow: "1 minute",
    keyGenerator: (r) => r.user?.id || r.ip,
  });
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    await assertEncryptionKey(db, config.ENCRYPTION_KEY);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      let accepted = false;
      try {
        accepted = config.APP_ORIGIN
          ? origin === config.APP_ORIGIN
          : !!origin && new URL(origin).host === req.headers.host;
      } catch {
        accepted = false;
      }
      if (!accepted)
        throw new HttpError(
          403,
          "Origen no permitido. Recarga la página desde el dominio de la plataforma.",
        );
      if (req.headers["content-type"]?.split(";")[0] !== "application/json")
        throw new HttpError(415, "Se requiere application/json.");
    }
    const session =
      req.cookies[config.NODE_ENV === "production" ? "__Host-harness" : "harness_session"];
    if (session) {
      const {
        rows: [user],
      } = await db.query<User>(
        `SELECT u.${userFields.split(",").join(",u.")} FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=$1 AND s.expires_at>now() AND u.suspended_at IS NULL`,
        [hash(session)],
      );
      req.user = user || null;
    }
  });
  const auth = async (req: FastifyRequest) => {
    if (!req.user) throw new HttpError(401, "Inicia sesión para continuar.");
  };
  const owner = async (req: FastifyRequest) => {
    await auth(req);
    if (req.user!.role !== "owner")
      throw new HttpError(403, "Solo el administrador puede realizar esta acción.");
  };
  const project = async (req: FastifyRequest, tx: Sql = db, lock = false) => {
    await auth(req);
    const {
      rows: [p],
    } = await tx.query(
      `SELECT * FROM projects WHERE id=$1 AND owner_id=$2 ${lock ? "FOR UPDATE" : ""}`,
      [id(req), req.user!.id],
    );
    if (!p) throw new HttpError(404, "Proyecto no encontrado.");
    return p;
  };
  const session = async (user: User, reply: FastifyReply, req: FastifyRequest, tx?: Sql) => {
    const value = token();
    const issue = async (sql: Sql) => {
      const {
        rows: [u],
      } = await sql.query("SELECT id,suspended_at FROM users WHERE id=$1 FOR NO KEY UPDATE", [
        user.id,
      ]);
      if (!u || u.suspended_at) throw new HttpError(403, "La cuenta no está disponible.");
      await sql.query(
        "INSERT INTO sessions(id_hash,user_id,expires_at,client) VALUES($1,$2,now()+interval '7 days',$3)",
        [
          hash(value),
          user.id,
          (req.headers["user-agent"] || "Cliente sin identificar").slice(0, 240),
        ],
      );
    };
    if (tx) await issue(tx);
    else await db.transaction(issue);
    reply.setCookie(
      config.NODE_ENV === "production" ? "__Host-harness" : "harness_session",
      value,
      {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure:
          config.NODE_ENV === "production" || config.APP_ORIGIN?.startsWith("https://") === true,
        maxAge: 604800,
      },
    );
  };
  // Persistent, replica-independent limits for credential endpoints. No dependence on spoofable proxy headers.
  const countAttempt = async (key: string) => {
    const {
      rows: [r],
    } = await db.query(
      `INSERT INTO auth_attempts(key,count,reset_at) VALUES ($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_attempts.reset_at<now() THEN 1 ELSE auth_attempts.count+1 END, reset_at=CASE WHEN auth_attempts.reset_at<now() THEN now()+interval '15 minutes' ELSE auth_attempts.reset_at END RETURNING count`,
      [hash(key)],
    );
    return r.count as number;
  };
  const budgetSpent = async (key: string, limit = 12) => (await countAttempt(key)) > limit;
  const authBudget = async (key: string, limit = 12) => {
    if (await budgetSpent(key, limit))
      throw new HttpError(429, "Demasiados intentos. Espera 15 minutos.");
  };
  // Only the account-scoped key is cleared after a success, so a valid session cannot be
  // used to launder the shared per-IP budget while guessing other accounts' passwords.
  const clearBudget = (sql: Sql, key: string) =>
    sql.query("DELETE FROM auth_attempts WHERE key=$1", [hash(key)]);
  // Throttling must never lock out the legitimate owner: past the account budget only
  // failed attempts are rejected, while a correct credential clears the counter and proceeds.
  const rejected = (spent: boolean, message: string) =>
    spent
      ? new HttpError(429, "Demasiados intentos. Espera 15 minutos.")
      : new HttpError(401, message);
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => {
    await assertEncryptionKey(db, config.ENCRYPTION_KEY);
    return { ok: true };
  });
  app.get("/api/session", async (req) => ({
    user: req.user,
    setupRequired: !(await db.query("SELECT id FROM users LIMIT 1")).rows.length,
    bootstrapRequired: !!config.BOOTSTRAP_TOKEN,
  }));
  app.post("/api/auth/register", async (req, reply) => {
    const input = z
      .object({
        name: z.string().trim().min(2).max(70),
        email,
        password,
        invitation: z.string().max(100).optional(),
        bootstrapToken: z.string().max(200).optional(),
      })
      .parse(req.body);
    await authBudget(`register:${req.ip}`, 30);
    const encoded = await passwordHash(input.password);
    const user = await db.transaction(async (tx) => {
      await tx.query("SELECT id FROM schema_migrations WHERE id=1 FOR UPDATE");
      const first = !(await tx.query("SELECT id FROM users LIMIT 1")).rows.length;
      if (first && config.BOOTSTRAP_TOKEN) {
        const supplied = Buffer.from(hash(input.bootstrapToken || "")),
          expected = Buffer.from(hash(config.BOOTSTRAP_TOKEN));
        if (!timingSafeEqual(supplied, expected))
          throw new HttpError(403, "Token de instalación inválido.");
      }
      if (!first) {
        const {
          rows: [inv],
        } = await tx.query(
          "SELECT * FROM invitations WHERE token_hash=$1 AND email=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
          [hash(input.invitation || ""), input.email],
        );
        if (!inv) throw new HttpError(403, "Necesitas una invitación válida para este correo.");
        await tx.query("UPDATE invitations SET used_at=now() WHERE id=$1", [inv.id]);
      }
      if ((await tx.query("SELECT id FROM users WHERE email=$1", [input.email])).rows.length)
        throw new HttpError(409, "No se puede registrar esta cuenta.");
      const user: User = {
        id: randomUUID(),
        name: input.name,
        email: input.email,
        role: first ? "owner" : "member",
        mfa_enabled: false,
      };
      await tx.query(
        "INSERT INTO users(id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5)",
        [user.id, user.name, user.email, encoded, user.role],
      );
      await audit(tx, user.id, "account.created");
      return user;
    });
    await session(user, reply, req);
    reply.code(201);
    return { user };
  });
  const dummyHash = await passwordHash(randomBytes(32).toString("hex"));
  app.post("/api/auth/login", async (req, reply) => {
    const input = z
      .object({ email, password: z.string().max(128), code: z.string().max(32).default("") })
      .parse(req.body);
    const spent = await budgetSpent(`login:${input.email}`);
    await authBudget(`login-ip:${req.ip}`, 100);
    const {
      rows: [candidate],
    } = await db.query<Account>("SELECT * FROM users WHERE email=$1", [input.email]);
    const valid = await verifyPassword(input.password, candidate?.password_hash || dummyHash);
    if (!candidate || !valid || candidate.suspended_at)
      throw rejected(spent, "Correo, contraseña o acceso a la cuenta incorrectos.");
    return db.transaction(async (tx) => {
      const {
        rows: [u],
      } = await tx.query<Account>("SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE", [
        candidate.id,
      ]);
      if (!u || u.suspended_at || u.password_hash !== candidate.password_hash)
        throw new HttpError(401, "Vuelve a iniciar sesión.");
      if (u.mfa_secret && !input.code) return { mfaRequired: true };
      if (!(await consumeFactor(tx, config, u, input.code)))
        throw rejected(spent, "Código de segundo factor inválido, vencido o ya utilizado.");
      await clearBudget(tx, `login:${input.email}`);
      await session(u as User, reply, req, tx);
      await audit(tx, u.id, "account.login");
      return {
        user: { id: u.id, name: u.name, email: u.email, role: u.role, mfa_enabled: u.mfa_enabled },
      };
    });
  });
  app.post("/api/auth/logout", { preHandler: auth }, async (req, reply) => {
    const cookieName = config.NODE_ENV === "production" ? "__Host-harness" : "harness_session";
    await db.query("DELETE FROM sessions WHERE id_hash=$1", [hash(req.cookies[cookieName] || "")]);
    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  });
  app.patch("/api/account", { preHandler: auth }, async (req) => {
    const input = z.object({ name: z.string().trim().min(2).max(70) }).parse(req.body);
    await db.query("UPDATE users SET name=$1 WHERE id=$2", [input.name, req.user!.id]);
    return { ok: true };
  });
  app.post("/api/account/password", { preHandler: auth }, async (req, reply) => {
    const input = z
      .object({ current: z.string().max(128), password, code: z.string().max(32).default("") })
      .parse(req.body);
    await authBudget(`password:${req.user!.id}`);
    const encoded = await passwordHash(input.password);
    await db.transaction(async (tx) => {
      const {
        rows: [u],
      } = await tx.query<Account>("SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE", [
        req.user!.id,
      ]);
      if (!u || u.suspended_at || !(await verifyPassword(input.current, u.password_hash)))
        throw new HttpError(403, "La contraseña actual no es correcta.");
      if (!(await consumeFactor(tx, config, u, input.code)))
        throw new HttpError(403, "Verifica el segundo factor con un código nuevo.");
      await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [encoded, u.id]);
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
      await audit(tx, u.id, "account.password_changed");
      await session(u as User, reply, req, tx);
    });
    return { ok: true };
  });
  await registerSecurityRoutes(app, db, config, { auth, owner, budget: authBudget, session });
  app.get(
    "/api/projects",
    { preHandler: auth },
    async (req) =>
      (
        await db.query(
          `SELECT ${publicProject} FROM projects WHERE owner_id=$1 ORDER BY updated_at DESC`,
          [req.user!.id],
        )
      ).rows,
  );
  app.post("/api/projects", { preHandler: auth }, async (req, reply) => {
    const input = z
      .object({
        name: z.string().trim().min(2).max(60),
        description: z.string().trim().max(300).default(""),
        template: z.enum(templateIds),
        archive: z.string().min(1).max(560_000).optional(),
      })
      .parse(req.body);
    // "Bring your own code": a ZIP from a forge or your laptop becomes the initial snapshot,
    // so the platform is not the only way to start a project.
    const imported = input.archive ? readArchive(input.archive).files : null;
    const pid = randomUUID();
    const p = await db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [req.user!.id]);
      const {
        rows: [n],
      } = await tx.query("SELECT count(*)::int AS total FROM projects WHERE owner_id=$1", [
        req.user!.id,
      ]);
      if (n.total >= config.MAX_PROJECTS)
        throw new HttpError(409, `Tu límite es de ${config.MAX_PROJECTS} proyectos.`);
      const {
        rows: [p],
      } = await tx.query(
        `INSERT INTO projects(id,owner_id,name,description,template,runtime_key,reconciled_revision) VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING ${publicProject}`,
        [
          pid,
          req.user!.id,
          input.name,
          input.description,
          input.template,
          config.ENCRYPTION_KEY ? encrypt(token(), config.ENCRYPTION_KEY, pid) : null,
        ],
      );
      for (const [path, content] of Object.entries(imported ?? templates[input.template].files))
        await tx.query("INSERT INTO project_files(project_id,path,content) VALUES ($1,$2,$3)", [
          pid,
          path,
          content,
        ]);
      await audit(tx, req.user!.id, "project.created", pid, input.name);
      return p;
    });
    reply.code(201);
    return p;
  });
  app.get("/api/projects/:id", { preHandler: auth }, async (req) => {
    const p = await project(req);
    delete p.runtime_key;
    delete p.owner_id;
    return p;
  });
  app.patch("/api/projects/:id", { preHandler: auth }, async (req) => {
    const input = z
      .object({
        name: z.string().trim().min(2).max(60),
        description: z.string().trim().max(300),
        archived: z.boolean(),
      })
      .parse(req.body);
    await db.transaction(async (tx) => {
      const p = await project(req, tx, true);
      if (p.desired !== "stopped")
        throw new HttpError(409, "Detén el entorno antes de cambiar sus ajustes.");
      await tx.query(
        "UPDATE projects SET name=$1,description=$2,archived=$3,updated_at=now() WHERE id=$4",
        [input.name, input.description, input.archived, p.id],
      );
      await audit(tx, req.user!.id, "project.updated", p.id, input.name);
    });
    return { ok: true };
  });
  app.delete("/api/projects/:id", { preHandler: auth }, async (req) => {
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body);
    await db.transaction(async (tx) => {
      const p = await project(req, tx, true);
      if (confirm !== p.name) throw new HttpError(400, "Escribe el nombre exacto del proyecto.");
      if (p.provisioned && config.KUBERNETES_ENABLED !== "true")
        throw new HttpError(
          503,
          "Reconecta Kubernetes para eliminar el volumen de este proyecto de forma segura.",
        );
      if (
        config.KUBERNETES_ENABLED === "true" &&
        (p.provisioned || p.desired === "running" || p.status !== "stopped")
      )
        await tx.query(
          "UPDATE projects SET desired='deleted',status='deleting',revision=revision+1,updated_at=now() WHERE id=$1",
          [p.id],
        );
      else await tx.query("DELETE FROM projects WHERE id=$1", [p.id]);
      await audit(tx, req.user!.id, "project.deleted", p.id, p.name);
    });
    return { ok: true };
  });
  app.get("/api/projects/:id/files", { preHandler: auth }, async (req) => {
    await project(req);
    return (
      await db.query(
        "SELECT path,content,version FROM project_files WHERE project_id=$1 ORDER BY path",
        [id(req)],
      )
    ).rows;
  });
  app.put("/api/projects/:id/files", { preHandler: auth }, async (req) => {
    const input = z
      .object({
        path: z.string().refine(validPath, "Ruta de archivo inválida."),
        content: z.string().max(100_000),
        version: z.number().int().min(0),
      })
      .parse(req.body);
    return db.transaction(async (tx) => {
      const p = await project(req, tx, true);
      if (p.provisioned || p.desired !== "stopped")
        throw new HttpError(
          409,
          "Los archivos activos se editan en el IDE. Esta vista conserva el código inicial.",
        );
      const { rows: fs } = await tx.query(
        "SELECT path,octet_length(content) AS size FROM project_files WHERE project_id=$1",
        [p.id],
      );
      if (fs.length >= 50 && !fs.some((f) => f.path === input.path))
        throw new HttpError(409, "Máximo 50 archivos iniciales.");
      if (
        fs.filter((f) => f.path !== input.path).reduce((s, f) => s + f.size, 0) +
          Buffer.byteLength(input.content) >
        450000
      )
        throw new HttpError(409, "Límite de 450 KB para archivos iniciales.");
      let rows;
      if (input.version === 0)
        ({ rows } = await tx.query(
          "INSERT INTO project_files(project_id,path,content) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING version",
          [p.id, input.path, input.content],
        ));
      else
        ({ rows } = await tx.query(
          "UPDATE project_files SET content=$1,version=version+1 WHERE project_id=$2 AND path=$3 AND version=$4 RETURNING version",
          [input.content, p.id, input.path, input.version],
        ));
      if (!rows.length)
        throw new HttpError(409, "El archivo cambió en otra sesión. Recarga antes de guardar.");
      await tx.query("UPDATE projects SET updated_at=now() WHERE id=$1", [p.id]);
      await audit(tx, req.user!.id, "file.saved", p.id, input.path);
      return rows[0];
    });
  });
  app.get("/api/projects/:id/export", { preHandler: auth }, async (req, reply) => {
    await project(req);
    const { rows } = await db.query("SELECT path,content FROM project_files WHERE project_id=$1", [
      id(req),
    ]);
    const archive = zipSync(Object.fromEntries(rows.map((f) => [f.path, strToU8(f.content)])));
    reply
      .header("Content-Disposition", `attachment; filename="harness-${id(req)}-initial.zip"`)
      .type("application/zip");
    return Buffer.from(archive);
  });
  const fileRows = async (projectId: string) =>
    (
      await db.query("SELECT path,content FROM project_files WHERE project_id=$1 ORDER BY path", [
        projectId,
      ])
    ).rows as { path: string; content: string }[];
  const secretRowNames = async (projectId: string) =>
    (
      await db.query("SELECT name FROM secrets WHERE project_id=$1 ORDER BY name", [projectId])
    ).rows.map((r: any) => r.name) as string[];
  // A runnable bundle, not just a code dump: the project must start on any Docker host
  // without Harness. Secret values stay behind by design; only their names travel.
  app.get("/api/projects/:id/bundle", { preHandler: auth }, async (req, reply) => {
    const p = await project(req);
    const rows = await fileRows(p.id);
    const files = Object.fromEntries(rows.map((f) => [f.path, f.content]));
    const extra = bundleExtras({
      name: p.name,
      template: p.template,
      files,
      secretNames: await secretRowNames(p.id),
    });
    const merged = { ...files, ...extra.files };
    const archive = zipSync(
      Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, strToU8(v)])),
    );
    reply
      .header("Content-Disposition", 'attachment; filename="harness-' + p.id + '-bundle.zip"')
      .type("application/zip");
    return Buffer.from(archive);
  });
  const importBody = z.object({
    archive: z
      .string()
      .min(1)
      .max(560_000, "El ZIP debe pesar menos de ~410 KB (el cuerpo máximo de la API es 600 KB)."),
    mode: z.enum(["replace", "merge"]).default("merge"),
  });
  app.post("/api/projects/:id/import", { preHandler: auth }, async (req) => {
    const input = importBody.parse(req.body);
    const read = readArchive(input.archive);
    return db.transaction(async (tx) => {
      const p = await project(req, tx, true);
      if (p.provisioned || p.desired !== "stopped")
        throw new HttpError(
          409,
          "Los archivos activos se editan en el IDE. Esta importación escribe el código inicial.",
        );
      const imported = await writeProjectFiles(tx, p.id, read.files, input.mode);
      await tx.query("UPDATE projects SET updated_at=now() WHERE id=$1", [p.id]);
      await audit(
        tx,
        req.user!.id,
        "project.imported",
        p.id,
        imported + " archivos en modo " + input.mode,
      );
      return { imported, skipped: read.skipped };
    });
  });
  app.get("/api/projects/:id/releases", { preHandler: auth }, async (req) => {
    await project(req);
    return listReleases(db, id(req));
  });
  app.post("/api/projects/:id/releases", { preHandler: auth }, async (req) => {
    const { note } = z
      .object({ note: z.string().trim().max(200).default("") })
      .parse(req.body ?? {});
    return db.transaction(async (tx) => {
      const p = await project(req, tx, true);
      const releaseId = await snapshotRelease(tx, p.id, note || "Instantánea manual");
      await audit(tx, req.user!.id, "release.snapshot", p.id, note);
      return { id: releaseId };
    });
  });
  app.post("/api/projects/:id/releases/:release/rollback", { preHandler: auth }, async (req) => {
    const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
    const releaseId = z.coerce
      .number()
      .int()
      .positive()
      .parse((req.params as any).release);
    return db.transaction(async (tx) => {
      const p = await project(req, tx, true);
      if (p.provisioned || p.desired !== "stopped")
        throw new HttpError(
          409,
          "Restaurar reemplaza el código inicial; hazlo con el entorno detenido y sin aprovisionar.",
        );
      return restoreRelease(tx, {
        projectId: p.id,
        userId: req.user!.id,
        releaseId,
        force,
      });
    });
  });
  app.post("/api/projects/:id/runtime", { preHandler: auth }, async (req) => {
    const { action } = z
      .object({ action: z.enum(["start", "stop", "restart", "publish", "unpublish"]) })
      .parse(req.body);
    if (config.KUBERNETES_ENABLED !== "true")
      throw new HttpError(
        503,
        "Kubernetes no está conectado. Configura la infraestructura para ejecutar el proyecto.",
      );
    await changeRuntime(db, config, req.user!.id, id(req), action);
    return { ok: true };
  });
  app.post("/api/projects/:id/launch", { preHandler: auth }, async (req) => {
    const { target } = z.object({ target: z.enum(["ide", "agent"]) }).parse(req.body);
    const p = await project(req);
    if (
      config.KUBERNETES_ENABLED !== "true" ||
      p.status !== "running" ||
      p.desired !== "running" ||
      !p.runtime_expires_at ||
      new Date(p.runtime_expires_at) <= new Date()
    )
      throw new HttpError(409, "El entorno aún no está listo.");
    const host = hosts(p.id, config.WORKSPACE_DOMAIN!)[target];
    const jwt = await new SignJWT({ project: p.id, target })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("harness-cloud")
      .setAudience(host)
      .setSubject(req.user!.id)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(new TextEncoder().encode(decrypt(p.runtime_key, config.ENCRYPTION_KEY!, p.id)));
    return { url: `https://${host}/_harness/launch`, ticket: jwt };
  });
  app.get("/api/projects/:id/events", { preHandler: auth }, async (req) => {
    const p = await project(req);
    if (config.KUBERNETES_ENABLED !== "true" || !p.provisioned) return [];
    return k8s.logs(p.id);
  });
  app.get("/api/projects/:id/secrets", { preHandler: auth }, async (req) => {
    await project(req);
    return (
      await db.query("SELECT name,updated_at FROM secrets WHERE project_id=$1 ORDER BY name", [
        id(req),
      ])
    ).rows;
  });
  const secretName = z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .refine(
      (n) =>
        ![
          "HOME",
          "PATH",
          "NODE_OPTIONS",
          "NODE_PATH",
          "LD_PRELOAD",
          "LD_LIBRARY_PATH",
          "APP_ORIGIN",
          "PROJECT_ID",
          "IDE_HOST",
          "AI_HOST",
          "APP_HOST",
          "PUBLISHED",
          "BASH_ENV",
          "ENV",
          "SHELL",
          "SSL_CERT_FILE",
          "NODE_EXTRA_CA_CERTS",
        ].includes(n) && !n.startsWith("DSH_"),
      "Nombre reservado para el entorno.",
    );
  app.put("/api/projects/:id/secrets", { preHandler: auth }, async (req) => {
    const input = z
      .object({ name: secretName, value: z.string().min(1).max(8192) })
      .parse(req.body);
    if (!config.ENCRYPTION_KEY)
      throw new HttpError(503, "Configura ENCRYPTION_KEY antes de guardar secretos.");
    await db.transaction(async (tx) => {
      const p = await project(req, tx, true);
      const {
        rows: [r],
      } = await tx.query("SELECT count(*)::int AS total FROM secrets WHERE project_id=$1", [p.id]);
      if (
        r.total >= 40 &&
        !(
          await tx.query("SELECT name FROM secrets WHERE project_id=$1 AND name=$2", [
            p.id,
            input.name,
          ])
        ).rows.length
      )
        throw new HttpError(409, "Máximo 40 variables.");
      await tx.query(
        "INSERT INTO secrets(project_id,name,ciphertext) VALUES ($1,$2,$3) ON CONFLICT(project_id,name) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,updated_at=now()",
        [p.id, input.name, encrypt(input.value, config.ENCRYPTION_KEY!, `${p.id}:${input.name}`)],
      );
      await audit(tx, req.user!.id, "secret.saved", p.id, input.name);
    });
    return { ok: true, restartRequired: true };
  });
  app.delete("/api/projects/:id/secrets", { preHandler: auth }, async (req) => {
    const { name } = z.object({ name: secretName }).parse(req.body);
    await db.transaction(async (tx) => {
      await project(req, tx, true);
      await tx.query("DELETE FROM secrets WHERE project_id=$1 AND name=$2", [id(req), name]);
      await audit(tx, req.user!.id, "secret.deleted", id(req), name);
    });
    return { ok: true };
  });
  app.get("/api/activity", { preHandler: auth }, async (req) => {
    const { before } = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    return (
      await db.query(
        "SELECT id,action,detail,project_id,created_at FROM audit_events WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 50",
        [req.user!.id, before || null],
      )
    ).rows;
  });
  app.get("/api/team", { preHandler: owner }, async () => ({
    members: (
      await db.query(`SELECT ${userFields},created_at,suspended_at FROM users ORDER BY created_at`)
    ).rows,
    invitations: (
      await db.query(
        "SELECT id,email,expires_at,used_at FROM invitations ORDER BY expires_at DESC LIMIT 50",
      )
    ).rows,
  }));
  app.post("/api/team/invitations", { preHandler: owner }, async (req) => {
    const input = z.object({ email }).parse(req.body);
    const raw = token();
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO invitations(id,token_hash,email,created_by,expires_at) VALUES($1,$2,$3,$4,now()+interval '48 hours')",
        [randomUUID(), hash(raw), input.email, req.user!.id],
      );
      await audit(tx, req.user!.id, "invitation.created", null, input.email);
    });
    return { invitation: raw, email: input.email };
  });
  app.delete("/api/team/invitations/:id", { preHandler: owner }, async (req) => {
    await db.query("DELETE FROM invitations WHERE id=$1", [id(req)]);
    await audit(db, req.user!.id, "invitation.revoked");
    return { ok: true };
  });
  app.get("/api/infrastructure/capacity", { preHandler: owner }, async () =>
    capacityReport(db, config),
  );
  app.get("/api/infrastructure", { preHandler: auth }, async () => ({
    database: db.kind,
    kubernetes: config.KUBERNETES_ENABLED === "true",
    workspaceDomain: config.WORKSPACE_DOMAIN || null,
    runtimeClass: config.RUNTIME_CLASS,
    secrets: !!config.ENCRYPTION_KEY,
    maxProjects: config.MAX_PROJECTS,
    maxRunningPerUser: config.MAX_RUNNING_PER_USER,
    maxRunningTotal: config.MAX_RUNNING_TOTAL,
    maxRuntimeMinutes: config.MAX_RUNTIME_MINUTES,
    mode: config.NODE_ENV,
    agentVersion: "0.1.7-rc.2",
    publicSignup: false,
  }));
  app.post("/api/infrastructure/check", { preHandler: owner }, async () => {
    if (config.KUBERNETES_ENABLED !== "true")
      throw new HttpError(503, "No hay un clúster conectado. Sigue la guía de instalación.");
    const [version, boundaries] = await Promise.all([k8s.check(), k8s.sandboxBoundaries()]);
    if (!boundaries.ok)
      throw new HttpError(
        503,
        `Falta la frontera de admisión del worker: ${boundaries.checks
          .filter((c) => !c.ok)
          .map((c) => `${c.name} (${c.problems.join("; ")})`)
          .join(", ")}. Instala infra/k8s/admission.yaml antes de aceptar entornos.`,
      );
    return {
      ok: true,
      version: version.gitVersion,
      checkedAt: new Date().toISOString(),
      boundaries: boundaries.checks,
      notice:
        "La API, RuntimeClass y las políticas de admisión responden. Esto no valida el aislamiento, CNI, DNS ni certificados.",
    };
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ error: error.issues[0]?.message || "Datos inválidos." });
    const err = error as Error & { statusCode?: number };
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err: error }, "Request failed");
    reply.code(status).send({
      error: status === 500 ? "Ocurrió un error interno. Intenta nuevamente." : err.message,
      requestId: req.id,
    });
  });
  return app;
}
