import { Prisma } from "@prisma/client";
import type { Prisma as PrismaTypes } from "@prisma/client";

type Transaction = PrismaTypes.TransactionClient;

/** Rebuild one UTC day from order item snapshots so reporting stays consistent. */
export async function refreshSalesMetrics(tx: Transaction, date: Date, isTestData = false): Promise<void> {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "sales_daily_metrics"
    WHERE "day" = ${day}::date AND "is_test_data" = ${isTestData}
  `);
  await tx.$executeRaw(Prisma.sql`
    WITH per_order_category AS (
      SELECT
        (o."created_at" AT TIME ZONE 'UTC')::date AS "day",
        p."category_id",
        o."id" AS "order_id",
        SUM(oi."quantity" * oi."unit_price") AS "revenue",
        SUM(oi."quantity" * (oi."unit_price" - oi."unit_cost")) AS "gross_margin"
      FROM "orders" o
      JOIN "order_items" oi ON oi."order_id" = o."id"
      JOIN "products" p ON p."id" = oi."product_id"
      WHERE (o."created_at" AT TIME ZONE 'UTC')::date = ${day}::date
        AND o."is_test_data" = ${isTestData}
        AND o."status" <> 'CANCELLED'
      GROUP BY (o."created_at" AT TIME ZONE 'UTC')::date, p."category_id", o."id"
    )
    INSERT INTO "sales_daily_metrics"
      ("day", "category_id", "is_test_data", "orders_count", "revenue", "avg_ticket", "gross_margin")
    SELECT
      "day",
      "category_id",
      ${isTestData},
      COUNT(*)::integer,
      SUM("revenue"),
      ROUND(SUM("revenue") / COUNT(*), 2),
      SUM("gross_margin")
    FROM per_order_category
    GROUP BY "day", "category_id"
  `);
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
