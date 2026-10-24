import { randomBytes } from "node:crypto";
import { Router } from "express";
import { Prisma, type OrderStatus } from "@prisma/client";
import { z } from "zod";
import { lockBoardColumns } from "../db/locks.js";
import { prisma } from "../db/prisma.js";
import { withTransactionRetry } from "../db/transaction.js";
import { calculateOrderAmounts } from "../domain/money.js";
import {
  bulkOrderSchema,
  createOrderSchema,
  moveOrderSchema,
  orderListQuerySchema,
  updateOrderSchema,
} from "../domain/validation.js";
import { HttpError } from "../http/errors.js";
import { parseOrThrow } from "../http/validation.js";
import { affectsSalesMetrics, orderCategoryIds, refreshSalesMetrics } from "../services/analytics.js";
import { commandHash, findIdempotentReplay, parseIdempotencyKey, saveIdempotentResponse } from "../services/idempotency.js";
import { isTestWorkspace } from "../domain/workspace.js";
import { serializeOrder } from "../domain/serializers.js";

export const ordersRouter = Router();

const orderInclude = {
  customer: true,
  items: { include: { product: { include: { category: true } } } },
  history: { orderBy: { changedAt: "desc" as const }, take: 20 },
};

function makeOrderNumber(): string {
  return `OM-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

async function resolvePricedItems(
  tx: Prisma.TransactionClient,
  inputItems: Array<{ productId: string; quantity: number }>,
  ownerId: string,
) {
  const ids = [...new Set(inputItems.map((item) => item.productId))];
  const products = await tx.product.findMany({ where: { id: { in: ids }, isActive: true, ownerId } });
  const byId = new Map(products.map((product) => [product.id, product]));
  if (byId.size !== ids.length) {
    throw new HttpError(400, "PRODUCT_UNAVAILABLE", "Every order item must reference an active product.");
  }
  return inputItems.map((item) => {
    const product = byId.get(item.productId)!;
    return {
      productId: product.id,
      categoryId: product.categoryId,
      quantity: item.quantity,
      unitPrice: product.price.toFixed(2),
      unitCost: product.cost.toFixed(2),
    };
  });
}

ordersRouter.get("/", async (request, response) => {
  const query = parseOrThrow(orderListQuerySchema, request.query);
  const where: Prisma.OrderWhereInput = { ownerId: request.authUser!.id };
  if (query.status) where.status = query.status;
  if (query.search) {
    where.OR = [
      { orderNumber: { contains: query.search, mode: "insensitive" } },
      { customer: { name: { contains: query.search, mode: "insensitive" } } },
      { customer: { email: { contains: query.search, mode: "insensitive" } } },
    ];
  }
  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: orderInclude,
      orderBy: [{ status: "asc" }, { position: "asc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.order.count({ where }),
  ]);
  response.json({
    items: items.map(serializeOrder),
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  });
});

ordersRouter.get("/:id", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const item = await prisma.order.findFirst({
    where: { id, ownerId: request.authUser!.id },
    include: orderInclude,
  });
  if (!item) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
  response.json({ item: serializeOrder(item) });
});

ordersRouter.post("/", async (request, response) => {
  const input = parseOrThrow(createOrderSchema, request.body);
  const creatorId = request.authUser!.id;
  const ownerId = creatorId;
  const isTestData = isTestWorkspace(ownerId);
  const idempotencyKey = parseIdempotencyKey(request.header("idempotency-key"));
  const idempotency = idempotencyKey === undefined
    ? undefined
    : {
        scope: { ownerId, operation: "orders.create", key: idempotencyKey },
        hash: commandHash({ ...input, customer: { ...input.customer, email: input.customer.email.toLowerCase() } }),
      };
  const result = await prisma.$transaction(async (tx) => {
    if (idempotency) {
      const replay = await findIdempotentReplay(tx, idempotency.scope, idempotency.hash);
      if (replay) return { ...replay, replayed: true };
    }
    const pricedItems = await resolvePricedItems(tx, input.items, ownerId);
    const amounts = calculateOrderAmounts(pricedItems);
    const email = input.customer.email.toLowerCase();
    const existingCustomer = await tx.customer.findUnique({ where: { ownerId_email: { ownerId, email } } });
    const customer = existingCustomer
      ? await tx.customer.update({
          where: { id: existingCustomer.id },
          data: {
            name: input.customer.name,
            ...(input.customer.city === undefined ? {} : { city: input.customer.city }),
          },
        })
      : await tx.customer.create({
          data: {
            name: input.customer.name,
            email,
            ownerId,
            isTestData,
            ...(input.customer.city === undefined ? {} : { city: input.customer.city }),
          },
        });
    // MAX+1 under the column lock: gaps left by deletions never yield a duplicate, and concurrent creations queue.
    await lockBoardColumns(tx, ownerId, ["PENDING"]);
    const last = await tx.order.aggregate({ where: { status: "PENDING", ownerId }, _max: { position: true } });
    const position = (last._max.position ?? -1) + 1;
    const order = await tx.order.create({
      data: {
        orderNumber: makeOrderNumber(),
        ownerId,
        customerId: customer.id,
        createdBy: creatorId,
        status: "PENDING",
        position,
        total: amounts.total,
        margin: amounts.margin,
        isTestData,
        items: {
          create: pricedItems.map((priced) => ({
            productId: priced.productId,
            quantity: priced.quantity,
            unitPrice: priced.unitPrice,
            unitCost: priced.unitCost,
          })),
        },
      },
      include: orderInclude,
    });
    await refreshSalesMetrics(tx, order.createdAt, ownerId, pricedItems.map((priced) => priced.categoryId));
    const created = { status: 201, body: { item: serializeOrder(order) } };
    if (!idempotency) return { ...created, replayed: false };
    return { ...(await saveIdempotentResponse(tx, idempotency.scope, idempotency.hash, created)), replayed: false };
  });
  if (result.replayed) response.setHeader("Idempotent-Replayed", "true");
  response.status(result.status).json(result.body);
});

ordersRouter.patch("/bulk", async (request, response) => {
  const input = parseOrThrow(bulkOrderSchema, request.body);
  const changedBy = request.authUser!.id;
  const ownerId = changedBy;
  const result = await withTransactionRetry("orders.bulk", () => prisma.$transaction(async (tx) => {
    const orders = await tx.order.findMany({ where: { id: { in: input.ids }, ownerId } });
    if (orders.length !== input.ids.length) {
      throw new HttpError(404, "ORDER_NOT_FOUND", "One or more orders do not exist.");
    }
    const changed = orders.filter((order) => order.status !== input.status);
    if (changed.length === 0) return { updatedCount: 0, ids: [] as string[] };
    // Same lock order as single moves; rows that changed meanwhile fail the version guard below (409).
    await lockBoardColumns(tx, ownerId, [input.status, ...changed.map((order) => order.status)]);

    const changedIds = new Set(changed.map((order) => order.id));
    const sourceStatuses = [...new Set(changed.map((order) => order.status))];
    const [targetOrders, sourceOrders] = await Promise.all([
      tx.order.findMany({
        where: { status: input.status, ownerId, id: { notIn: [...changedIds] } },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      }),
      tx.order.findMany({
        where: { status: { in: sourceStatuses }, ownerId, id: { notIn: [...changedIds] } },
        orderBy: [{ status: "asc" }, { position: "asc" }, { id: "asc" }],
      }),
    ]);
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const changedInRequestOrder = input.ids.map((id) => orderById.get(id)!).filter((order) => changedIds.has(order.id));
    const metricDays = new Map<string, Date>();
    const positionUpdates = new Map<string, { order: (typeof orders)[number]; status: OrderStatus; position: number }>();
    for (const [position, order] of [...targetOrders, ...changedInRequestOrder].entries()) {
      if (order.status !== input.status || order.position !== position) {
        positionUpdates.set(order.id, { order, status: input.status, position });
      }
    }
    const sourceByStatus = new Map<OrderStatus, typeof sourceOrders>();
    for (const order of sourceOrders) {
      const group = sourceByStatus.get(order.status) ?? [];
      group.push(order);
      sourceByStatus.set(order.status, group);
    }
    for (const group of sourceByStatus.values()) {
      for (const [position, order] of group.entries()) {
        if (order.position !== position) positionUpdates.set(order.id, { order, status: order.status, position });
      }
    }
    for (const { order, status, position } of positionUpdates.values()) {
      const updated = await tx.order.updateMany({
        where: { id: order.id, version: order.version },
        data: { status, position, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new HttpError(409, "VERSION_CONFLICT", "An order changed while this bulk update was being applied.");
      }
    }
    const metricOrders = new Map<string, string[]>();
    for (const order of changedInRequestOrder) {
      await tx.orderStatusHistory.create({
        data: { orderId: order.id, changedBy, fromStatus: order.status, toStatus: input.status },
      });
      if (!affectsSalesMetrics(order.status, input.status)) continue;
      const dayKey = order.createdAt.toISOString().slice(0, 10);
      metricDays.set(dayKey, order.createdAt);
      metricOrders.set(dayKey, [...(metricOrders.get(dayKey) ?? []), order.id]);
    }
    for (const [dayKey, date] of [...metricDays.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      await refreshSalesMetrics(tx, date, ownerId, await orderCategoryIds(tx, metricOrders.get(dayKey)!));
    }
    return { updatedCount: changedInRequestOrder.length, ids: changedInRequestOrder.map((order) => order.id) };
  }));
  response.json(result);
});

ordersRouter.patch("/:id/status", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const input = parseOrThrow(moveOrderSchema, request.body);
  const changedBy = request.authUser!.id;
  const ownerId = changedBy;
  const item = await withTransactionRetry("orders.move", () => prisma.$transaction(async (tx) => {
    const found = await tx.order.findFirst({ where: { id, ownerId }, select: { status: true } });
    if (!found) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
    // Column locks in a fixed order, then a fresh read: a concurrent move of this card shows up as a new version.
    await lockBoardColumns(tx, ownerId, [found.status, input.status]);
    const existing = await tx.order.findFirst({ where: { id, ownerId } });
    if (!existing) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
    if (existing.version !== input.expectedVersion) {
      throw new HttpError(409, "VERSION_CONFLICT", "This order was updated by another request; reload and retry.");
    }

    const cardSelect = { id: true, position: true, version: true } as const;
    const sourceOrders = await tx.order.findMany({
      where: { status: existing.status, ownerId },
      select: cardSelect,
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });
    const targetOrders = input.status === existing.status
      ? sourceOrders
      : await tx.order.findMany({
          where: { status: input.status, ownerId },
          select: cardSelect,
          orderBy: [{ position: "asc" }, { id: "asc" }],
        });

    const moved = { id: existing.id, position: existing.position, version: existing.version };
    const sourceAfter = sourceOrders.filter((order) => order.id !== id);
    const targetAfter = input.status === existing.status ? sourceAfter : [...targetOrders];
    const insertionIndex = Math.min(input.position, targetAfter.length);
    targetAfter.splice(insertionIndex, 0, moved);

    // Only cards whose position (or, for the moved card, status) changes are written.
    const positionUpdates = new Map<string, { order: typeof moved; status: OrderStatus; position: number }>();
    for (const [position, order] of sourceAfter.entries()) {
      if (order.position !== position) positionUpdates.set(order.id, { order, status: existing.status, position });
    }
    for (const [position, order] of targetAfter.entries()) {
      if (order.id === id || order.position !== position) {
        positionUpdates.set(order.id, { order, status: input.status, position });
      }
    }

    for (const { order, status, position } of positionUpdates.values()) {
      const updated = await tx.order.updateMany({
        where: { id: order.id, version: order.version },
        data: { status, position, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new HttpError(409, "VERSION_CONFLICT", "An order changed while this move was being applied; reload and retry.");
      }
    }
    if (existing.status !== input.status) {
      await tx.orderStatusHistory.create({
        data: { orderId: id, changedBy, fromStatus: existing.status, toStatus: input.status },
      });
    }
    if (affectsSalesMetrics(existing.status, input.status)) {
      await refreshSalesMetrics(tx, existing.createdAt, ownerId, await orderCategoryIds(tx, [id]));
    }
    return tx.order.findUniqueOrThrow({ where: { id }, include: orderInclude });
  }));
  response.json({ item: serializeOrder(item) });
});

ordersRouter.patch("/:id", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const input = parseOrThrow(updateOrderSchema, request.body);
  const ownerId = request.authUser!.id;
  const item = await prisma.$transaction(async (tx) => {
    const existing = await tx.order.findFirst({ where: { id, ownerId } });
    if (!existing) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
    if (existing.version !== input.expectedVersion) {
      throw new HttpError(409, "VERSION_CONFLICT", "This order was updated by another request; reload and retry.");
    }
    const pricedItems = await resolvePricedItems(tx, input.items, ownerId);
    const amounts = calculateOrderAmounts(pricedItems);
    const changed = await tx.order.updateMany({
      where: { id, version: input.expectedVersion },
      data: {
        total: amounts.total,
        margin: amounts.margin,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      throw new HttpError(409, "VERSION_CONFLICT", "This order was updated by another request; reload and retry.");
    }
    const previousCategories = await orderCategoryIds(tx, [id]);
    await tx.orderItem.deleteMany({ where: { orderId: id } });
    await tx.orderItem.createMany({
      data: pricedItems.map((priced) => ({
        orderId: id,
        productId: priced.productId,
        quantity: priced.quantity,
        unitPrice: priced.unitPrice,
        unitCost: priced.unitCost,
      })),
    });
    await refreshSalesMetrics(tx, existing.createdAt, ownerId, [
      ...previousCategories,
      ...pricedItems.map((priced) => priced.categoryId),
    ]);
    return tx.order.findUniqueOrThrow({ where: { id }, include: orderInclude });
  });
  response.json({ item: serializeOrder(item) });
});

ordersRouter.delete("/:id", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const ownerId = request.authUser!.id;
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id, ownerId } });
    if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
    const categories = await orderCategoryIds(tx, [id]);
    await tx.order.delete({ where: { id } });
    await refreshSalesMetrics(tx, order.createdAt, ownerId, categories);
  });
  response.status(204).end();
});
