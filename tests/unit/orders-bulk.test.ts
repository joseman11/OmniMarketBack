import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock, resetPrismaMock } from "./helpers/prisma-mock.js";
import { startServer, type TestServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { createApp } = await import("../../src/application.js");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
  prismaMock.session.findUnique.mockResolvedValue({
    id: "s1",
    expires: new Date(Date.now() + 60_000),
    user: { id: OWNER_ID, email: "owner@example.test", name: null, image: null, role: "OPERATOR" },
  });
});

const bulk = (ids: string[]) => server.request("PATCH", "/api/orders/bulk", { headers: session, body: { ids, status: "SHIPPED" } });

describe("bulk status update", () => {
  it("accepts exactly 100 distinct IDs", async () => {
    const ids = Array.from({ length: 100 }, (_, n) => uuid(n + 1));
    prismaMock.order.findMany.mockResolvedValueOnce(ids.map((id, position) => ({ id, status: "SHIPPED", position, version: 1, createdAt })));
    const response = await bulk(ids);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updatedCount: 0, ids: [] });
  });

  it("rejects 101 IDs before touching the database", async () => {
    const response = await bulk(Array.from({ length: 101 }, (_, n) => uuid(n + 1)));
    expect(response.status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("rejects duplicated IDs", async () => {
    const response = await bulk([uuid(1), uuid(1)]);
    expect(response.status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("is all-or-nothing: one missing order aborts before any write", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([{ id: uuid(1), status: "PENDING", position: 0, version: 1, createdAt }]);
    const response = await bulk([uuid(1), uuid(2)]);
    expect(response.status).toBe(404);
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it("aborts the whole transaction with 409 when any order changed concurrently", async () => {
    prismaMock.order.findMany
      .mockResolvedValueOnce([
        { id: uuid(1), status: "PENDING", position: 0, version: 1, createdAt },
        { id: uuid(2), status: "PENDING", position: 1, version: 1, createdAt },
      ])
      .mockResolvedValue([]);
    prismaMock.order.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const response = await bulk([uuid(1), uuid(2)]);
    expect(response.status).toBe(409);
    // The error escapes the interactive transaction, so Prisma rolls back the first update as well.
    await expect(prismaMock.$transaction.mock.results[0]!.value).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(prismaMock.orderStatusHistory.create).not.toHaveBeenCalled();
  });
});
