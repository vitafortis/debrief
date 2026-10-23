import { defineConfig, devices } from "@playwright/test";

// The production build against a throwaway database filled with the demo
// data (tests/global-setup.ts wipes and seeds it). Test-only values below.
const PORT = Number(process.env.E2E_PORT ?? 3160);
process.env.E2E_DATABASE_URL ??= "postgresql://debrief:debrief@localhost:55520/debrief_e2e";

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./tests/global-setup.ts",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      AUTH_SECRET: "e2e-secret-not-for-production-use-0000",
      DEBRIEF_PASSWORD: "e2e-password",
      OWNER_NAME: "Tester",
      TZ: "America/New_York",
      PUBLIC_URL: `http://localhost:${PORT}`,
      AUDIO_DIR: "/nonexistent",
    },
  },
});
