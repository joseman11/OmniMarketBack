import { Prisma } from "@prisma/client";
import type { Prisma as PrismaTypes } from "@prisma/client";
import { isTestWorkspace } from "../domain/workspace.js";

type Transaction = PrismaTypes.TransactionClient;

/**
 * Rebuild one UTC day of one workspace from order item snapshots so reporting stays consistent.
 * Prisma stores `created_at` as a UTC `timestamp without time zone`, and the day is passed as a
 * `YYYY-MM-DD` literal, so no cast here depends on the database session's TimeZone.
 */
export async function refreshSalesMetrics(tx: Transaction, date: Date, ownerId: string): Promise<void> {
  const day = date.toISOString().slice(0, 10);
  const isTestData = isTestWorkspace(ownerId);
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "sales_daily_metrics"
    WHERE "day" = ${day}::date AND "owner_id" = ${ownerId}::uuid
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
