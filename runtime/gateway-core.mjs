import { createServer } from "node:http";
import httpProxy from "http-proxy";
import {
  COOKIE,
  hostTarget,
  verifyTicket,
  issueSession,
  authorized,
  sessionClaims,
  stripPlatformCookies,
} from "./auth.mjs";
export function createGateway({
  env,
  key,
  targets = {
    ide: "http://127.0.0.1:8080",
    agent: "http://127.0.0.1:3080",
    app: "http://127.0.0.1:3000",
  },
  // dsh web authenticates browsers with a per-process token it prints at startup; the
  // browser must visit /?token= once to get dsh's own cookie. Returns null until known.
  agentToken = async () => null,
}) {
  for (const name of ["PROJECT_ID", "APP_ORIGIN", "IDE_HOST", "AI_HOST", "APP_HOST"])
    if (!env[name]) throw new Error(`${name} is required`);
  const used = new Map();
  const cleanup = setInterval(() => {
    for (const [id, exp] of used) if (exp < Date.now()) used.delete(id);
  }, 30000).unref();
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false, proxyTimeout: 60000 });
  proxy.on("error", (_err, _req, res) => {
    if (res.writeHead) {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("El servicio no está disponible. Revisa la terminal del proyecto.");
    } else res.destroy();
  });
  proxy.on("proxyRes", (res) => {
    // Upstream applications never get to overwrite the gateway's session.
    if (res.headers["set-cookie"])
      res.headers["set-cookie"] = res.headers["set-cookie"].filter(
        (c) => !c.trimStart().startsWith(COOKIE + "="),
      );
    res.headers["referrer-policy"] = "no-referrer";
    res.headers["x-content-type-options"] = "nosniff";
    res.headers["content-security-policy"] =
      (res.headers["content-security-policy"]
        ? res.headers["content-security-policy"] + "; "
        : "") + "frame-ancestors 'none'";
  });
  function prepare(req, target) {
    req.headers.cookie = stripPlatformCookies(req.headers.cookie);
    // User apps may implement Bearer authentication. No platform bearer token is used here.
    if (target !== "app") delete req.headers.authorization;
    for (const k of Object.keys(req.headers))
      if (k.startsWith("x-forwarded-") || k === "forwarded") delete req.headers[k];
    req.headers["x-forwarded-proto"] = "https";
    return {
      target: targets[target],
    };
  }
  async function ready() {
    const checks = await Promise.all(
      [targets.ide, targets.agent].map(async (url) => {
        try {
          const r = await fetch(`${url}/`, { signal: AbortSignal.timeout(1500) });
          await r.body?.cancel();
          return r.status < 500;
        } catch {
          return false;
        }
      }),
    );
    return checks.every(Boolean);
  }
  const server = createServer(async (req, res) => {
    try {
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      if (req.url === "/livez") {
        res.writeHead(200);
        return res.end("ok");
      }
      if (req.url === "/healthz") {
        const ok = await ready();
        res.writeHead(ok ? 200 : 503);
        return res.end(ok ? "ready" : "starting");
      }
      const host = req.headers.host;
      const target = hostTarget(host, env);
      if (!target) {
        res.writeHead(421);
        return res.end("Unknown host");
      }
      if (req.url === "/_harness/launch" && req.method === "POST" && target !== "app") {
        if (req.headers.origin !== env.APP_ORIGIN) {
          res.writeHead(403);
          return res.end("Origin denied");
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192) {
            res.writeHead(413);
            return res.end();
          }
        }
        const ticket = new URLSearchParams(body).get("ticket");
        const p = await verifyTicket(ticket || "", key, host, env.PROJECT_ID);
        if (p.target !== target || used.has(p.jti)) {
          res.writeHead(403);
          return res.end("Ticket already used or invalid");
        }
        const handoff = target === "agent" ? await agentToken() : null;
        // Checked before burning the ticket, so the same launch can simply be retried.
        if (target === "agent" && !handoff) {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "3" });
          return res.end("El agente todavía está arrancando. Vuelve a abrirlo en unos segundos.");
        }
        used.set(p.jti, Date.now() + 70000);
        const session = await issueSession(p, key, host);
        res.writeHead(303, {
          "Set-Cookie": `${COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800`,
          Location:
            target === "ide"
              ? "/?folder=/home/coder/project"
              : "/?token=" + encodeURIComponent(handoff),
        });
        return res.end();
      }
      if (target === "app") {
        if (env.PUBLISHED !== "true") {
          res.writeHead(404);
          return res.end("Not published");
        }
      } else {
        if (!(await authorized(req.headers.cookie, key, host, env.PROJECT_ID))) {
          res.writeHead(401, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          });
          return res.end(
            '<html lang="es"><title>Acceso a tu entorno</title><body style="font:16px system-ui;background:#142822;color:#f3f5ed;padding:12vh 10vw"><h1>Vuelve a tu espacio.</h1><p>La sesión del entorno ha caducado. Abre el IDE o el agente nuevamente desde Harness Cloud.</p></body></html>',
          );
        }
        if (
          !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
          req.headers.origin !== `https://${host}`
        ) {
          res.writeHead(403);
          return res.end("Origin denied");
        }
      }
      proxy.web(req, res, prepare(req, target));
    } catch {
      if (!res.headersSent) res.writeHead(403);
      res.end("Invalid or expired access ticket");
    }
  });
  server.on("upgrade", async (req, socket, head) => {
    try {
      const target = hostTarget(req.headers.host, env);
      if (!target || req.headers.origin !== `https://${req.headers.host}`) return socket.destroy();
      if (target === "app") {
        if (env.PUBLISHED !== "true") return socket.destroy();
      } else {
        const claims = await sessionClaims(
          req.headers.cookie,
          key,
          req.headers.host,
          env.PROJECT_ID,
        );
        if (!claims) return socket.destroy();
        // HTTP authorization at handshake is not enough: bound the life of upgraded connections too.
        const expiration = setTimeout(
          () => socket.destroy(),
          Math.max(0, claims.exp * 1000 - Date.now()),
        );
        expiration.unref();
        socket.once("close", () => clearTimeout(expiration));
      }
      proxy.ws(req, socket, head, prepare(req, target));
    } catch {
      socket.destroy();
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.once("close", () => {
    clearInterval(cleanup);
    proxy.close();
  });
  return server;
}
