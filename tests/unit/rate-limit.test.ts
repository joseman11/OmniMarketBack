import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { decimal, prismaMock, resetPrismaMock } from "./helpers/prisma-mock.js";
import { startServer, type TestServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { createApp } = await import("../../src/application.js");
const { createRateLimiter, RATE_LIMITS } = await import("../../src/http/rate-limit.js");
const { HttpError } = await import("../../src/http/errors.js");

function fakeExchange(ip: string, method = "GET") {
  const headers = new Map<string, string>();
  const response = { setHeader: (name: string, value: string) => headers.set(name, value), getHeader: (name: string) => headers.get(name) };
  return { request: { ip, method } as Request, response: response as unknown as Response, headers };
}

beforeEach(() => {
  resetPrismaMock();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("in-memory rate limiter", () => {
  it("allows up to the limit per client, then answers 429 with Retry-After until the window resets", () => {
    let time = 1_000;
    const limiter = createRateLimiter({ id: "t", windowMs: 60_000, max: 2 }, () => time);
    const results: unknown[] = [];
    const next = ((error?: unknown) => results.push(error)) as NextFunction;
    const a = fakeExchange("203.0.113.1");
    limiter(a.request, a.response, next);
    limiter(a.request, a.response, next);
    limiter(a.request, a.response, next);
    expect(results.slice(0, 2)).toEqual([undefined, undefined]);
    expect(results[2]).toBeInstanceOf(HttpError);
    expect(results[2]).toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(a.headers.get("Retry-After")).toBe("60");

    const b = fakeExchange("203.0.113.2");
    limiter(b.request, b.response, next);
    expect(results[3]).toBeUndefined();

    time += 60_000;
    limiter(a.request, a.response, next);
    expect(results[4]).toBeUndefined();
  });

  it("ignores methods outside the policy", () => {
    const limiter = createRateLimiter({ id: "t", windowMs: 60_000, max: 0, methods: ["POST"] });
    const calls: unknown[] = [];
    const get = fakeExchange("203.0.113.1", "GET");
    limiter(get.request, get.response, ((error?: unknown) => calls.push(error)) as NextFunction);
    expect(calls).toEqual([undefined]);
  });

  it("documents generous limits for the evaluator", () => {
    expect(RATE_LIMITS.audit.max).toBeGreaterThanOrEqual(600);
    expect(RATE_LIMITS.auditReset.max).toBeGreaterThanOrEqual(30);
  });
});

describe("rate limits in the application", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(createApp());
  });
  afterAll(async () => server.close());

  it("serves a burst of audit reads without throttling and returns the public 429 format past the limit", async () => {
    prismaMock.salesDailyMetric.findMany.mockResolvedValue([]);
    prismaMock.order.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { total: decimal("0.00"), margin: decimal("0.00") } });
    const first = await server.request("GET", "/api/test/analytics");
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-limit")).toBe(String(RATE_LIMITS.audit.max));

    for (let n = 0; n < RATE_LIMITS.auditReset.max; n += 1) await server.request("POST", "/api/test/reset-data");
    const throttled = await server.request("POST", "/api/test/reset-data");
    expect(throttled.status).toBe(429);
    expect(throttled.body).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests; retry later." } });
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);

    // The read endpoints of the same client keep working.
    expect((await server.request("GET", "/api/test/analytics")).status).toBe(200);
  });
});
