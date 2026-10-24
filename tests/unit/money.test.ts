import { describe, expect, it } from "vitest";
import { averageCents, calculateOrderAmounts, formatCurrency, fromCents, isMoneyInput, toCents } from "../../src/domain/money.js";

describe("financial calculations", () => {
  it("accepts decimal money with at most two fractional digits", () => {
    expect(isMoneyInput("1234.50")).toBe(true);
    expect(isMoneyInput("12.345")).toBe(false);
  });

  it("converts amounts to integer cents without floating point rounding", () => {
    expect(toCents("19.99")).toBe(1999n);
    expect(fromCents(2001n)).toBe("20.01");
  });

  it("calculates an order total across multiple lines", () => {
    expect(calculateOrderAmounts([
      { quantity: 2, unitPrice: "120.00", unitCost: "45.00" },
      { quantity: 1, unitPrice: "250.00", unitCost: "130.00" },
    ])).toEqual({ total: "490.00", margin: "270.00" });
  });

  it("preserves a negative margin when item cost exceeds price", () => {
    expect(calculateOrderAmounts([
      { quantity: 1, unitPrice: "10.00", unitCost: "12.50" },
    ])).toEqual({ total: "10.00", margin: "-2.50" });
  });

  it("rejects fractional cents instead of silently rounding a price", () => {
    expect(() => toCents("1.005")).toThrow(RangeError);
  });

  it("rejects non-positive quantities", () => {
    expect(() => calculateOrderAmounts([
      { quantity: 0, unitPrice: "10.00", unitCost: "5.00" },
    ])).toThrow(/positive integer/);
  });

  it("rounds an average ticket to the nearest cent", () => {
    expect(fromCents(averageCents(100n, 3))).toBe("0.33");
    expect(fromCents(averageCents(101n, 2))).toBe("0.51");
  });

  it("formats currency using the requested locale and currency", () => {
    expect(formatCurrency("1250.00", "MXN", "es-MX")).toContain("1,250.00");
    expect(formatCurrency("1250.00", "USD", "en-US")).toContain("$1,250.00");
  });

  it("accepts the maximum DECIMAL(12,2) order total", () => {
    expect(calculateOrderAmounts([
      { quantity: 1, unitPrice: "9999999999.99", unitCost: "0.00" },
    ])).toEqual({ total: "9999999999.99", margin: "9999999999.99" });
  });

  it("rejects order totals that exceed DECIMAL(12,2)", () => {
    expect(() => calculateOrderAmounts([
      { quantity: 2, unitPrice: "9999999999.99", unitCost: "0.00" },
    ])).toThrow(/supported DECIMAL/);
  });

  it("returns zero for an empty average and rejects invalid counts", () => {
    expect(averageCents(1200n, 0)).toBe(0n);
    expect(() => averageCents(1200n, -1)).toThrow(/non-negative integer/);
  });
});
