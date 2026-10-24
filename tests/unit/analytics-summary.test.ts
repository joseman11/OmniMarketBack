import { beforeEach, describe, expect, it, vi } from "vitest";
import { decimal, prismaMock, resetPrismaMock } from "./helpers/prisma-mock.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { loadAnalytics } = await import("../../src/routes/analytics.js");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_A = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => resetPrismaMock());

describe("analytics summary", () => {
  it("adds only the filtered category's lines: 120 in A and 2500 in B reports 120 for A", async () => {
    // The single order has 120.00 in category A and 2500.00 in category B; the old summary reported 2620.00.
    prismaMock.order.aggregate.mockResolvedValue({ _count: { _all: 1 }, _sum: { total: decimal("2620.00"), margin: decimal("775.00") } });
    prismaMock.salesDailyMetric.aggregate.mockResolvedValue({
      _sum: { ordersCount: 1, revenue: decimal("120.00"), grossMargin: decimal("75.00") },
    });

    const result = await loadAnalytics({ categoryId: CATEGORY_A }, OWNER_ID);

    expect(result.summary).toEqual({ ordersCount: 1, revenue: "120.00", avgTicket: "120.00", grossMargin: "75.00" });
    expect(prismaMock.order.aggregate).not.toHaveBeenCalled();
    expect(prismaMock.salesDailyMetric.aggregate.mock.calls[0]?.[0]).toMatchObject({
      where: { ownerId: OWNER_ID, categoryId: CATEGORY_A },
    });
  });

  it("reports zero for a category without sales", async () => {
    prismaMock.salesDailyMetric.aggregate.mockResolvedValue({ _sum: { ordersCount: null, revenue: null, grossMargin: null } });
    const result = await loadAnalytics({ categoryId: CATEGORY_A }, OWNER_ID);
    expect(result.summary).toEqual({ ordersCount: 0, revenue: "0.00", avgTicket: "0.00", grossMargin: "0.00" });
  });

  it("keeps whole-order totals without a category filter so multi-category orders are counted once", async () => {
    prismaMock.order.aggregate.mockResolvedValue({ _count: { _all: 1 }, _sum: { total: decimal("2620.00"), margin: decimal("775.00") } });
    const result = await loadAnalytics({}, OWNER_ID);
    expect(result.summary).toEqual({ ordersCount: 1, revenue: "2620.00", avgTicket: "2620.00", grossMargin: "775.00" });
    expect(prismaMock.salesDailyMetric.aggregate).not.toHaveBeenCalled();
  });

  it("averages totals above DECIMAL(12,2) instead of failing with a RangeError", async () => {
    // Two valid orders of 5 000 000 000.00 add up to 10 000 000 000.00, beyond the per-order parser's range.
    prismaMock.order.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _sum: { total: decimal("10000000000.00"), margin: decimal("4000000000.00") },
    });
    const result = await loadAnalytics({}, OWNER_ID);
    expect(result.summary).toEqual({
      ordersCount: 2,
      revenue: "10000000000.00",
      avgTicket: "5000000000.00",
      grossMargin: "4000000000.00",
    });
  });
});
