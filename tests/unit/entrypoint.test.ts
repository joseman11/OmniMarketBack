import { describe, expect, it, vi } from "vitest";
import { startServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

describe("Vercel entrypoint", () => {
  it("default-exports an Express app that serves /api/*", async () => {
    const { default: app } = await import("../../src/app.js");
    expect(typeof app).toBe("function");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await startServer(app);
    try {
      const health = await server.request("GET", "/api/health");
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: "ok", service: "omnimarket-api" });
      const missing = await server.request("GET", "/api/does-not-exist");
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
