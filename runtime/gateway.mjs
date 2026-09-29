import { readFile } from "node:fs/promises";
import { createGateway } from "./gateway-core.mjs";
const key = new TextEncoder().encode((await readFile("/run/gateway/key", "utf8")).trim());
// Written by entrypoint.sh from dsh's startup line; readable only by this uid.
const agentToken = async () => {
  try {
    return (await readFile("/tmp/harness/dsh-web-token", "utf8")).trim() || null;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
const server = createGateway({ env: process.env, key, agentToken });
server.listen(8088, "0.0.0.0");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
