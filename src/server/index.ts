import path from "node:path";
import { loadConfig } from "./config.js";
import { createDatabase, migrate } from "./db.js";
import { createApp } from "./app.js";
const config = loadConfig();
const db = await createDatabase(config);
await migrate(db);
const app = await createApp(config, db);
if (config.NODE_ENV === "production") {
  const staticPlugin = (await import("@fastify/static")).default;
  await app.register(staticPlugin, { root: path.resolve("dist"), prefix: "/", wildcard: false });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/")
      ? reply.code(404).send({ error: "Ruta no encontrada." })
      : reply.sendFile("index.html"),
  );
} else {
  const { createServer } = await import("vite");
  await app.register((await import("@fastify/middie")).default);
  const vite = await createServer({
    server: { middlewareMode: true, ws: { server: app.server }, allowedHosts: true },
    appType: "spa",
  });
  app.use((req, res, next) =>
    req.url?.startsWith("/api/") || ["/healthz", "/readyz"].includes(req.url || "")
      ? next()
      : vite.middlewares(req, res, next),
  );
  app.addHook("onClose", async () => {
    await vite.close();
  });
}
const cleanup = setInterval(() => {
  void db
    .query("DELETE FROM sessions WHERE expires_at<now()")
    .then(() => db.query("DELETE FROM auth_attempts WHERE reset_at<now()"))
    .then(() =>
      db.query(
        "UPDATE users SET mfa_pending=NULL,mfa_pending_until=NULL WHERE mfa_pending_until<now()",
      ),
    )
    .catch((e) => app.log.error(e));
}, 3600000);
cleanup.unref();
app.addHook("onClose", async () => {
  clearInterval(cleanup);
  await db.close();
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void app.close());
await app.listen({ host: "0.0.0.0", port: config.PORT });
