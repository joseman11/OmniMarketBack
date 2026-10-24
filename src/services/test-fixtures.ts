import type { PrismaClient } from "@prisma/client";
import { calculateOrderAmounts } from "../domain/money.js";
import { refreshSalesMetrics } from "./analytics.js";

export const TEST_ADMIN_ID = "00000000-0000-4000-8000-000000000001";
export const TEST_CATEGORY_HOME_ID = "00000000-0000-4000-8000-000000000010";
export const TEST_CATEGORY_TECH_ID = "00000000-0000-4000-8000-000000000011";
export const TEST_PRODUCT_MUG_ID = "00000000-0000-4000-8000-000000000020";
export const TEST_PRODUCT_TABLET_ID = "00000000-0000-4000-8000-000000000021";
export const TEST_ORDER_PENDING_ID = "00000000-0000-4000-8000-000000000030";
export const TEST_ORDER_PROCESSING_ID = "00000000-0000-4000-8000-000000000031";
export const TEST_ORDER_SHIPPED_ID = "00000000-0000-4000-8000-000000000032";

const customerRows = [
  { id: "00000000-0000-4000-8000-000000000040", name: "Ana Torres", email: "ana@example.test", city: "Monterrey", isTestData: true },
  { id: "00000000-0000-4000-8000-000000000041", name: "Luis Ríos", email: "luis@example.test", city: "Guadalajara", isTestData: true },
  { id: "00000000-0000-4000-8000-000000000042", name: "María Solís", email: "maria@example.test", city: "Mérida", isTestData: true },
];

const productRows = [
  { id: TEST_PRODUCT_MUG_ID, categoryId: TEST_CATEGORY_HOME_ID, sku: "OM-TEST-MUG", name: "Taza Omni", price: "120.00", cost: "45.00", stock: 40, isTestData: true },
  { id: TEST_PRODUCT_TABLET_ID, categoryId: TEST_CATEGORY_TECH_ID, sku: "OM-TEST-TAB", name: "Tablet Omni", price: "2500.00", cost: "1800.00", stock: 12, isTestData: true },
];

const orderRows = [
  {
    id: TEST_ORDER_PENDING_ID,
    orderNumber: "OM-TEST-1001",
    customerId: customerRows[0]!.id,
    status: "PENDING" as const,
    position: 0,
    createdAt: new Date("2026-10-20T12:00:00.000Z"),
    items: [{ productId: TEST_PRODUCT_MUG_ID, quantity: 2, unitPrice: "120.00", unitCost: "45.00" }],
  },
  {
    id: TEST_ORDER_PROCESSING_ID,
    orderNumber: "OM-TEST-1002",
    customerId: customerRows[1]!.id,
    status: "PROCESSING" as const,
    position: 0,
    createdAt: new Date("2026-10-20T14:00:00.000Z"),
    items: [
      { productId: TEST_PRODUCT_MUG_ID, quantity: 1, unitPrice: "120.00", unitCost: "45.00" },
      { productId: TEST_PRODUCT_TABLET_ID, quantity: 1, unitPrice: "2500.00", unitCost: "1800.00" },
    ],
  },
  {
    id: TEST_ORDER_SHIPPED_ID,
    orderNumber: "OM-TEST-1003",
    customerId: customerRows[2]!.id,
    status: "SHIPPED" as const,
    position: 0,
    createdAt: new Date("2026-10-21T09:30:00.000Z"),
    items: [{ productId: TEST_PRODUCT_TABLET_ID, quantity: 1, unitPrice: "2500.00", unitCost: "1800.00" }],
  },
];

export async function resetTestData(database: PrismaClient): Promise<{ categories: number; products: number; orders: number }> {
  return database.$transaction(async (tx) => {
    const oldTestOrders = await tx.order.findMany({
      where: { isTestData: true },
      select: { createdAt: true },
    });
    await tx.order.deleteMany({ where: { isTestData: true } });
    for (const order of oldTestOrders) await refreshSalesMetrics(tx, order.createdAt, true);
    await tx.session.deleteMany({ where: { userId: TEST_ADMIN_ID } });
    await tx.account.deleteMany({ where: { userId: TEST_ADMIN_ID } });
    await tx.product.deleteMany({ where: { isTestData: true, items: { none: {} } } });
    await tx.category.deleteMany({
      where: { isTestData: true, products: { none: {} }, metrics: { none: {} } },
    });
    await tx.customer.deleteMany({ where: { isTestData: true, orders: { none: {} } } });

    await tx.user.upsert({
      where: { id: TEST_ADMIN_ID },
      create: {
        id: TEST_ADMIN_ID,
        name: "OmniMarket Test Admin",
        email: "admin@omnimarket.test",
        emailVerified: new Date("2026-01-01T00:00:00.000Z"),
        role: "ADMIN",
      },
      update: {
        name: "OmniMarket Test Admin",
        email: "admin@omnimarket.test",
        role: "ADMIN",
      },
    });

    await tx.category.createMany({
      data: [
        { id: TEST_CATEGORY_HOME_ID, name: "OM-TEST Hogar", slug: "om-test-hogar", isTestData: true },
        { id: TEST_CATEGORY_TECH_ID, name: "OM-TEST Tecnología", slug: "om-test-tecnologia", isTestData: true },
      ],
      skipDuplicates: true,
    });
    await tx.customer.createMany({ data: customerRows, skipDuplicates: true });
    await tx.product.createMany({ data: productRows, skipDuplicates: true });

    const metricDays = new Map<string, Date>();
    for (const order of orderRows) {
      const amounts = calculateOrderAmounts(order.items);
      await tx.order.create({
        data: {
          id: order.id,
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          createdBy: TEST_ADMIN_ID,
          status: order.status,
          position: order.position,
          total: amounts.total,
          margin: amounts.margin,
          createdAt: order.createdAt,
          updatedAt: order.createdAt,
          isTestData: true,
          items: {
            create: order.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              unitCost: item.unitCost,
            })),
          },
        },
      });
      const dayKey = order.createdAt.toISOString().slice(0, 10);
      metricDays.set(dayKey, order.createdAt);
    }
    for (const date of metricDays.values()) await refreshSalesMetrics(tx, date, true);

    return { categories: 2, products: productRows.length, orders: orderRows.length };
  }, { maxWait: 10_000, timeout: 30_000 });
}
