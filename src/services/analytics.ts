import { Prisma } from "@prisma/client";
import type { Prisma as PrismaTypes } from "@prisma/client";
import { isTestWorkspace } from "../domain/workspace.js";

type Transaction = PrismaTypes.TransactionClient;

/**
 * Recompute one UTC day of one workspace from order item snapshots, inside the caller's transaction, so reporting
 * stays immediately consistent. Only the given categories are recomputed (all of the day when omitted): rows are
 * upserted and rows whose category no longer has sales that day are removed, instead of deleting and re-inserting
 * the whole day on every mutation. A per-(owner, day) advisory lock makes concurrent writers recompute one after
 * the other, so each one aggregates the previous writer's committed order.
 * Prisma stores `created_at` as a UTC `timestamp without time zone`, and the day is passed as a
 * `YYYY-MM-DD` literal, so no cast here depends on the database session's TimeZone.
 */
export async function refreshSalesMetrics(
  tx: Transaction,
  date: Date,
  ownerId: string,
  categoryIds?: readonly string[],
): Promise<void> {
  const categories = categoryIds === undefined ? undefined : [...new Set(categoryIds)].sort();
  if (categories?.length === 0) return;
  const day = date.toISOString().slice(0, 10);
  const isTestData = isTestWorkspace(ownerId);
  const onlyItems = categories ? Prisma.sql`AND p."category_id" = ANY(${categories}::uuid[])` : Prisma.empty;
  const onlyRows = categories ? Prisma.sql`AND m."category_id" = ANY(${categories}::uuid[])` : Prisma.empty;

  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`metrics:${ownerId}:${day}`}, 0))`);
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "sales_daily_metrics" m
    WHERE m."day" = ${day}::date AND m."owner_id" = ${ownerId}::uuid ${onlyRows}
      AND NOT EXISTS (
        SELECT 1
        FROM "orders" o
        JOIN "order_items" oi ON oi."order_id" = o."id"
        JOIN "products" p ON p."id" = oi."product_id"
        WHERE p."category_id" = m."category_id"
          AND o."created_at" >= ${day}::date::timestamp
          AND o."created_at" < (${day}::date + 1)::timestamp
          AND o."owner_id" = ${ownerId}::uuid
          AND o."status" <> 'CANCELLED'
      )
  `);
  await tx.$executeRaw(Prisma.sql`
    WITH per_order_category AS (
      SELECT
        ${day}::date AS "day",
        p."category_id",
        o."id" AS "order_id",
        SUM(oi."quantity" * oi."unit_price") AS "revenue",
        SUM(oi."quantity" * (oi."unit_price" - oi."unit_cost")) AS "gross_margin"
      FROM "orders" o
      JOIN "order_items" oi ON oi."order_id" = o."id"
      JOIN "products" p ON p."id" = oi."product_id"
      WHERE o."created_at" >= ${day}::date::timestamp
        AND o."created_at" < (${day}::date + 1)::timestamp
        AND o."owner_id" = ${ownerId}::uuid
        AND o."status" <> 'CANCELLED'
        ${onlyItems}
      GROUP BY p."category_id", o."id"
    )
    INSERT INTO "sales_daily_metrics"
      ("day", "owner_id", "category_id", "is_test_data", "orders_count", "revenue", "avg_ticket", "gross_margin")
    SELECT
      "day",
      ${ownerId}::uuid,
      "category_id",
      ${isTestData},
      COUNT(*)::integer,
      SUM("revenue"),
      ROUND(SUM("revenue") / COUNT(*), 2),
      SUM("gross_margin")
    FROM per_order_category
    GROUP BY "day", "category_id"
    ON CONFLICT ("day", "category_id", "is_test_data") DO UPDATE SET
      "owner_id" = EXCLUDED."owner_id",
      "orders_count" = EXCLUDED."orders_count",
      "revenue" = EXCLUDED."revenue",
      "avg_ticket" = EXCLUDED."avg_ticket",
      "gross_margin" = EXCLUDED."gross_margin"
    WHERE ("sales_daily_metrics"."owner_id", "sales_daily_metrics"."orders_count", "sales_daily_metrics"."revenue",
           "sales_daily_metrics"."avg_ticket", "sales_daily_metrics"."gross_margin")
      IS DISTINCT FROM
          (EXCLUDED."owner_id", EXCLUDED."orders_count", EXCLUDED."revenue", EXCLUDED."avg_ticket", EXCLUDED."gross_margin")
  `);
}

/** Categories present in the given orders' lines: the only metric rows a change to those orders can affect. */
export async function orderCategoryIds(tx: Transaction, orderIds: readonly string[]): Promise<string[]> {
  const items = await tx.orderItem.findMany({
    where: { orderId: { in: [...orderIds] } },
    select: { product: { select: { categoryId: true } } },
  });
  return [...new Set(items.map((item) => item.product.categoryId))];
}

/** Metrics exclude only cancelled orders, so other status changes and reorderings leave them untouched. */
export function affectsSalesMetrics(fromStatus: string, toStatus: string): boolean {
  return (fromStatus === "CANCELLED") !== (toStatus === "CANCELLED");
}

export function utcDayBounds(from?: string, to?: string): { gte?: Date; lt?: Date } {
  const where: { gte?: Date; lt?: Date } = {};
  if (from) where.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) {
    const end = new Date(`${to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    where.lt = end;
  }
  return where;
}
