import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { analyticsQuerySchema, kanbanStatusQuerySchema } from "../domain/validation.js";
import { aggregateToCents, averageCents, fromCents } from "../domain/money.js";
import { HttpError } from "../http/errors.js";
import { parseOrThrow } from "../http/validation.js";
import { TEST_ADMIN_ID } from "../domain/workspace.js";

export const analyticsRouter = Router();

type AnalyticsSqlItem = {
  day: string;
  category: { id: string; name: string; slug: string };
  ordersCount: number;
  revenue: string;
  avgTicket: string;
  grossMargin: string;
};

type AnalyticsSqlResult = {
  total: number;
  items: AnalyticsSqlItem[];
  ordersCount: number;
  revenue: string | null;
  grossMargin: string | null;
};

export async function loadAnalytics(input: unknown, ownerId: string) {
  const query = parseOrThrow(analyticsQuerySchema, input);
  const metricFrom = query.from ? Prisma.sql`AND m."day" >= ${query.from}::date` : Prisma.empty;
  const metricTo = query.to ? Prisma.sql`AND m."day" < (${query.to}::date + 1)` : Prisma.empty;
  const metricCategory = query.categoryId ? Prisma.sql`AND m."category_id" = ${query.categoryId}::uuid` : Prisma.empty;
  const orderFrom = query.from ? Prisma.sql`AND o."created_at" >= ${query.from}::date::timestamp` : Prisma.empty;
  const orderTo = query.to ? Prisma.sql`AND o."created_at" < (${query.to}::date + 1)::timestamp` : Prisma.empty;
  const summaryQuery = query.categoryId
    ? Prisma.sql`
        summary AS (
          SELECT
            COALESCE(SUM("ordersCount"), 0)::int AS "ordersCount",
            COALESCE(SUM("revenue"), 0)::text AS "revenue",
            COALESCE(SUM("grossMargin"), 0)::text AS "grossMargin"
          FROM metric_rows
        )`
    : Prisma.sql`
        summary AS (
          SELECT
            COUNT(*)::int AS "ordersCount",
            COALESCE(SUM(o."total"), 0)::text AS "revenue",
            COALESCE(SUM(o."margin"), 0)::text AS "grossMargin"
          FROM "orders" o
          WHERE o."owner_id" = ${ownerId}::uuid
            AND o."status" <> 'CANCELLED'
            ${orderFrom}
            ${orderTo}
        )`;

  // Metrics, count, and summary share one PostgreSQL round trip. The unfiltered summary still aggregates whole
  // orders (so a multi-category order is counted once); a category-filtered summary uses only that category's lines.
  const [result] = await prisma.$queryRaw<AnalyticsSqlResult[]>(Prisma.sql`
    WITH metric_rows AS MATERIALIZED (
      SELECT
        m."day",
        m."category_id" AS "categoryId",
        m."orders_count" AS "ordersCount",
        m."revenue",
        m."avg_ticket" AS "avgTicket",
        m."gross_margin" AS "grossMargin",
        c."name" AS "categoryName",
        c."slug" AS "categorySlug"
      FROM "sales_daily_metrics" m
      JOIN "categories" c ON c."id" = m."category_id"
      WHERE m."owner_id" = ${ownerId}::uuid
        ${metricFrom}
        ${metricTo}
        ${metricCategory}
    ),
    page_rows AS (
      SELECT * FROM metric_rows
      ORDER BY "day" DESC, "categoryId" ASC
      OFFSET ${(query.page - 1) * query.limit}
      LIMIT ${query.limit}
    ),
    row_count AS (SELECT COUNT(*)::int AS "total" FROM metric_rows),
    ${summaryQuery},
    page_items AS (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'day', to_char("day", 'YYYY-MM-DD'),
            'category', jsonb_build_object('id', "categoryId"::text, 'name', "categoryName", 'slug', "categorySlug"),
            'ordersCount', "ordersCount",
            'revenue', "revenue"::text,
            'avgTicket', "avgTicket"::text,
            'grossMargin', "grossMargin"::text
          ) ORDER BY "day" DESC, "categoryId" ASC
        ),
        '[]'::jsonb
      ) AS "items"
      FROM page_rows
    )
    SELECT row_count."total", page_items."items", summary."ordersCount", summary."revenue", summary."grossMargin"
    FROM row_count CROSS JOIN page_items CROSS JOIN summary
  `);

  if (!result) throw new Error("Analytics query returned no result row.");
  const revenue = new Prisma.Decimal(result.revenue ?? "0").toFixed(2);
  const grossMargin = new Prisma.Decimal(result.grossMargin ?? "0").toFixed(2);
  const orderCount = result.ordersCount;
  const avgTicket = orderCount === 0
    ? "0.00"
    : fromCents(averageCents(aggregateToCents(revenue), orderCount));

  return {
    summary: { ordersCount: orderCount, revenue, avgTicket, grossMargin },
    items: result.items.map((item) => ({
      day: item.day,
      category: item.category,
      ordersCount: item.ordersCount,
      revenue: new Prisma.Decimal(item.revenue).toFixed(2),
      avgTicket: new Prisma.Decimal(item.avgTicket).toFixed(2),
      grossMargin: new Prisma.Decimal(item.grossMargin).toFixed(2),
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total: result.total,
      totalPages: Math.ceil(result.total / query.limit),
    },
  };
}

analyticsRouter.get("/", async (request, response) => {
  response.json(await loadAnalytics(request.query, request.authUser!.id));
});

/** Audit lookup; defaults to the test administrator's workspace where the fixtures live. */
export async function loadKanbanStatus(input: unknown, ownerId = TEST_ADMIN_ID) {
  const query = parseOrThrow(kanbanStatusQuerySchema, input);
  const order = await prisma.order.findFirst({
    where: query.orderId
      ? { id: query.orderId, ownerId }
      : { orderNumber: query.orderNumber!, ownerId },
    select: { id: true, orderNumber: true, status: true, position: true, version: true, updatedAt: true },
  });
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
  return order;
}
