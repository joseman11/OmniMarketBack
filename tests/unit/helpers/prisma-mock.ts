import { vi, type Mock } from "vitest";

const modelMethods = [
  "findUnique", "findUniqueOrThrow", "findFirst", "findMany", "count", "aggregate",
  "create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany",
] as const;
type ModelMock = Record<(typeof modelMethods)[number], Mock>;
const models = [
  "user", "account", "session", "customer", "category", "product", "order", "orderItem",
  "orderStatusHistory", "salesDailyMetric", "idempotencyKey",
] as const;

export type PrismaMock = Record<(typeof models)[number], ModelMock> & {
  $transaction: Mock;
  $executeRaw: Mock;
  $queryRaw: Mock;
};

/** In-memory stand-in for the Prisma singleton: every model method is a vi.fn and transactions reuse the same mock. */
export const prismaMock = {} as PrismaMock;

export function resetPrismaMock(): void {
  for (const model of models) {
    const methods = Object.fromEntries(modelMethods.map((method) => [method, vi.fn().mockResolvedValue(null)])) as ModelMock;
    methods.findMany.mockResolvedValue([]);
    methods.count.mockResolvedValue(0);
    methods.updateMany.mockResolvedValue({ count: 1 });
    methods.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock[model] = methods;
  }
  prismaMock.$executeRaw = vi.fn().mockResolvedValue(0);
  prismaMock.$queryRaw = vi.fn().mockResolvedValue([]);
  prismaMock.$transaction = vi.fn(async (input: unknown) =>
    typeof input === "function" ? (input as (tx: PrismaMock) => unknown)(prismaMock) : Promise.all(input as unknown[]));
}

resetPrismaMock();

/** Joins the literal parts of a Prisma.sql tagged query so tests can assert on the statement text. */
export function sqlText(call: unknown[]): string {
  const query = call[0] as { strings?: string[]; sql?: string } | TemplateStringsArray;
  if (Array.isArray(query)) return query.join("?");
  const tagged = query as { strings?: string[]; sql?: string };
  return tagged.strings?.join("?") ?? tagged.sql ?? "";
}

export function decimal(value: string) {
  return { toFixed: () => value, toString: () => value };
}
