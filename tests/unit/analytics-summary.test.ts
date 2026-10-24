import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock, resetPrismaMock } from "./helpers/prisma-mock.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { loadAnalytics } = await import("../../src/routes/analytics.js");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_A = "00000000-0000-4000-8000-0000000000aa";
const CATEGORY = { id: CATEGORY_A, name: "Category A", slug: "category-a" };

function mockAnalyticsResult(overrides: Record<string, unknown> = {}) {
  prismaMock.$queryRaw.mockResolvedValueOnce([{
    total: 1,
    items: [{ day: "2026-10-20", category: CATEGORY, ordersCount: 1, revenue: "120.00", avgTicket: "120.00", grossMargin: "75.00" }],
    ordersCount: 1,
    revenue: "120.00",
    grossMargin: "75.00",
    ...overrides,
  }]);
}

beforeEach(() => resetPrismaMock());

describe("analytics summary", () => {
  it("adds only the filtered category's lines: 120 in A and 2500 in B reports 120 for A", async () => {
    // The single order has 120.00 in category A and 2500.00 in category B; the old summary reported 2620.00.
    mockAnalyticsResult();

    const result = await loadAnalytics({ categoryId: CATEGORY_A }, OWNER_ID);

    expect(result.summary).toEqual({ ordersCount: 1, revenue: "120.00", avgTicket: "120.00", grossMargin: "75.00" });
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.$queryRaw.mock.calls[0]?.[0].values).toContain(CATEGORY_A);
  });

  it("reports zero for a category without sales", async () => {
    mockAnalyticsResult({ total: 0, items: [], ordersCount: 0, revenue: "0", grossMargin: "0" });
    const result = await loadAnalytics({ categoryId: CATEGORY_A }, OWNER_ID);
    expect(result.summary).toEqual({ ordersCount: 0, revenue: "0.00", avgTicket: "0.00", grossMargin: "0.00" });
    expect(result.pagination).toMatchObject({ total: 0, totalPages: 0 });
  });

  it("keeps whole-order totals without a category filter so multi-category orders are counted once", async () => {
    mockAnalyticsResult({ ordersCount: 1, revenue: "2620.00", grossMargin: "775.00" });
    const result = await loadAnalytics({}, OWNER_ID);
    expect(result.summary).toEqual({ ordersCount: 1, revenue: "2620.00", avgTicket: "2620.00", grossMargin: "775.00" });
    expect(prismaMock.$queryRaw.mock.calls[0]?.[0].values).not.toContain(CATEGORY_A);
  });

  it("averages totals above DECIMAL(12,2) instead of failing with a RangeError", async () => {
    // Two valid orders of 5 000 000 000.00 add up to 10 000 000 000.00, beyond the per-order parser's range.
    mockAnalyticsResult({ ordersCount: 2, revenue: "10000000000.00", grossMargin: "4000000000.00" });
    const result = await loadAnalytics({}, OWNER_ID);
    expect(result.summary).toEqual({
      ordersCount: 2,
      revenue: "10000000000.00",
      avgTicket: "5000000000.00",
      grossMargin: "4000000000.00",
    });
  });
});
