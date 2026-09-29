import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";
// Without E2E_BASE_URL the suite starts its own server on a throwaway embedded database,
// so `npm run test:e2e` never touches a DB with real users. The directory is wiped first.
const external = process.env.E2E_BASE_URL;
const port = Number(process.env.E2E_PORT || 3100);
const baseURL = external || `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  expect: { timeout: 8000 },
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.CHROMIUM_EXECUTABLE
      ? {
          executablePath: process.env.CHROMIUM_EXECUTABLE,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote"],
        }
      : {},
  },
  webServer: external
    ? undefined
    : {
        command: "rm -rf .cache/e2e-auto && tsx src/server/index.ts",
        url: `${baseURL}/healthz`,
        reuseExistingServer: false,
        timeout: 120000,
        env: {
          PORT: String(port),
          APP_ORIGIN: baseURL,
          DATA_DIR: ".cache/e2e-auto",
          ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        },
      },
  reporter: "list",
});
