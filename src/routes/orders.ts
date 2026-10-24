import { randomBytes } from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
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
import { refreshSalesMetrics } from "../services/analytics.js";
import { TEST_ADMIN_ID } from "../services/test-fixtures.js";
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
  isTestData: boolean,
) {
  const ids = [...new Set(inputItems.map((item) => item.productId))];
  const products = await tx.product.findMany({ where: { id: { in: ids }, isActive: true, isTestData } });
  const byId = new Map(products.map((product) => [product.id, product]));
  if (byId.size !== ids.length) {
    throw new HttpError(400, "PRODUCT_UNAVAILABLE", "Every order item must reference an active product.");
  }
  return inputItems.map((item) => {
    const product = byId.get(item.productId)!;
    return {
      productId: product.id,
      quantity: item.quantity,
      unitPrice: product.price.toFixed(2),
      unitCost: product.cost.toFixed(2),
    };
  });
}

ordersRouter.get("/", async (request, response) => {
  const query = parseOrThrow(orderListQuerySchema, request.query);
  const where: Prisma.OrderWhereInput = { isTestData: request.authUser?.id === TEST_ADMIN_ID };
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
    where: { id, isTestData: request.authUser?.id === TEST_ADMIN_ID },
    include: orderInclude,
  });
  if (!item) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
  response.json({ item: serializeOrder(item) });
});

ordersRouter.post("/", async (request, response) => {
  const input = parseOrThrow(createOrderSchema, request.body);
  const creatorId = request.authUser!.id;
  const isTestData = creatorId === TEST_ADMIN_ID;
  const item = await prisma.$transaction(async (tx) => {
    const pricedItems = await resolvePricedItems(tx, input.items, isTestData);
    const amounts = calculateOrderAmounts(pricedItems);
    const email = input.customer.email.toLowerCase();
    const existingCustomer = await tx.customer.findUnique({ where: { email } });
    if (existingCustomer && existingCustomer.isTestData !== isTestData) {
      throw new HttpError(409, "CUSTOMER_EMAIL_SCOPE_CONFLICT", "This email address is already used by a customer in another data scope.");
    }
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
            isTestData,
            ...(input.customer.city === undefined ? {} : { city: input.customer.city }),
          },
        });
    const position = await tx.order.count({ where: { status: "PENDING", isTestData } });
    const order = await tx.order.create({
      data: {
        orderNumber: makeOrderNumber(),
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
    await refreshSalesMetrics(tx, order.createdAt, isTestData);
    return order;
  });
  response.status(201).json({ item: serializeOrder(item) });
});

ordersRouter.patch("/bulk", async (request, response) => {
  const input = parseOrThrow(bulkOrderSchema, request.body);
  const changedBy = request.authUser!.id;
  const isTestData = changedBy === TEST_ADMIN_ID;
  const result = await prisma.$transaction(async (tx) => {
    const orders = await tx.order.findMany({ where: { id: { in: input.ids }, isTestData } });
    if (orders.length !== input.ids.length) {
      throw new HttpError(404, "ORDER_NOT_FOUND", "One or more orders do not exist.");
    }
    const changed = orders.filter((order) => order.status !== input.status);
    const metricDays = new Map<string, Date>();
    for (const order of changed) {
      const updated = await tx.order.updateMany({
        where: { id: order.id, version: order.version },
        data: { status: input.status, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new HttpError(409, "VERSION_CONFLICT", "An order changed while this bulk update was being applied.");
      }
      await tx.orderStatusHistory.create({
        data: { orderId: order.id, changedBy, fromStatus: order.status, toStatus: input.status },
      });
      metricDays.set(order.createdAt.toISOString().slice(0, 10), order.createdAt);
    }
    for (const date of metricDays.values()) await refreshSalesMetrics(tx, date, isTestData);
    return { updatedCount: changed.length, ids: changed.map((order) => order.id) };
  });
  response.json(result);
});

ordersRouter.patch("/:id/status", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const input = parseOrThrow(moveOrderSchema, request.body);
  const changedBy = request.authUser!.id;
  const isTestData = changedBy === TEST_ADMIN_ID;
  const item = await prisma.$transaction(async (tx) => {
    const existing = await tx.order.findFirst({ where: { id, isTestData } });
    if (!existing) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
    if (existing.version !== input.expectedVersion) {
      throw new HttpError(409, "VERSION_CONFLICT", "This order was updated by another request; reload and retry.");
    }
    const updated = await tx.order.updateMany({
      where: { id, version: input.expectedVersion },
      data: { status: input.status, position: input.position, version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw new HttpError(409, "VERSION_CONFLICT", "This order was updated by another request; reload and retry.");
    }
    if (existing.status !== input.status) {
      await tx.orderStatusHistory.create({
        data: { orderId: id, changedBy, fromStatus: existing.status, toStatus: input.status },
      });
    }
    await refreshSalesMetrics(tx, existing.createdAt, existing.isTestData);
    return tx.order.findUniqueOrThrow({ where: { id }, include: orderInclude });
  });
  response.json({ item: serializeOrder(item) });
});

ordersRouter.patch("/:id", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const input = parseOrThrow(updateOrderSchema, request.body);
  const isTestData = request.authUser?.id === TEST_ADMIN_ID;
  const item = await prisma.$transaction(async (tx) => {
    const existing = await tx.order.findFirst({ where: { id, isTestData } });
    if (!existing) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
    if (existing.version !== input.expectedVersion) {
      throw new HttpError(409, "VERSION_CONFLICT", "This order was updated by another request; reload and retry.");
    }
    const pricedItems = await resolvePricedItems(tx, input.items, isTestData);
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
    await refreshSalesMetrics(tx, existing.createdAt, existing.isTestData);
    return tx.order.findUniqueOrThrow({ where: { id }, include: orderInclude });
  });
  response.json({ item: serializeOrder(item) });
});

ordersRouter.delete("/:id", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const isTestData = request.authUser?.id === TEST_ADMIN_ID;
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id, isTestData } });
    if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
    await tx.order.delete({ where: { id } });
    await refreshSalesMetrics(tx, order.createdAt, order.isTestData);
  });
  response.status(204).end();
});
