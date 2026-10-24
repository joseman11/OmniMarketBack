export interface PricedQuantity {
  quantity: number;
  unitPrice: string | number;
  unitCost: string | number;
}

export interface OrderAmounts {
  total: string;
  margin: string;
}

const MONEY_PATTERN = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const MAX_DB_CENTS = 999_999_999_999n;

export function isMoneyInput(value: unknown): value is string | number {
  return (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) &&
    MONEY_PATTERN.test(String(value));
}

export function toCents(value: string | number): bigint {
  const normalized = String(value);
  if (!MONEY_PATTERN.test(normalized)) {
    throw new RangeError("Money values must have at most two decimal places and fit DECIMAL(12,2).");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

const AGGREGATE_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;

/**
 * Converts an accumulated amount (a SUM over many rows, e.g. Decimal.toFixed(2)) to cents. Unlike toCents it
 * accepts any number of integer digits and a sign, because aggregates legitimately exceed DECIMAL(12,2).
 */
export function aggregateToCents(value: string): bigint {
  if (!AGGREGATE_PATTERN.test(value)) throw new RangeError("Aggregated amounts must be decimal strings with up to two decimals.");
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}

export function fromCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function averageCents(totalCents: bigint, count: number): bigint {
  if (!Number.isInteger(count) || count < 0) throw new RangeError("Count must be a non-negative integer.");
  if (count === 0) return 0n;
  const divisor = BigInt(count);
  const half = divisor / 2n;
  return totalCents >= 0n
    ? (totalCents + half) / divisor
    : (totalCents - half) / divisor;
}

export function calculateOrderAmounts(items: readonly PricedQuantity[]): OrderAmounts {
  if (items.length === 0) throw new RangeError("An order must contain at least one item.");
  let totalCents = 0n;
  let marginCents = 0n;

  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new RangeError("Item quantity must be a positive integer.");
    }
    const priceCents = toCents(item.unitPrice);
    const costCents = toCents(item.unitCost);
    totalCents += priceCents * BigInt(item.quantity);
    marginCents += (priceCents - costCents) * BigInt(item.quantity);
  }

  if (totalCents > MAX_DB_CENTS || marginCents > MAX_DB_CENTS || marginCents < -MAX_DB_CENTS) {
    throw new RangeError("Order amounts exceed the supported DECIMAL(12,2) range.");
  }
  return { total: fromCents(totalCents), margin: fromCents(marginCents) };
}

export function formatCurrency(
  amount: string | number,
  currency = "MXN",
  locale = "es-MX",
): string {
  const cents = toCents(amount);
  const numeric = Number(cents) / 100;
  if (!Number.isFinite(numeric)) throw new RangeError("Amount is outside the supported range.");
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}
