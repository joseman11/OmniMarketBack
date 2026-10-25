import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { ensureStarterData, STARTER_ORDER_PREFIX } from "../../src/services/onboarding.js";

const token = process.env.TEST_API_TOKEN ?? "local-e2e-token-not-for-production";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://test:test@127.0.0.1:5432/omnimarket_test?schema=public" } },
});
test.afterAll(async () => prisma.$disconnect());

async function workspaceCounts(ownerId: string) {
  const owned = { where: { ownerId } };
  const [categories, products, orders, metrics] = await Promise.all([
    prisma.category.count(owned), prisma.product.count(owned), prisma.order.count(owned), prisma.salesDailyMetric.count(owned),
  ]);
  return { categories, products, orders, metrics };
}

test.describe("starter workspace against PostgreSQL", () => {
  let ownerId: string;
  test.beforeEach(async () => {
    ownerId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, email: `starter-${ownerId}@example.test` } });
  });
  test.afterEach(async () => {
    const owned = { where: { ownerId } };
    await prisma.order.deleteMany(owned);
    await prisma.salesDailyMetric.deleteMany(owned);
    await prisma.product.deleteMany(owned);
    await prisma.category.deleteMany(owned);
    await prisma.customer.deleteMany(owned);
    await prisma.user.delete({ where: { id: ownerId } });
  });

  test("two simultaneous first reads seed the account exactly once", async () => {
    const results = await Promise.all([ensureStarterData(ownerId, prisma), ensureStarterData(ownerId, prisma)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await workspaceCounts(ownerId)).toMatchObject({ categories: 2, products: 2, orders: 3 });

    const orders = await prisma.order.findMany({ where: { ownerId }, include: { history: true } });
    expect(orders.every((order) => order.orderNumber.startsWith(STARTER_ORDER_PREFIX) && !order.isTestData)).toBe(true);
    expect(new Set(orders.map((order) => `${order.status}:${order.position}`)).size).toBe(3);
    expect(orders.map((order) => order.history.length).sort()).toEqual([1, 2, 3]);
    expect((await workspaceCounts(ownerId)).metrics).toBeGreaterThan(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).onboardedAt).not.toBeNull();
  });

  test("a second call does not duplicate, and an emptied workspace is not seeded again", async () => {
    expect(await ensureStarterData(ownerId, prisma)).toBe(true);
    expect(await ensureStarterData(ownerId, prisma)).toBe(false);
    expect(await workspaceCounts(ownerId)).toMatchObject({ categories: 2, products: 2, orders: 3 });

    await prisma.order.deleteMany({ where: { ownerId } });
    await prisma.product.deleteMany({ where: { ownerId } });
    await prisma.category.deleteMany({ where: { ownerId } });
    expect(await ensureStarterData(ownerId, prisma)).toBe(false);
    expect(await workspaceCounts(ownerId)).toMatchObject({ categories: 0, products: 0, orders: 0 });
  });

  test("resetting the audit fixtures leaves the starter orders untouched", async ({ request }) => {
    await ensureStarterData(ownerId, prisma);
    const reset = await request.post("/api/test/reset-data", { headers: { Authorization: `Bearer ${token}` } });
    expect(reset.ok()).toBeTruthy();
    expect(await workspaceCounts(ownerId)).toMatchObject({ categories: 2, products: 2, orders: 3 });
  });
});
