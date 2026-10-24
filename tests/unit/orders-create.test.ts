import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decimal, prismaMock, resetPrismaMock, sqlText } from "./helpers/prisma-mock.js";
import { startServer, type TestServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { createApp } = await import("../../src/application.js");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "00000000-0000-4000-8000-000000000020";
const CATEGORY_ID = "00000000-0000-4000-8000-000000000010";
const session = { Cookie: "omni_session=owner-token" };
const orderBody = {
  customer: { name: "Ana", email: "Ana@Example.test" },
  items: [{ productId: PRODUCT_ID, quantity: 2 }],
};

let server: TestServer;
beforeAll(async () => {
  server = await startServer(createApp());
});
afterAll(async () => server.close());
beforeEach(() => {
  resetPrismaMock();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  prismaMock.session.findUnique.mockResolvedValue({
    id: "s1",
    expires: new Date(Date.now() + 60_000),
    user: { id: OWNER_ID, email: "owner@example.test", name: null, image: null, role: "OPERATOR" },
  });
  prismaMock.product.findMany.mockResolvedValue([
    { id: PRODUCT_ID, categoryId: CATEGORY_ID, price: decimal("120.00"), cost: decimal("45.00") },
  ]);
  prismaMock.customer.create.mockResolvedValue({ id: "c1" });
  prismaMock.order.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "o-new",
    ...data,
    createdAt: new Date("2026-10-24T10:00:00.000Z"),
    total: decimal("240.00"),
    margin: decimal("150.00"),
    items: [],
    history: [],
  }));
});

describe("order creation position", () => {
  it("appends after the highest PENDING position, not after the row count, once a middle card was deleted", async () => {
    // Column was [0,1,2]; position 1 was deleted, so COUNT=2 would collide with the remaining card at 2.
    prismaMock.order.count.mockResolvedValue(2);
    prismaMock.order.aggregate.mockResolvedValue({ _max: { position: 2 } });

    const response = await server.request("POST", "/api/orders", { headers: session, body: orderBody });

    expect(response.status).toBe(201);
    expect(prismaMock.order.create.mock.calls[0]?.[0]).toMatchObject({ data: { position: 3, status: "PENDING", ownerId: OWNER_ID } });
    expect(prismaMock.order.aggregate.mock.calls[0]?.[0]).toEqual({
      where: { status: "PENDING", ownerId: OWNER_ID },
      _max: { position: true },
    });
  });

  it("starts an empty PENDING column at position 0", async () => {
    prismaMock.order.aggregate.mockResolvedValue({ _max: { position: null } });
    await server.request("POST", "/api/orders", { headers: session, body: orderBody });
    expect(prismaMock.order.create.mock.calls[0]?.[0]).toMatchObject({ data: { position: 0 } });
  });

  it("takes the PENDING column lock inside the transaction before reading the maximum", async () => {
    prismaMock.order.aggregate.mockResolvedValue({ _max: { position: 0 } });
    await server.request("POST", "/api/orders", { headers: session, body: orderBody });

    const lockCall = prismaMock.$executeRaw.mock.calls.findIndex((call) => sqlText(call).includes("pg_advisory_xact_lock"));
    expect(lockCall).toBeGreaterThanOrEqual(0);
    expect(prismaMock.$executeRaw.mock.calls[lockCall]?.[0]).toMatchObject({ values: [`board:${OWNER_ID}:PENDING`] });
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[lockCall]!)
      .toBeLessThan(prismaMock.order.aggregate.mock.invocationCallOrder[0]!);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });
});
