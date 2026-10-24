import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decimal, prismaMock, resetPrismaMock, sqlText } from "./helpers/prisma-mock.js";
import { startServer, type TestServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { createApp } = await import("../../src/application.js");
const { isRetryableTransactionError } = await import("../../src/db/transaction.js");
const { HttpError } = await import("../../src/http/errors.js");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const X = id(1), Y = id(2), A = id(3), B = id(4), C = id(5);
const session = { Cookie: "omni_session=owner-token" };
const createdAt = new Date("2026-10-20T12:00:00.000Z");

let server: TestServer;
beforeAll(async () => {
  server = await startServer(createApp());
});
afterAll(async () => server.close());
beforeEach(() => {
  resetPrismaMock();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  prismaMock.session.findUnique.mockResolvedValue({
    id: "s1",
    expires: new Date(Date.now() + 60_000),
    user: { id: OWNER_ID, email: "owner@example.test", name: null, image: null, role: "OPERATOR" },
  });
  // X is PENDING at 0 (version 4), followed by Y; PROCESSING holds A, B, C.
  prismaMock.order.findFirst.mockImplementation(async ({ select }: { select?: unknown }) =>
    select ? { status: "PENDING" } : { id: X, status: "PENDING", position: 0, version: 4, createdAt });
  prismaMock.order.findMany.mockImplementation(async ({ where }: { where: { status: string } }) =>
    where.status === "PENDING"
      ? [{ id: X, position: 0, version: 4 }, { id: Y, position: 1, version: 1 }]
      : [{ id: A, position: 0, version: 1 }, { id: B, position: 1, version: 1 }, { id: C, position: 2, version: 1 }]);
  prismaMock.order.findUniqueOrThrow.mockResolvedValue({ id: X, total: decimal("1.00"), margin: decimal("0.50"), items: [] });
});

function move(body: Record<string, unknown> = { status: "PROCESSING", position: 1, expectedVersion: 4 }) {
  return server.request("PATCH", `/api/orders/${X}/status`, { headers: session, body });
}

function updatedRows(): Array<{ id: string; status: string; position: number }> {
  return prismaMock.order.updateMany.mock.calls.map((call) => {
    const { where, data } = call[0] as { where: { id: string }; data: { status: string; position: number } };
    return { id: where.id, status: data.status, position: data.position };
  });
}

describe("Kanban move", () => {
  it("writes only the cards whose position or status changes", async () => {
    const response = await move();
    expect(response.status).toBe(200);
    // A keeps position 0 in PROCESSING and is no longer rewritten (previously every target card got a new version).
    expect(updatedRows()).toEqual([
      { id: Y, status: "PENDING", position: 0 },
      { id: X, status: "PROCESSING", position: 1 },
      { id: B, status: "PROCESSING", position: 2 },
      { id: C, status: "PROCESSING", position: 3 },
    ]);
  });

  it("reads only id, position and version of the column cards", async () => {
    await move();
    for (const call of prismaMock.order.findMany.mock.calls) {
      expect((call[0] as { select: unknown }).select).toEqual({ id: true, position: true, version: true });
    }
  });

  it("locks both columns in a deterministic order before the fresh version check", async () => {
    prismaMock.order.findFirst.mockImplementation(async ({ select }: { select?: unknown }) =>
      select ? { status: "SHIPPED" } : { id: X, status: "SHIPPED", position: 0, version: 4, createdAt });
    await move({ status: "DELIVERED", position: 0, expectedVersion: 4 });
    const locks = prismaMock.$executeRaw.mock.calls
      .filter((call) => sqlText(call).includes("pg_advisory_xact_lock"))
      .map((call) => (call[0] as { values: string[] }).values[0]);
    expect(locks.slice(0, 2)).toEqual([`board:${OWNER_ID}:DELIVERED`, `board:${OWNER_ID}:SHIPPED`]);
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(prismaMock.order.findFirst.mock.invocationCallOrder[1]!);
  });

  it("retries a serialization/deadlock abort (P2034) and succeeds", async () => {
    prismaMock.$transaction.mockRejectedValueOnce(Object.assign(new Error("Transaction failed due to a write conflict or a deadlock."), { code: "P2034" }));
    const response = await move();
    expect(response.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts", async () => {
    prismaMock.$transaction.mockRejectedValue(Object.assign(new Error("deadlock detected"), { code: "P2034" }));
    const response = await move();
    expect(response.status).toBe(500);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(3);
  });

  it("never retries a stale expectedVersion (409)", async () => {
    const response = await move({ status: "PROCESSING", position: 1, expectedVersion: 3 });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "VERSION_CONFLICT" } });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled();
  });

  it("classifies only database aborts as retryable", () => {
    expect(isRetryableTransactionError({ code: "P2034" })).toBe(true);
    expect(isRetryableTransactionError({ code: "P2010", meta: { code: "40P01" } })).toBe(true);
    expect(isRetryableTransactionError({ code: "P2010", meta: { code: "40001" } })).toBe(true);
    expect(isRetryableTransactionError(new HttpError(409, "VERSION_CONFLICT", "stale"))).toBe(false);
    expect(isRetryableTransactionError({ code: "P2002" })).toBe(false);
  });
});
