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

  await signInAsTestAdmin(request);
  const privateAfterLogin = await request.get("/api/orders");
  expect(privateAfterLogin.ok()).toBeTruthy();

  const analytics = await request.get("/api/test/analytics?page=1&limit=50");
  expect(analytics.ok()).toBeTruthy();
  expect((await analytics.json()).summary.ordersCount).toBeGreaterThan(0);

  const startedAt = performance.now();
  const measuredAnalytics = await request.get("/api/test/analytics?page=1&limit=50");
  const elapsedMs = performance.now() - startedAt;
  expect(measuredAnalytics.ok()).toBeTruthy();
  expect(elapsedMs).toBeLessThan(300);
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
    expect(await status.json()).toMatchObject({ status: "PROCESSING", position: 2, version: current.version + 1 });

    const staleMove = await request.patch(`/api/orders/${orderId}/status`, {
      data: { status: "SHIPPED", position: 3, expectedVersion: current.version },
    });
    expect(staleMove.status()).toBe(409);
  });
});
