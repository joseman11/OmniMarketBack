import { describe, expect, it } from "vitest";
import {
  analyticsQuerySchema,
  bulkOrderSchema,
  createOrderSchema,
  filterOrderStatuses,
  moveOrderSchema,
  orderListQuerySchema,
  productInputSchema,
  updateOrderSchema,
  updateProductSchema,
  dateRangeWhere,
} from "../../src/domain/validation.js";

describe("input schemas and filters", () => {
  it("accepts a valid order with customer and product snapshots requested by ID", () => {
    const result = createOrderSchema.safeParse({
      customer: { name: "Ada", email: "ada@example.test" },
      items: [{ productId: "00000000-0000-4000-8000-000000000001", quantity: 2 }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty orders and zero quantities", () => {
    expect(createOrderSchema.safeParse({
      customer: { name: "Ada", email: "ada@example.test" },
      items: [],
    }).success).toBe(false);
    expect(createOrderSchema.safeParse({
      customer: { name: "Ada", email: "ada@example.test" },
      items: [{ productId: "00000000-0000-4000-8000-000000000001", quantity: 0 }],
    }).success).toBe(false);
  });

  it("rejects malformed email and unknown order fields", () => {
    expect(createOrderSchema.safeParse({
      customer: { name: "Ada", email: "invalid" },
      items: [{ productId: "00000000-0000-4000-8000-000000000001", quantity: 1 }],
    }).success).toBe(false);
    expect(orderListQuerySchema.safeParse({ page: "1", unsupported: "x" }).success).toBe(false);
  });

  it("applies safe analytics pagination defaults and maximum page size", () => {
    expect(analyticsQuerySchema.parse({}).limit).toBe(50);
    expect(analyticsQuerySchema.safeParse({ page: 1, limit: 101 }).success).toBe(false);
  });

  it("rejects reversed analytics date ranges", () => {
    expect(analyticsQuerySchema.safeParse({ from: "2026-10-22", to: "2026-10-21" }).success).toBe(false);
  });

  it("rejects invalid calendar dates in analytics filters", () => {
    expect(analyticsQuerySchema.safeParse({ from: "2026-02-30" }).success).toBe(false);
  });

  it("rejects negative product prices and malformed SKUs", () => {
    expect(productInputSchema.safeParse({
      categoryId: "00000000-0000-4000-8000-000000000001",
      sku: "SKU-1",
      name: "Product",
      price: "-1.00",
      cost: "0.00",
    }).success).toBe(false);
  });

  it("filters orders by Kanban status while retaining all orders without a filter", () => {
    const orders = [{ status: "PENDING" }, { status: "SHIPPED" }, { status: "PENDING" }];
    expect(filterOrderStatuses(orders, "PENDING")).toEqual([orders[0], orders[2]]);
    expect(filterOrderStatuses(orders)).toEqual(orders);
  });

  it("requires a complete versioned Kanban move", () => {
    expect(moveOrderSchema.safeParse({
      status: "PROCESSING",
      position: 2,
      expectedVersion: 1,
    }).success).toBe(true);
    expect(moveOrderSchema.safeParse({
      status: "PROCESSING",
      position: 2,
    }).success).toBe(false);
  });

  it("requires unique order IDs in a bulk status update", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(bulkOrderSchema.safeParse({ ids: [id], status: "SHIPPED" }).success).toBe(true);
    expect(bulkOrderSchema.safeParse({ ids: [id, id], status: "SHIPPED" }).success).toBe(false);
  });

  it("requires items and expectedVersion when editing an order", () => {
    expect(updateOrderSchema.safeParse({
      expectedVersion: 2,
      items: [{ productId: "00000000-0000-4000-8000-000000000001", quantity: 1 }],
    }).success).toBe(true);
    expect(updateOrderSchema.safeParse({ expectedVersion: 2, items: [] }).success).toBe(false);
  });

  it("rejects empty product updates and accepts a partial update", () => {
    expect(updateProductSchema.safeParse({}).success).toBe(false);
    expect(updateProductSchema.safeParse({ stock: 5 }).success).toBe(true);
  });

  it("builds inclusive UTC date filters with an exclusive next-day end", () => {
    const bounds = dateRangeWhere("2026-10-20", "2026-10-21");
    expect(bounds.gte?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(bounds.lt?.toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });

  it("omits date bounds when no range is requested", () => {
    expect(dateRangeWhere()).toEqual({});
  });

  it("applies order-list defaults and accepts trimmed search terms", () => {
    expect(orderListQuerySchema.parse({ search: "  OM-1001  " })).toMatchObject({
      page: 1,
      limit: 50,
      search: "OM-1001",
    });
  });

  it("rejects out-of-range pages, limits, and overly long search terms", () => {
    expect(orderListQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(orderListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(orderListQuerySchema.safeParse({ search: "x".repeat(121) }).success).toBe(false);
  });

  it("rejects non-UUID category filters and invalid product numeric boundaries", () => {
    expect(analyticsQuerySchema.safeParse({ categoryId: "not-a-uuid" }).success).toBe(false);
    expect(productInputSchema.safeParse({
      categoryId: "00000000-0000-4000-8000-000000000001",
      sku: "SKU-1",
      name: "Product",
      price: "1.001",
      cost: "0.00",
      stock: 0,
      isActive: true,
    }).success).toBe(false);
    expect(productInputSchema.safeParse({
      categoryId: "00000000-0000-4000-8000-000000000001",
      sku: "SKU-1",
      name: "Product",
      price: "1.00",
      cost: "0.00",
      stock: -1,
      isActive: true,
    }).success).toBe(false);
  });
});
