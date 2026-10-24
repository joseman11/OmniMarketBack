import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    env: {
      NODE_ENV: "test",
      // Never reached: application tests replace the Prisma singleton with an in-memory mock.
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
    },
  },
});
