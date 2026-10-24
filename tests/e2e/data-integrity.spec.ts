import { expect, test, type APIRequestContext } from "@playwright/test";

const token = process.env.TEST_API_TOKEN ?? "local-e2e-token-not-for-production";
const MUG_ID = "00000000-0000-4000-8000-000000000020";

async function resetAndSignIn(request: APIRequestContext): Promise<void> {
  expect((await request.post("/api/test/reset-data", { headers: { Authorization: `Bearer ${token}` } })).ok()).toBeTruthy();
  expect((await request.post("/api/auth/test/session", { headers: { Authorization: `Bearer ${token}` } })).ok()).toBeTruthy();
}

async function createOrder(request: APIRequestContext, email: string, headers: Record<string, string> = {}) {
  return request.post("/api/orders", {
    headers,
    data: { customer: { name: "Cliente integridad", email }, items: [{ productId: MUG_ID, quantity: 1 }] },
  });
}

async function pendingPositions(request: APIRequestContext): Promise<number[]> {
  const response = await request.get("/api/orders?status=PENDING&limit=100");
  const body = await response.json() as { items: Array<{ position: number }> };
  return body.items.map((order) => order.position).sort((a, b) => a - b);
}

test.describe("data integrity against PostgreSQL", () => {
  test.beforeEach(async ({ request }) => resetAndSignIn(request));

  test("a new order never duplicates a position after a middle card is deleted", async ({ request }) => {
    const created = [];
    for (const n of [1, 2, 3]) {
      const response = await createOrder(request, `pos-${n}@example.test`);
      expect(response.status()).toBe(201);
      created.push((await response.json()).item as { id: string; position: number });
    }
    expect(created.map((order) => order.position)).toEqual([1, 2, 3]);

    expect((await request.delete(`/api/orders/${created[1]!.id}`)).status()).toBe(204);
    const next = await createOrder(request, "pos-4@example.test");
    expect((await next.json()).item.position).toBe(4);

    const positions = await pendingPositions(request);
    expect(new Set(positions).size).toBe(positions.length);
  });

  test("concurrent creations receive distinct positions", async ({ request }) => {
    const responses = await Promise.all([1, 2, 3, 4, 5].map((n) => createOrder(request, `par-${n}@example.test`)));
    for (const response of responses) expect(response.status()).toBe(201);
    const positions = await pendingPositions(request);
    expect(new Set(positions).size).toBe(positions.length);
  });
});
