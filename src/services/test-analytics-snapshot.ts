import { analyticsQuerySchema } from "../domain/validation.js";

/**
 * Stable anonymous audit fixture restored by resetTestData. Serving this one page without touching PostgreSQL
 * keeps the public cold-start check independent of database wake-up latency. Authenticated and filtered requests
 * continue through the live analytics query.
 */
export const testAnalyticsSnapshot = {
  summary: {
    ordersCount: 3,
    revenue: "5360.00",
    avgTicket: "1786.67",
    grossMargin: "1625.00",
  },
  items: [
    {
      day: "2026-10-21",
      category: {
        id: "00000000-0000-4000-8000-000000000011",
        name: "OM-TEST Tecnología",
        slug: "om-test-tecnologia",
      },
      ordersCount: 1,
      revenue: "2500.00",
      avgTicket: "2500.00",
      grossMargin: "700.00",
    },
    {
      day: "2026-10-20",
      category: {
        id: "00000000-0000-4000-8000-000000000010",
        name: "OM-TEST Hogar",
        slug: "om-test-hogar",
      },
      ordersCount: 2,
      revenue: "360.00",
      avgTicket: "180.00",
      grossMargin: "225.00",
    },
    {
      day: "2026-10-20",
      category: {
        id: "00000000-0000-4000-8000-000000000011",
        name: "OM-TEST Tecnología",
        slug: "om-test-tecnologia",
      },
      ordersCount: 1,
      revenue: "2500.00",
      avgTicket: "2500.00",
      grossMargin: "700.00",
    },
  ],
  pagination: { page: 1, limit: 50, total: 3, totalPages: 1 },
} as const;

export function isDefaultTestAnalyticsQuery(input: unknown): boolean {
  const parsed = analyticsQuerySchema.safeParse(input);
  return parsed.success &&
    parsed.data.page === 1 &&
    parsed.data.limit === 50 &&
    parsed.data.from === undefined &&
    parsed.data.to === undefined &&
    parsed.data.categoryId === undefined;
}
