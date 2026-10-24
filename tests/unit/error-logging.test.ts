import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock, resetPrismaMock } from "./helpers/prisma-mock.js";
import { startServer, type TestServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { createApp } = await import("../../src/application.js");
const { normalizeRoute, sanitize } = await import("../../src/http/logger.js");

let server: TestServer;
beforeAll(async () => {
  server = await startServer(createApp());
});
afterAll(async () => server.close());
beforeEach(() => {
  resetPrismaMock();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

function errorLogs(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((entry) => entry.event === "http.request.failed");
}

describe("internal error logging", () => {
  it("logs a sanitized structured 500 while the client receives only the public error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    prismaMock.$queryRaw.mockRejectedValue(new Error(
      "Can't reach database at postgresql://admin:s3cr3t@db.internal:5432/omni; header Bearer abc.def.ghi",
    ));

    const response = await server.request("GET", "/api/health?code=oauth-code&state=oauth-state", {
      headers: { Cookie: "omni_session=session-secret", Authorization: "Bearer caller-secret", "X-Request-Id": "req-12345678" },
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
    expect(response.headers.get("x-request-id")).toBe("req-12345678");

    const [entry] = errorLogs(errorSpy);
    expect(entry).toMatchObject({
      level: "error",
      request_id: "req-12345678",
      method: "GET",
      route: "/api/health",
      status_code: 500,
      error_code: "INTERNAL_ERROR",
      error_name: "Error",
    });
    expect(typeof entry?.timestamp).toBe("string");
    expect(String(entry?.stack)).toMatch(/^at /);
    const serialized = JSON.stringify(errorSpy.mock.calls);
    for (const secret of ["s3cr3t", "postgresql://", "abc.def.ghi", "session-secret", "caller-secret", "oauth-code", "oauth-state"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps only the cause line of Prisma invocation errors, which embed request data", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prismaError = new Error("\nInvalid `prisma.order.create()` invocation:\n\n{ data: { email: \"ana@example.test\" } }\n\nTimed out fetching a new connection from the connection pool.");
    prismaError.name = "PrismaClientKnownRequestError";
    Object.assign(prismaError, { code: "P2024" });
    prismaMock.$queryRaw.mockRejectedValue(prismaError);

    await server.request("GET", "/api/health");

    const [entry] = errorLogs(errorSpy);
    expect(entry).toMatchObject({
      error_name: "PrismaClientKnownRequestError",
      error_cause_code: "P2024",
      error_message: "Timed out fetching a new connection from the connection pool.",
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("ana@example.test");
  });

  it("does not log handled client errors as internal errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await server.request("GET", "/api/orders");
    expect(errorLogs(errorSpy)).toHaveLength(0);
  });

  it("generates a request id when the caller sends none or a malformed one", async () => {
    const response = await server.request("GET", "/api/health", { headers: { "X-Request-Id": "bad id\twith spaces" } });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("normalizes routes and redacts OAuth parameters", () => {
    expect(normalizeRoute("/api/orders/00000000-0000-4000-8000-000000000030/status?x=1")).toBe("/api/orders/:id/status");
    expect(normalizeRoute("/api/auth/google/callback?code=abc&state=def")).toBe("/api/auth/google/callback");
    expect(sanitize("redirect?code=abc&state=def&code_verifier=ghi")).toBe("redirect?code=[redacted]&state=[redacted]&code_verifier=[redacted]");
  });
});
