import { readFile } from "node:fs/promises";
import { createGateway } from "./gateway-core.mjs";
const key = new TextEncoder().encode((await readFile("/run/gateway/key", "utf8")).trim());
const server = createGateway({ env: process.env, key });
server.listen(8088, "0.0.0.0");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
