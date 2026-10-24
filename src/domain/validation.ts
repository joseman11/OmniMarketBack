import { z, type ZodTypeAny } from "zod";
import { isMoneyInput } from "./money.js";

export const orderStatusSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
]);

export const moneySchema = z.union([z.string(), z.number()]).refine(isMoneyInput, {
  message: "Enter a non-negative amount with up to two decimal places.",
});

/**
 * Array whose length is checked before any element schema runs: an oversized array yields a single issue
 * instead of one or more issues per element (zod keeps validating every element after .max() fails).
 */
export function boundedArray<T extends ZodTypeAny>(element: T, min: number, max: number) {
  return z.array(z.unknown()).min(min).max(max).pipe(z.array(element));
}

export const itemInputSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(1_000_000),
}).strict();

export const createOrderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(1).max(160),
    email: z.string().trim().email().max(254),
    city: z.string().trim().max(120).optional(),
  }).strict(),
  items: boundedArray(itemInputSchema, 1, 100),
}).strict();

export const orderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: orderStatusSchema.optional(),
  search: z.string().trim().max(120).optional(),
}).strict();

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, { message: "Enter a valid calendar date in YYYY-MM-DD format." });

/** Explicit pagination caps: a page beyond 10 000 (1 000 000 rows at the largest page size) is rejected. */
export const MAX_PAGE = 10_000;
export const MAX_PAGE_SIZE = 100;

export const analyticsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  categoryId: z.string().uuid().optional(),
}).strict().refine(({ from, to }) => !from || !to || from <= to, {
  message: "The from date must be on or before the to date.",
  path: ["to"],
});

export const kanbanStatusQuerySchema = z.object({
  orderId: z.string().uuid().optional(),
  orderNumber: z.string().min(1).max(80).optional(),
}).strict().refine((value) => Boolean(value.orderId || value.orderNumber), { message: "Provide orderId or orderNumber." });

export const productInputSchema = z.object({
  categoryId: z.string().uuid(),
  sku: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(180),
  price: moneySchema,
  cost: moneySchema,
  stock: z.number().int().min(0).max(2_000_000).default(0),
  isActive: z.boolean().default(true),
}).strict();

export const updateProductSchema = productInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one product field must be provided." },
);

export const moveOrderSchema = z.object({
  status: orderStatusSchema,
  position: z.number().int().min(0).max(2_000_000),
  expectedVersion: z.number().int().min(1),
}).strict();

export const bulkOrderSchema = z.object({
  ids: boundedArray(z.string().uuid(), 1, 100),
  status: orderStatusSchema,
}).strict().refine(({ ids }) => new Set(ids).size === ids.length, {
  message: "Order IDs must be unique.",
  path: ["ids"],
});

export const updateOrderSchema = z.object({
  items: boundedArray(itemInputSchema, 1, 100),
  expectedVersion: z.number().int().min(1),
}).strict();

export function filterOrderStatuses<T extends { status: string }>(
  orders: readonly T[],
  status?: string,
): T[] {
  return status ? orders.filter((order) => order.status === status) : [...orders];
}

export function dateRangeWhere(from?: string, to?: string): { gte?: Date; lt?: Date } {
  const where: { gte?: Date; lt?: Date } = {};
  if (from) where.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) {
    const end = new Date(`${to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    where.lt = end;
  }
  return where;
}
