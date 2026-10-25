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
  const metricWhere = Prisma.sql`
    WHERE m."owner_id" = ${ownerId}::uuid
      ${metricFrom}
      ${metricTo}
      ${metricCategory}
  `;
  const orderFrom = query.from ? Prisma.sql`AND o."created_at" >= ${query.from}::date::timestamp` : Prisma.empty;
  const orderTo = query.to ? Prisma.sql`AND o."created_at" < (${query.to}::date + 1)::timestamp` : Prisma.empty;
  const summaryQuery = query.categoryId
    ? Prisma.sql`
        summary AS (
          SELECT
            COALESCE(SUM(m."orders_count"), 0)::int AS "ordersCount",
            COALESCE(SUM(m."revenue"), 0)::text AS "revenue",
            COALESCE(SUM(m."gross_margin"), 0)::text AS "grossMargin"
          FROM "sales_daily_metrics" m
          ${metricWhere}
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

  // Keep every result in one PostgreSQL round trip. Select the requested metric page before joining category labels,
  // so PostgreSQL can use the owner/day/category ordering index without sorting or joining every result row.
  // Count and category summary scan metrics independently. The unfiltered summary still aggregates whole orders
  // (so a multi-category order is counted once).
  const [result] = await prisma.$queryRaw<AnalyticsSqlResult[]>(Prisma.sql`
    WITH page_metrics AS (
      SELECT
        m."day",
        m."category_id" AS "categoryId",
        m."orders_count" AS "ordersCount",
        m."revenue",
        m."avg_ticket" AS "avgTicket",
        m."gross_margin" AS "grossMargin"
      FROM "sales_daily_metrics" m
      ${metricWhere}
      ORDER BY m."day" DESC, m."category_id" ASC
      OFFSET ${(query.page - 1) * query.limit}
      LIMIT ${query.limit}
    ),
    page_rows AS (
      SELECT
        pm.*,
        c."name" AS "categoryName",
        c."slug" AS "categorySlug"
      FROM page_metrics pm
      JOIN "categories" c ON c."id" = pm."categoryId"
    ),
    row_count AS (
      SELECT COUNT(*)::int AS "total"
      FROM "sales_daily_metrics" m
      ${metricWhere}
    ),
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
