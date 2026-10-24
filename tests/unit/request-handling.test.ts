import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPrismaMock } from "./helpers/prisma-mock.js";
import { startServer, type TestServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { createApp } = await import("../../src/application.js");
const { errorResponse } = await import("../../src/http/errors.js");

let server: TestServer;
beforeAll(async () => {
  server = await startServer(createApp());
});
afterAll(async () => server.close());
beforeEach(() => {
  resetPrismaMock();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function logged(spy: ReturnType<typeof vi.spyOn>, event: string): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

describe("request body errors", () => {
  it("answers 400 instead of 500 for malformed JSON", async () => {
    const response = await server.request("POST", "/api/test/reset-data", { rawBody: "{\"broken\":" });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: "INVALID_JSON", message: "The request body is not valid JSON." } });
  });

  it("answers 413 instead of 500 for a body above 1 MB", async () => {
    const response = await server.request("POST", "/api/test/reset-data", { rawBody: JSON.stringify({ pad: "x".repeat(1_100_000) }) });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("maps other exposable body-parser client errors to their status", () => {
    expect(errorResponse({ type: "encoding.unsupported", status: 415, expose: true }).status).toBe(415);
    expect(errorResponse({ status: 418, expose: false }).status).toBe(500);
  });
});

describe("request logging", () => {
  it("logs request id, normalized route, status and duration for every request", async () => {
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await server.request("GET", "/api/health?token=hidden");
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(logged(infoSpy, "http.request.completed")).toHaveLength(1));
    const [entry] = logged(infoSpy, "http.request.completed");
    expect(entry).toMatchObject({
      request_id: response.headers.get("x-request-id"),
      method: "GET",
      route: "/api/health",
      status_code: 200,
      outcome: "success",
    });
    expect(typeof entry?.duration_ms).toBe("number");
    expect(JSON.stringify(entry)).not.toContain("hidden");
  });
});
