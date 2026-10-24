import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decimal, prismaMock, resetPrismaMock, sqlText } from "./helpers/prisma-mock.js";
import { startServer, type TestServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { createApp } = await import("../../src/application.js");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "00000000-0000-4000-8000-000000000020";
const OLD_CATEGORY = "00000000-0000-4000-8000-000000000010";
const NEW_CATEGORY = "00000000-0000-4000-8000-000000000011";
const session = { Cookie: "omni_session=owner-token" };

let server: TestServer;
beforeAll(async () => {
  server = await startServer(createApp());
});
afterAll(async () => server.close());
beforeEach(() => {
  resetPrismaMock();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  prismaMock.session.findUnique.mockResolvedValue({
    id: "s1",
    expires: new Date(Date.now() + 60_000),
    user: { id: OWNER_ID, email: "owner@example.test", name: null, image: null, role: "OPERATOR" },
  });
  prismaMock.$queryRaw.mockResolvedValue([{ category_id: OLD_CATEGORY }]);
  prismaMock.category.findFirst.mockResolvedValue({ id: NEW_CATEGORY });
  prismaMock.product.update.mockResolvedValue({ id: PRODUCT_ID, price: decimal("1.00"), cost: decimal("0.50"), category: {} });
});

describe("product category change", () => {
  it("locks the product row, checks sales and updates inside one transaction", async () => {
    const response = await server.request("PATCH", `/api/products/${PRODUCT_ID}`, { headers: session, body: { categoryId: NEW_CATEGORY } });

    expect(response.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(sqlText(prismaMock.$queryRaw.mock.calls[0]!)).toMatch(/FOR UPDATE/);
    const lockOrder = prismaMock.$queryRaw.mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(prismaMock.orderItem.count.mock.invocationCallOrder[0]!);
    expect(prismaMock.orderItem.count.mock.invocationCallOrder[0]!).toBeLessThan(prismaMock.product.update.mock.invocationCallOrder[0]!);
  });

  it("rejects moving a product with sales and does not update it", async () => {
    prismaMock.orderItem.count.mockResolvedValue(1);
    const response = await server.request("PATCH", `/api/products/${PRODUCT_ID}`, { headers: session, body: { categoryId: NEW_CATEGORY } });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "CATEGORY_HAS_SALES" } });
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("answers 404 for a product of another workspace", async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    const response = await server.request("PATCH", `/api/products/${PRODUCT_ID}`, { headers: session, body: { stock: 3 } });
    expect(response.status).toBe(404);
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("does not count sales when the category is unchanged", async () => {
    const response = await server.request("PATCH", `/api/products/${PRODUCT_ID}`, { headers: session, body: { categoryId: OLD_CATEGORY, stock: 2 } });
    expect(response.status).toBe(200);
    expect(prismaMock.orderItem.count).not.toHaveBeenCalled();
  });
});
