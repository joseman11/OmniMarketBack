import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decimal, prismaMock, resetPrismaMock } from "./helpers/prisma-mock.js";
import { startServer, type TestServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));
const { resetTestDataMock } = vi.hoisted(() => ({ resetTestDataMock: vi.fn() }));
vi.mock("../../src/services/test-fixtures.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/test-fixtures.js")>()),
  resetTestData: resetTestDataMock,
}));

const { createApp } = await import("../../src/application.js");
const { resetEnvForTests } = await import("../../src/config/env.js");
const { TEST_ADMIN_ID } = await import("../../src/domain/workspace.js");

const TOKEN = "contract-test-token-0123456789";
let server: TestServer;

beforeAll(async () => {
  process.env.TEST_API_TOKEN = TOKEN;
  resetEnvForTests();
  server = await startServer(createApp());
});
afterAll(async () => {
  await server.close();
  delete process.env.TEST_API_TOKEN;
  resetEnvForTests();
});
beforeEach(() => {
  resetPrismaMock();
  resetTestDataMock.mockResolvedValue({ categories: 2, products: 2, orders: 3 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function mockAnalyticsData(): void {
  prismaMock.salesDailyMetric.findMany.mockResolvedValue([{
    day: new Date("2026-10-20T00:00:00.000Z"),
    category: { id: "00000000-0000-4000-8000-000000000010", name: "OM-TEST Hogar", slug: "om-test-hogar" },
    ordersCount: 2,
    revenue: decimal("360.00"),
    avgTicket: decimal("180.00"),
    grossMargin: decimal("225.00"),
  }]);
  prismaMock.salesDailyMetric.count.mockResolvedValue(1);
  prismaMock.order.aggregate.mockResolvedValue({
    _count: { _all: 3 },
    _sum: { total: decimal("5360.00"), margin: decimal("1825.00") },
  });
}

describe("audit endpoint contract", () => {
  it("serves paginated analytics anonymously from the synthetic dataset", async () => {
    mockAnalyticsData();
    const response = await server.request("GET", "/api/test/analytics?page=1&limit=50");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: { ordersCount: 3, revenue: "5360.00", avgTicket: "1786.67", grossMargin: "1825.00" },
      items: [{ day: "2026-10-20", ordersCount: 2, revenue: "360.00", avgTicket: "180.00", grossMargin: "225.00" }],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
    });
    expect(prismaMock.salesDailyMetric.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { ownerId: TEST_ADMIN_ID },
      skip: 0,
      take: 50,
    });
  });

  it("rejects an analytics page size above the maximum with 400", async () => {
    const response = await server.request("GET", "/api/test/analytics?page=1&limit=101");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it.each([
    "page=0", "page=10001", "page=abc", "page=1.5", "limit=0", "limit=-1", "limit=abc",
    "from=2026-02-30", "from=2026-10-22&to=2026-10-21", "categoryId=not-a-uuid",
  ])("rejects invalid analytics parameters (%s) with 400 before querying", async (query) => {
    const response = await server.request("GET", `/api/test/analytics?${query}`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(prismaMock.salesDailyMetric.findMany).not.toHaveBeenCalled();
  });

  it("accepts the maximum page and page size", async () => {
    mockAnalyticsData();
    const response = await server.request("GET", "/api/test/analytics?page=10000&limit=100");
    expect(response.status).toBe(200);
    expect(prismaMock.salesDailyMetric.findMany.mock.calls[0]?.[0]).toMatchObject({ skip: 999_900, take: 100 });
  });

  it.each(["orderId=not-a-uuid", `orderNumber=${"x".repeat(81)}`, "orderNumber=", "extra=1&orderNumber=OM-1"])(
    "rejects invalid Kanban lookups (%s) with 400",
    async (query) => {
      const response = await server.request("GET", `/api/test/kanban-status?${query}`);
      expect(response.status).toBe(400);
      expect(prismaMock.order.findFirst).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown analytics parameters with 400", async () => {
    const response = await server.request("GET", "/api/test/analytics?unexpected=1");
    expect(response.status).toBe(400);
  });

  it("returns the persisted Kanban state of a fixture order", async () => {
    const updatedAt = new Date("2026-10-20T12:00:00.000Z");
    prismaMock.order.findFirst.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000030",
      orderNumber: "OM-TEST-1001",
      status: "PENDING",
      position: 0,
      version: 1,
      updatedAt,
    });
    const response = await server.request("GET", "/api/test/kanban-status?orderNumber=OM-TEST-1001");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: "00000000-0000-4000-8000-000000000030",
      orderNumber: "OM-TEST-1001",
      status: "PENDING",
      position: 0,
      version: 1,
      updatedAt: updatedAt.toISOString(),
    });
    expect(prismaMock.order.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { orderNumber: "OM-TEST-1001", ownerId: TEST_ADMIN_ID },
    });
  });

  it("requires an order identifier for the Kanban lookup", async () => {
    const response = await server.request("GET", "/api/test/kanban-status");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("answers 404 for an unknown Kanban order", async () => {
    const response = await server.request("GET", "/api/test/kanban-status?orderNumber=OM-NOPE");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: "ORDER_NOT_FOUND", message: "Order not found." } });
  });

  it("rejects a reset without a Bearer token", async () => {
    const response = await server.request("POST", "/api/test/reset-data");
    expect(response.status).toBe(401);
    expect(resetTestDataMock).not.toHaveBeenCalled();
  });

  it("rejects a reset with a wrong Bearer token", async () => {
    const response = await server.request("POST", "/api/test/reset-data", { headers: { Authorization: "Bearer wrong" } });
    expect(response.status).toBe(401);
    expect(resetTestDataMock).not.toHaveBeenCalled();
  });

  it("restores the fixtures with the configured Bearer token", async () => {
    const response = await server.request("POST", "/api/test/reset-data", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reset: true, counts: { categories: 2, products: 2, orders: 3 } });
  });

  it("keeps the reset disabled in production unless explicitly allowed", async () => {
    process.env.NODE_ENV = "production";
    resetEnvForTests();
    try {
      const response = await server.request("POST", "/api/test/reset-data", { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ error: { code: "TEST_RESET_DISABLED" } });
    } finally {
      process.env.NODE_ENV = "test";
      resetEnvForTests();
    }
  });

  it("scopes audit reads to the signed-in account when a session exists", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    prismaMock.session.findUnique.mockResolvedValue({
      id: "s1",
      expires: new Date(Date.now() + 60_000),
      user: { id: userId, email: "evaluador@example.test", name: null, image: null, role: "OPERATOR" },
    });
    mockAnalyticsData();
    prismaMock.order.findFirst.mockResolvedValue({ id: "o1", orderNumber: "OM-1", status: "SHIPPED", position: 0, version: 2, updatedAt: new Date() });
    const cookie = { Cookie: "omni_session=evaluator-token" };

    expect((await server.request("GET", "/api/test/analytics", { headers: cookie })).status).toBe(200);
    expect((await server.request("GET", "/api/test/kanban-status?orderNumber=OM-1", { headers: cookie })).status).toBe(200);
    expect(prismaMock.salesDailyMetric.findMany.mock.calls[0]?.[0]).toMatchObject({ where: { ownerId: userId } });
    expect(prismaMock.order.findFirst.mock.calls[0]?.[0]).toMatchObject({ where: { orderNumber: "OM-1", ownerId: userId } });
  });

  it("never accepts an ownerId chosen by the caller", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    expect((await server.request("GET", `/api/test/analytics?ownerId=${other}`)).status).toBe(400);
    expect((await server.request("GET", `/api/test/kanban-status?orderNumber=OM-1&ownerId=${other}`)).status).toBe(400);
    expect(prismaMock.salesDailyMetric.findMany).not.toHaveBeenCalled();
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled();
  });

  it("keeps CRUD routes behind an OAuth session", async () => {
    const response = await server.request("GET", "/api/orders");
    expect(response.status).toBe(401);
  });
});
