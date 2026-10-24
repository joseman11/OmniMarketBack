import { describe, expect, it } from "vitest";
import { utcDayBounds } from "../../src/services/analytics.js";
import { isTestWorkspace, TEST_ADMIN_ID } from "../../src/domain/workspace.js";

describe("workspace isolation helpers", () => {
  it("recognizes only the dedicated test administrator workspace", () => {
    expect(isTestWorkspace(TEST_ADMIN_ID)).toBe(true);
    expect(isTestWorkspace("00000000-0000-4000-8000-000000000002")).toBe(false);
  });
});

describe("UTC analytics bounds", () => {
  it("includes both requested calendar days using an exclusive next-day end", () => {
    expect(utcDayBounds("2026-10-20", "2026-10-21")).toEqual({
      gte: new Date("2026-10-20T00:00:00.000Z"),
      lt: new Date("2026-10-22T00:00:00.000Z"),
    });
  });

  it("handles month and year transitions without local timezone arithmetic", () => {
    expect(utcDayBounds(undefined, "2024-12-31").lt?.toISOString())
      .toBe("2025-01-01T00:00:00.000Z");
  });

  it("omits bounds that were not requested", () => {
    expect(utcDayBounds()).toEqual({});
    expect(utcDayBounds("2026-10-20")).toEqual({ gte: new Date("2026-10-20T00:00:00.000Z") });
  });
});
