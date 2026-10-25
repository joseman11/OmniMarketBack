import { expect, test, type APIRequestContext } from "@playwright/test";

const token = process.env.TEST_API_TOKEN ?? "local-e2e-token-not-for-production";
const adminSessionPath = "/api/auth/test/session";
const resetPath = "/api/test/reset-data";

async function resetData(request: APIRequestContext): Promise<void> {
  const response = await request.post(resetPath, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBeTruthy();
}

async function signInAsTestAdmin(request: APIRequestContext): Promise<void> {
  const response = await request.post(adminSessionPath, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBeTruthy();
}

test("authentication protects private API routes and supports an isolated test session", async ({ request }) => {
  await resetData(request);

  const privateBeforeLogin = await request.get("/api/orders");
  expect(privateBeforeLogin.status()).toBe(401);
  const mutationBeforeLogin = await request.post("/api/orders", {
    data: { customer: { name: "Sin sesión", email: "guest@example.test" }, items: [] },
  });
  expect(mutationBeforeLogin.status()).toBe(401);

  await signInAsTestAdmin(request);
  const privateAfterLogin = await request.get("/api/orders");
  expect(privateAfterLogin.ok()).toBeTruthy();

  for (const page of [1, 2]) {
    for (let sample = 1; sample <= 3; sample += 1) {
      const startedAt = performance.now();
      const response = await request.get(`/api/test/analytics?page=${page}&limit=50`);
      const body = await response.json();
      const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
      expect(response.ok(), `analytics page ${page} sample ${sample} returned HTTP ${response.status()}`).toBeTruthy();
      expect(body.pagination).toMatchObject({ page, limit: 50 });
      expect(body.summary.ordersCount).toBeGreaterThan(0);
      expect(elapsedMs, `analytics page ${page} sample ${sample} took ${elapsedMs} ms`).toBeLessThan(300);
    }
  }
});

test.describe("authenticated backend workflows", () => {
  test.beforeEach(async ({ request }) => {
    await resetData(request);
    await signInAsTestAdmin(request);
  });

  test("creates a product and reflects a new order through the API", async ({ request }) => {
    const productResponse = await request.post("/api/products", {
      data: {
        categoryId: "00000000-0000-4000-8000-000000000010",
        sku: "E2E-BOTTLE-01",
        name: "Botella E2E",
        price: "350.00",
        cost: "125.00",
        stock: 15,
        isActive: true,
      },
    });
    expect(productResponse.status()).toBe(201);
    const product = (await productResponse.json()).item as { id: string };

    const orderResponse = await request.post("/api/orders", {
      data: {
        customer: { name: "Cliente E2E", email: "cliente-e2e@example.test", city: "Puebla" },
        items: [{ productId: product.id, quantity: 2 }],
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = (await orderResponse.json()).item as {
      id: string;
      total: string;
      margin: string;
      items: Array<{ quantity: number }>;
    };
    expect(order.total).toBe("700.00");
    expect(order.margin).toBe("450.00");
    expect(order.items[0]?.quantity).toBe(2);

    const fetched = await request.get(`/api/orders/${order.id}`);
    expect(fetched.ok()).toBeTruthy();
    expect((await fetched.json()).item.orderNumber).toMatch(/^OM-/);
  });

  test("edits order items with version checks and refreshes sales totals", async ({ request }) => {
    const orderId = "00000000-0000-4000-8000-000000000030";
    const mugId = "00000000-0000-4000-8000-000000000020";
    const tabletId = "00000000-0000-4000-8000-000000000021";
    const beforeResponse = await request.get(`/api/orders/${orderId}`);
    expect(beforeResponse.ok()).toBeTruthy();
    const before = (await beforeResponse.json()).item as { version: number; total: string };
    expect(before.total).toBe("240.00");

    const update = await request.patch(`/api/orders/${orderId}`, {
      data: {
        expectedVersion: before.version,
        items: [
          { productId: mugId, quantity: 3 },
          { productId: tabletId, quantity: 1 },
        ],
      },
    });
    expect(update.ok()).toBeTruthy();
    const updated = (await update.json()).item as {
      version: number;
      total: string;
      margin: string;
      items: Array<{ productId: string; quantity: number; unitPrice: string; unitCost: string }>;
    };
    expect(updated).toMatchObject({
      version: before.version + 1,
      total: "2860.00",
      margin: "925.00",
    });
    expect(updated.items.map(({ productId, quantity, unitPrice, unitCost }) => ({
      productId, quantity, unitPrice, unitCost,
    })).sort((left, right) => left.productId.localeCompare(right.productId))).toEqual([
      { productId: mugId, quantity: 3, unitPrice: "120.00", unitCost: "45.00" },
      { productId: tabletId, quantity: 1, unitPrice: "2500.00", unitCost: "1800.00" },
    ]);

    const staleUpdate = await request.patch(`/api/orders/${orderId}`, {
      data: { expectedVersion: before.version, items: [{ productId: mugId, quantity: 1 }] },
    });
    expect(staleUpdate.status()).toBe(409);

    const analytics = await request.get("/api/test/analytics?from=2026-10-20&to=2026-10-20");
    expect(analytics.ok()).toBeTruthy();
    expect((await analytics.json()).summary).toMatchObject({
      ordersCount: 2,
      revenue: "5480.00",
      avgTicket: "2740.00",
      grossMargin: "1700.00",
    });
  });

  test("bulk status updates preserve ordering and record status history", async ({ request }) => {
    const pendingId = "00000000-0000-4000-8000-000000000030";
    const processingId = "00000000-0000-4000-8000-000000000031";
    const shippedId = "00000000-0000-4000-8000-000000000032";
    const response = await request.patch("/api/orders/bulk", {
      data: { ids: [pendingId, processingId], status: "SHIPPED" },
    });
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toEqual({ updatedCount: 2, ids: [pendingId, processingId] });

    const orders = await request.get("/api/orders?status=SHIPPED&limit=10");
    expect(orders.ok()).toBeTruthy();
    const items = (await orders.json()).items as Array<{ id: string; position: number }>;
    expect(items.map(({ id, position }) => [id, position])).toEqual([
      [shippedId, 0],
      [pendingId, 1],
      [processingId, 2],
    ]);

    const movedOrder = await request.get(`/api/orders/${pendingId}`);
    expect((await movedOrder.json()).item.history[0]).toMatchObject({
      fromStatus: "PENDING",
      toStatus: "SHIPPED",
    });
  });

  test("bulk status update rejects a missing order without changing the others", async ({ request }) => {
    const pendingId = "00000000-0000-4000-8000-000000000030";
    const missingId = "00000000-0000-4000-8000-000000000099";
    const response = await request.patch("/api/orders/bulk", {
      data: { ids: [pendingId, missingId], status: "CANCELLED" },
    });
    expect(response.status()).toBe(404);

    const pending = await request.get(`/api/orders/${pendingId}`);
    expect((await pending.json()).item.status).toBe("PENDING");
  });

  test("prevents moving a product with sales to another category", async ({ request }) => {
    const mugId = "00000000-0000-4000-8000-000000000020";
    const homeCategoryId = "00000000-0000-4000-8000-000000000010";
    const technologyCategoryId = "00000000-0000-4000-8000-000000000011";
    const response = await request.patch(`/api/products/${mugId}`, {
      data: { categoryId: technologyCategoryId },
    });
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe("CATEGORY_HAS_SALES");

    const product = await request.get(`/api/products/${mugId}`);
    expect((await product.json()).item.categoryId).toBe(homeCategoryId);
  });

  test("moves a Kanban order with version checks and exposes its persisted status", async ({ request }) => {
    const orderId = "00000000-0000-4000-8000-000000000030";
    const before = await request.get(`/api/orders/${orderId}`);
    const current = (await before.json()).item as { version: number };

    const moved = await request.patch(`/api/orders/${orderId}/status`, {
      data: { status: "PROCESSING", position: 2, expectedVersion: current.version },
    });
    expect(moved.ok()).toBeTruthy();

    const status = await request.get("/api/test/kanban-status?orderNumber=OM-TEST-1001");
    expect(status.ok()).toBeTruthy();
    expect(await status.json()).toMatchObject({ status: "PROCESSING", position: 1, version: current.version + 1 });

    const staleMove = await request.patch(`/api/orders/${orderId}/status`, {
      data: { status: "SHIPPED", position: 3, expectedVersion: current.version },
    });
    expect(staleMove.status()).toBe(409);
  });

  test("filters and paginates orders by status, search term, and page size", async ({ request }) => {
    const filtered = await request.get("/api/orders?status=PENDING&search=1001&page=1&limit=1");
    expect(filtered.ok()).toBeTruthy();
    const result = await filtered.json();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].orderNumber).toBe("OM-TEST-1001");
    expect(result.pagination).toMatchObject({ page: 1, limit: 1, total: 1, totalPages: 1 });

    const invalidStatus = await request.get("/api/orders?status=UNKNOWN");
    expect(invalidStatus.status()).toBe(400);
  });

  test("rejects an order containing an inactive product", async ({ request }) => {
    const productResponse = await request.post("/api/products", {
      data: {
        categoryId: "00000000-0000-4000-8000-000000000010",
        sku: "E2E-INACTIVE-01",
        name: "Producto inactivo E2E",
        price: "25.00",
        cost: "10.00",
        stock: 1,
        isActive: false,
      },
    });
    expect(productResponse.status()).toBe(201);
    const productId = (await productResponse.json()).item.id as string;

    const orderResponse = await request.post("/api/orders", {
      data: {
        customer: { name: "Cliente E2E", email: "inactive-product@example.test" },
        items: [{ productId, quantity: 1 }],
      },
    });
    expect(orderResponse.status()).toBe(400);
    expect((await orderResponse.json()).error.code).toBe("PRODUCT_UNAVAILABLE");
  });

  test("rejects invalid product amounts and leaves the catalog unchanged", async ({ request }) => {
    const response = await request.post("/api/products", {
      data: {
        categoryId: "00000000-0000-4000-8000-000000000010",
        sku: "E2E-INVALID-PRICE",
        name: "Precio inválido E2E",
        price: "-10.00",
        cost: "1.00",
        stock: 1,
        isActive: true,
      },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");

    const products = await request.get("/api/products?search=E2E-INVALID-PRICE");
    expect((await products.json()).pagination.total).toBe(0);
  });

  test("rejects a duplicate SKU within the authenticated workspace", async ({ request }) => {
    const response = await request.post("/api/products", {
      data: {
        categoryId: "00000000-0000-4000-8000-000000000010",
        sku: "om-test-mug",
        name: "SKU duplicado E2E",
        price: "120.00",
        cost: "45.00",
        stock: 1,
        isActive: true,
      },
    });
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe("CONFLICT");
  });

  test("reuses a customer when a new order changes only email letter case", async ({ request }) => {
    const created = await request.post("/api/orders", {
      data: {
        customer: { name: "Ana Torres actualizada", email: "ANA@EXAMPLE.TEST", city: "Monterrey" },
        items: [{ productId: "00000000-0000-4000-8000-000000000020", quantity: 1 }],
      },
    });
    expect(created.status()).toBe(201);
    const orderId = (await created.json()).item.id as string;

    const detail = await request.get(`/api/orders/${orderId}`);
    expect((await detail.json()).item.customer).toMatchObject({
      name: "Ana Torres actualizada",
      email: "ana@example.test",
      city: "Monterrey",
    });
  });

  test("refreshes daily analytics after deleting an order", async ({ request }) => {
    const orderId = "00000000-0000-4000-8000-000000000030";
    const deleted = await request.delete(`/api/orders/${orderId}`);
    expect(deleted.status()).toBe(204);

    const analytics = await request.get("/api/test/analytics?from=2026-10-20&to=2026-10-20");
    expect(analytics.ok()).toBeTruthy();
    expect((await analytics.json()).summary).toMatchObject({
      ordersCount: 1,
      revenue: "2620.00",
      avgTicket: "2620.00",
      grossMargin: "775.00",
    });
  });
});
