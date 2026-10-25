import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock, resetPrismaMock } from "./helpers/prisma-mock.js";
import { startServer, type TestServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { createApp } = await import("../../src/application.js");
const { ensureStarterData, STARTER_ORDER_PREFIX } = await import("../../src/services/onboarding.js");
const { TEST_ADMIN_ID } = await import("../../src/domain/workspace.js");

const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const session = { Cookie: "omni_session=new-account" };
type PrismaClientArg = Parameters<typeof ensureStarterData>[1];

let server: TestServer;
beforeAll(async () => {
  server = await startServer(createApp());
});
afterAll(async () => server.close());
beforeEach(() => {
  resetPrismaMock();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  prismaMock.customer.create.mockImplementation(async ({ data }: { data: { email: string } }) => ({ id: `c-${data.email}` }));
});

function signInAs(onboardedAt: Date | null) {
  prismaMock.session.findUnique.mockResolvedValue({
    id: "s1",
    expires: new Date(Date.now() + 60_000),
    user: { id: OWNER_ID, email: "nuevo@example.test", name: null, image: null, role: "OPERATOR", onboardedAt },
  });
}

describe("starter workspace for a new account", () => {
  it("seeds 2 categories, 2 active products and 3 orders with valid positions and history, claiming the account", async () => {
    expect(await ensureStarterData(OWNER_ID)).toBe(true);

    expect(prismaMock.user.updateMany).toHaveBeenCalledWith({
      where: { id: OWNER_ID, onboardedAt: null },
      data: { onboardedAt: expect.any(Date) },
    });
    const categories = prismaMock.category.createMany.mock.calls[0]![0].data as Array<{ ownerId: string }>;
    const products = prismaMock.product.createMany.mock.calls[0]![0].data as Array<{ ownerId: string; isActive: boolean }>;
    expect(categories).toHaveLength(2);
    expect(products).toHaveLength(2);
    expect(products.every((product) => product.isActive && product.ownerId === OWNER_ID)).toBe(true);

    const orders = prismaMock.order.create.mock.calls.map((call) => call[0].data as {
      orderNumber: string; status: string; position: number; isTestData?: boolean;
      history: { create: Array<{ fromStatus: string | null; toStatus: string }> };
    });
    expect(orders.map((order) => order.status)).toEqual(["PENDING", "PROCESSING", "SHIPPED"]);
    expect(orders.every((order) => order.position === 0)).toBe(true);
    // Never mistaken for the audit fixtures: not test data and not an OM-TEST- number.
    expect(orders.every((order) => order.orderNumber.startsWith(STARTER_ORDER_PREFIX) && !order.isTestData)).toBe(true);
    expect(orders[2]!.history.create).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: "PENDING" }),
      expect.objectContaining({ fromStatus: "PENDING", toStatus: "PROCESSING" }),
      expect.objectContaining({ fromStatus: "PROCESSING", toStatus: "SHIPPED" }),
    ]);
    // Metrics for the seeded days are recomputed in the same transaction.
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
  });

  it("does not seed again once the account is marked, even with an empty workspace", async () => {
    prismaMock.user.updateMany.mockResolvedValue({ count: 0 });
    expect(await ensureStarterData(OWNER_ID)).toBe(false);
    expect(prismaMock.category.createMany).not.toHaveBeenCalled();
    expect(prismaMock.order.create).not.toHaveBeenCalled();
  });

  it("only marks an account that already has its own data", async () => {
    prismaMock.product.count.mockResolvedValue(1);
    expect(await ensureStarterData(OWNER_ID)).toBe(false);
    expect(prismaMock.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.category.createMany).not.toHaveBeenCalled();
  });

  it("never seeds the audit fixture workspace", async () => {
    expect(await ensureStarterData(TEST_ADMIN_ID)).toBe(false);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("seeds once when two reads race: only the call that wins the claim creates rows", async () => {
    // PostgreSQL row lock semantics: the second UPDATE ... WHERE onboarded_at IS NULL matches nothing after the first commits.
    let claimed = false;
    prismaMock.user.updateMany.mockImplementation(async () => {
      const count = claimed ? 0 : 1;
      claimed = true;
      return { count };
    });
    const results = await Promise.all([ensureStarterData(OWNER_ID), ensureStarterData(OWNER_ID)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(prismaMock.category.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.order.create).toHaveBeenCalledTimes(3);
  });

  it("uses the client it is given", async () => {
    const other = { $transaction: vi.fn().mockResolvedValue(false) };
    expect(await ensureStarterData(OWNER_ID, other as unknown as PrismaClientArg)).toBe(false);
    expect(other.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe("lazy onboarding on authenticated reads", () => {
  it("seeds on the first catalog read of an unmarked account", async () => {
    signInAs(null);
    const response = await server.request("GET", "/api/categories", { headers: session });
    expect(response.status).toBe(200);
    expect(prismaMock.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.category.createMany).toHaveBeenCalledTimes(1);
  });

  it("skips onboarding entirely for a marked account", async () => {
    signInAs(new Date("2026-10-25T00:00:00.000Z"));
    prismaMock.$queryRaw.mockResolvedValue([{ total: 0, items: [], ordersCount: 0, revenue: null, grossMargin: null }]);
    for (const path of ["/api/categories", "/api/products", "/api/orders", "/api/analytics"]) {
      expect((await server.request("GET", path, { headers: session })).status).toBe(200);
    }
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
  });

  it("does not seed on writes, so a first POST is not polluted with sample rows", async () => {
    signInAs(null);
    prismaMock.category.create.mockResolvedValue({ id: "cat-1", name: "Mía", slug: "mia" });
    const response = await server.request("POST", "/api/categories", { headers: session, body: { name: "Mía", slug: "mia" } });
    expect(response.status).toBe(201);
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
  });

  it("does not seed anonymous audit reads", async () => {
    await server.request("GET", "/api/test/analytics?page=1&limit=50");
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
  });
});
