import { Router } from "express";
import { prisma } from "../db/prisma.js";
import { analyticsQuerySchema, kanbanStatusQuerySchema } from "../domain/validation.js";
import { averageCents, fromCents, toCents } from "../domain/money.js";
import { HttpError } from "../http/errors.js";
import { parseOrThrow } from "../http/validation.js";
import { utcDayBounds } from "../services/analytics.js";
import { TEST_ADMIN_ID } from "../domain/workspace.js";

export const analyticsRouter = Router();

export async function loadAnalytics(input: unknown, ownerId: string) {
  const query = parseOrThrow(analyticsQuerySchema, input);
  const bounds = utcDayBounds(query.from, query.to);
  const metricWhere = {
    ownerId,
    ...(Object.keys(bounds).length ? { day: bounds } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
  };
  const orderWhere = {
    status: { not: "CANCELLED" as const },
    ownerId,
    ...(Object.keys(bounds).length ? { createdAt: bounds } : {}),
    ...(query.categoryId ? { items: { some: { product: { categoryId: query.categoryId } } } } : {}),
  };

  const [items, total, summary] = await Promise.all([
    prisma.salesDailyMetric.findMany({
      where: metricWhere,
      include: { category: { select: { id: true, name: true, slug: true } } },
      orderBy: [{ day: "desc" }, { categoryId: "asc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.salesDailyMetric.count({ where: metricWhere }),
    prisma.order.aggregate({
      where: orderWhere,
      _count: { _all: true },
      _sum: { total: true, margin: true },
    }),
  ]);

  const revenue = summary._sum.total?.toFixed(2) ?? "0.00";
  const grossMargin = summary._sum.margin?.toFixed(2) ?? "0.00";
  const orderCount = summary._count._all;
  const avgTicket = orderCount === 0
    ? "0.00"
    : fromCents(averageCents(toCents(revenue), orderCount));

  return {
    summary: { ordersCount: orderCount, revenue, avgTicket, grossMargin },
    items: items.map((item) => ({
      day: item.day.toISOString().slice(0, 10),
      category: item.category,
      ordersCount: item.ordersCount,
      revenue: item.revenue.toFixed(2),
      avgTicket: item.avgTicket.toFixed(2),
      grossMargin: item.grossMargin.toFixed(2),
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
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
