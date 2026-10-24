import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const token = process.env.TEST_API_TOKEN ?? "local-e2e-token-not-for-production";
const TEST_ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const MUG_ID = "00000000-0000-4000-8000-000000000020";
const TABLET_ID = "00000000-0000-4000-8000-000000000021";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://test:test@127.0.0.1:5432/omnimarket_test?schema=public" } },
});
test.afterAll(async () => prisma.$disconnect());

type MetricRow = { day: string; category_id: string; orders_count: number; revenue: string; avg_ticket: string; gross_margin: string };

/** The pre-K2 algorithm (full rebuild of every day from order lines) as a read-only query: the expected table. */
async function legacyRebuild(): Promise<MetricRow[]> {
  return prisma.$queryRaw<MetricRow[]>`
    WITH per_order_category AS (
      SELECT (o."created_at")::date AS "day", p."category_id", o."id" AS "order_id",
        SUM(oi."quantity" * oi."unit_price") AS "revenue",
        SUM(oi."quantity" * (oi."unit_price" - oi."unit_cost")) AS "gross_margin"
      FROM "orders" o
      JOIN "order_items" oi ON oi."order_id" = o."id"
      JOIN "products" p ON p."id" = oi."product_id"
      WHERE o."owner_id" = ${TEST_ADMIN_ID}::uuid AND o."status" <> 'CANCELLED'
      GROUP BY 1, p."category_id", o."id"
    )
    SELECT "day"::text AS "day", "category_id"::text AS "category_id", COUNT(*)::integer AS "orders_count",
      SUM("revenue")::text AS "revenue", ROUND(SUM("revenue") / COUNT(*), 2)::text AS "avg_ticket",
      SUM("gross_margin")::text AS "gross_margin"
    FROM per_order_category GROUP BY "day", "category_id" ORDER BY 1, 2`;
}

async function storedMetrics(): Promise<MetricRow[]> {
  return prisma.$queryRaw<MetricRow[]>`
    SELECT "day"::text AS "day", "category_id"::text AS "category_id", "orders_count", "revenue"::text AS "revenue",
      "avg_ticket"::text AS "avg_ticket", "gross_margin"::text AS "gross_margin"
    FROM "sales_daily_metrics" WHERE "owner_id" = ${TEST_ADMIN_ID}::uuid ORDER BY 1, 2`;
}

test("incremental metrics equal a full rebuild after every kind of mutation", async ({ request }) => {
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  expect((await request.post("/api/test/reset-data", auth)).ok()).toBeTruthy();
  expect((await request.post("/api/auth/test/session", auth)).ok()).toBeTruthy();
  expect(await storedMetrics()).toEqual(await legacyRebuild());

  const order = async (items: Array<{ productId: string; quantity: number }>, email: string) =>
    (await (await request.post("/api/orders", { data: { customer: { name: "Métricas", email }, items } })).json()).item as {
      id: string; version: number;
    };
  const a = await order([{ productId: MUG_ID, quantity: 3 }], "m1@example.test");
  const b = await order([{ productId: MUG_ID, quantity: 1 }, { productId: TABLET_ID, quantity: 2 }], "m2@example.test");
  const c = await order([{ productId: TABLET_ID, quantity: 1 }], "m3@example.test");
  expect(await storedMetrics()).toEqual(await legacyRebuild());

  // Cancelling removes a category row when it was the only sale; moving back restores it.
  let moved = await request.patch(`/api/orders/${c.id}/status`, { data: { status: "CANCELLED", position: 0, expectedVersion: c.version } });
  expect(moved.ok()).toBeTruthy();
  expect(await storedMetrics()).toEqual(await legacyRebuild());
  const cVersion = (await moved.json()).item.version as number;
  moved = await request.patch(`/api/orders/${c.id}/status`, { data: { status: "PROCESSING", position: 0, expectedVersion: cVersion } });
  expect(moved.ok()).toBeTruthy();
  expect(await storedMetrics()).toEqual(await legacyRebuild());

  const edited = await request.patch(`/api/orders/${b.id}`, { data: { expectedVersion: b.version, items: [{ productId: MUG_ID, quantity: 5 }] } });
  expect(edited.ok()).toBeTruthy();
  expect(await storedMetrics()).toEqual(await legacyRebuild());

  const bulk = await request.patch("/api/orders/bulk", {
    data: { ids: [a.id, "00000000-0000-4000-8000-000000000031"], status: "CANCELLED" },
  });
  expect(bulk.ok()).toBeTruthy();
  expect(await storedMetrics()).toEqual(await legacyRebuild());

  expect((await request.delete(`/api/orders/${b.id}`)).status()).toBe(204);
  expect(await storedMetrics()).toEqual(await legacyRebuild());

  expect((await request.post("/api/test/reset-data", auth)).ok()).toBeTruthy();
  expect(await storedMetrics()).toEqual(await legacyRebuild());
});
