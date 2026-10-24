import { z } from "zod";
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
  items: z.array(itemInputSchema).min(1).max(100),
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

export const analyticsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  categoryId: z.string().uuid().optional(),
}).strict().refine(({ from, to }) => !from || !to || from <= to, {
  message: "The from date must be on or before the to date.",
  path: ["to"],
});

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
  ids: z.array(z.string().uuid()).min(1).max(100),
  status: orderStatusSchema,
}).strict().refine(({ ids }) => new Set(ids).size === ids.length, {
  message: "Order IDs must be unique.",
  path: ["ids"],
});

export const updateOrderSchema = z.object({
  items: z.array(itemInputSchema).min(1).max(100),
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
