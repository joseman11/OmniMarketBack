import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:3001";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL },
  webServer: {
    command: "npm run start",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NODE_ENV: "test",
      PORT: "3001",
      API_ORIGIN: baseURL,
      WEB_ORIGIN: "http://127.0.0.1:3000",
      E2E_TEST_AUTH: process.env.E2E_TEST_AUTH ?? "true",
      TEST_API_TOKEN: process.env.TEST_API_TOKEN ?? "local-e2e-token-not-for-production",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://test:test@127.0.0.1:5432/omnimarket_test?schema=public",
    },
  },
});
