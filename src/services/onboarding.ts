import { randomBytes, randomUUID } from "node:crypto";
import type { OrderStatus, PrismaClient } from "@prisma/client";
import type { RequestHandler } from "express";
import { prisma } from "../db/prisma.js";
import { withTransactionRetry } from "../db/transaction.js";
import { calculateOrderAmounts } from "../domain/money.js";
import { isTestWorkspace } from "../domain/workspace.js";
import { refreshSalesMetrics } from "./analytics.js";

/**
 * Starter rows are ordinary workspace data (is_test_data = false), so resetTestData, which only touches
 * is_test_data rows, never deletes them; their order numbers use their own prefix, never the OM-TEST- fixtures'.
 */
export const STARTER_ORDER_PREFIX = "OM-DEMO-";

const DAY_MS = 24 * 60 * 60 * 1000;
const FLOW: readonly OrderStatus[] = ["PENDING", "PROCESSING", "SHIPPED"];

const starterCategories = [
  { key: "home", name: "Hogar", slug: "hogar" },
  { key: "tech", name: "Tecnología", slug: "tecnologia" },
] as const;

const starterProducts = [
  { key: "mug", category: "home", sku: "DEMO-TAZA", name: "Taza de cerámica", price: "149.00", cost: "55.00", stock: 50 },
  { key: "headphones", category: "tech", sku: "DEMO-AUDIFONOS", name: "Audífonos inalámbricos", price: "899.00", cost: "520.00", stock: 20 },
] as const;

const starterOrders = [
  { customer: { name: "Cliente de ejemplo 1", email: "cliente1@ejemplo.com", city: "Monterrey" }, status: "PENDING", daysAgo: 0, items: [{ product: "mug", quantity: 2 }] },
  { customer: { name: "Cliente de ejemplo 2", email: "cliente2@ejemplo.com", city: "Guadalajara" }, status: "PROCESSING", daysAgo: 1, items: [{ product: "mug", quantity: 1 }, { product: "headphones", quantity: 1 }] },
  { customer: { name: "Cliente de ejemplo 3", email: "cliente3@ejemplo.com", city: "Mérida" }, status: "SHIPPED", daysAgo: 2, items: [{ product: "headphones", quantity: 1 }] },
] as const;

/**
 * Gives an account its starter workspace (2 categories, 2 active products, 3 orders with history) exactly once.
 * The first statement claims the account by setting users.onboarded_at where it is still NULL: a concurrent call
 * blocks on that row lock and, once the first transaction commits, matches no row and seeds nothing. The claim and
 * the rows commit together, so a failure leaves the account unclaimed for the next read. An account that already
 * has data is only marked, and once marked it is never seeded again, even if its owner deletes everything.
 */
export async function ensureStarterData(ownerId: string, database: PrismaClient = prisma): Promise<boolean> {
  if (isTestWorkspace(ownerId)) return false;
  return withTransactionRetry("onboarding.starter_data", () => database.$transaction(async (tx) => {
    const claim = await tx.user.updateMany({ where: { id: ownerId, onboardedAt: null }, data: { onboardedAt: new Date() } });
    if (claim.count === 0) return false;

    const owned = { where: { ownerId } };
    const existing = await Promise.all([
      tx.category.count(owned), tx.product.count(owned), tx.customer.count(owned), tx.order.count(owned),
    ]);
    if (existing.some((count) => count > 0)) return false;

    const categoryIds = new Map(starterCategories.map((category) => [category.key, randomUUID()]));
    await tx.category.createMany({
      data: starterCategories.map((category) => ({
        id: categoryIds.get(category.key)!, ownerId, name: category.name, slug: category.slug,
      })),
    });
    const products = new Map(starterProducts.map((product) => [product.key, { ...product, id: randomUUID() }]));
    await tx.product.createMany({
      data: [...products.values()].map((product) => ({
        id: product.id,
        ownerId,
        categoryId: categoryIds.get(product.category)!,
        sku: product.sku,
        name: product.name,
        price: product.price,
        cost: product.cost,
        stock: product.stock,
        isActive: true,
      })),
    });

    // Order numbers are globally unique: one random batch suffix per account plus the order's sequence.
    const batch = randomBytes(4).toString("hex").toUpperCase();
    const now = Date.now();
    const metricDays = new Map<string, Date>();
    for (const [index, order] of starterOrders.entries()) {
      const customer = await tx.customer.create({ data: { ...order.customer, ownerId } });
      const items = order.items.map((item) => {
        const product = products.get(item.product)!;
        return { productId: product.id, quantity: item.quantity, unitPrice: product.price, unitCost: product.cost };
      });
      const amounts = calculateOrderAmounts(items);
      const createdAt = new Date(now - order.daysAgo * DAY_MS);
      const steps = FLOW.slice(0, FLOW.indexOf(order.status) + 1);
      await tx.order.create({
        data: {
          orderNumber: `${STARTER_ORDER_PREFIX}${batch}-${index + 1}`,
          ownerId,
          customerId: customer.id,
          createdBy: ownerId,
          status: order.status,
          // Each starter order is alone in its column of an empty board.
          position: 0,
          total: amounts.total,
          margin: amounts.margin,
          createdAt,
          items: { create: items },
          history: {
            create: steps.map((status, step) => ({
              changedBy: ownerId,
              fromStatus: step === 0 ? null : steps[step - 1]!,
              toStatus: status,
              changedAt: new Date(createdAt.getTime() + step * 60 * 60 * 1000),
            })),
          },
        },
      });
      metricDays.set(createdAt.toISOString().slice(0, 10), createdAt);
    }
    for (const day of metricDays.values()) await refreshSalesMetrics(tx, day, ownerId);
    return true;
  }, { maxWait: 10_000, timeout: 20_000 }));
}

/** Lazy onboarding on authenticated reads only; OAuth sign-in never seeds. Once marked, reads skip it entirely. */
export const ensureStarterWorkspace: RequestHandler = async (request, _response, next) => {
  if (request.method === "GET" && request.authUser && request.needsStarterData) {
    await ensureStarterData(request.authUser.id);
    request.needsStarterData = false;
  }
  next();
};
