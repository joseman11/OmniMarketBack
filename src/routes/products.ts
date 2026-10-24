import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { productInputSchema, updateProductSchema } from "../domain/validation.js";
import { isTestWorkspace } from "../domain/workspace.js";
import { HttpError } from "../http/errors.js";
import { parseOrThrow } from "../http/validation.js";
import { serializeProduct } from "../domain/serializers.js";

export const productsRouter = Router();
export const categoriesRouter = Router();

// Every account manages the catalog of its own workspace; rows are always filtered by ownerId.

const productListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  categoryId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
  active: z.enum(["true", "false"]).optional(),
}).strict();

const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
}).strict();

categoriesRouter.get("/", async (request, response) => {
  const categories = await prisma.category.findMany({
    where: { ownerId: request.authUser!.id },
    orderBy: { name: "asc" },
    include: { _count: { select: { products: true } } },
  });
  response.json({ items: categories });
});

categoriesRouter.post("/", async (request, response) => {
  const input = parseOrThrow(categoryInputSchema, request.body);
  const ownerId = request.authUser!.id;
  const category = await prisma.category.create({
    data: { ...input, ownerId, isTestData: isTestWorkspace(ownerId) },
  });
  response.status(201).json({ item: category });
});

categoriesRouter.patch("/:id", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const input = parseOrThrow(categoryInputSchema.partial().refine((value) => Object.keys(value).length > 0), request.body);
  const existing = await prisma.category.findFirst({ where: { id, ownerId: request.authUser!.id } });
  if (!existing) throw new HttpError(404, "CATEGORY_NOT_FOUND", "Category not found.");
  const category = await prisma.category.update({ where: { id }, data: input });
  response.json({ item: category });
});

categoriesRouter.delete("/:id", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const existing = await prisma.category.findFirst({ where: { id, ownerId: request.authUser!.id } });
  if (!existing) throw new HttpError(404, "CATEGORY_NOT_FOUND", "Category not found.");
  await prisma.category.delete({ where: { id } });
  response.status(204).end();
});

productsRouter.get("/", async (request, response) => {
  const query = parseOrThrow(productListQuery, request.query);
  const where: {
    ownerId: string;
    categoryId?: string;
    isActive?: boolean;
    OR?: Array<{ name?: { contains: string; mode: "insensitive" }; sku?: { contains: string; mode: "insensitive" } }>;
  } = { ownerId: request.authUser!.id };
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.active) where.isActive = query.active === "true";
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { sku: { contains: query.search, mode: "insensitive" } },
    ];
  }
  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      include: { category: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.product.count({ where }),
  ]);
  response.json({
    items: items.map(serializeProduct),
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  });
});

productsRouter.get("/:id", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const item = await prisma.product.findFirst({
    where: { id, ownerId: request.authUser!.id },
    include: { category: true },
  });
  if (!item) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product not found.");
  response.json({ item: serializeProduct(item) });
});

productsRouter.post("/", async (request, response) => {
  const input = parseOrThrow(productInputSchema, request.body);
  const ownerId = request.authUser!.id;
  const category = await prisma.category.findFirst({ where: { id: input.categoryId, ownerId } });
  if (!category) throw new HttpError(400, "CATEGORY_UNAVAILABLE", "The selected category is not available.");
  const item = await prisma.product.create({
    data: {
      ...input,
      sku: input.sku.toUpperCase(),
      ownerId,
      isTestData: isTestWorkspace(ownerId),
    },
    include: { category: true },
  });
  response.status(201).json({ item: serializeProduct(item) });
});

productsRouter.patch("/:id", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const input = parseOrThrow(updateProductSchema, request.body);
  const ownerId = request.authUser!.id;
  const current = await prisma.product.findFirst({ where: { id, ownerId } });
  if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product not found.");
  if (input.categoryId) {
    const category = await prisma.category.findFirst({ where: { id: input.categoryId, ownerId } });
    if (!category) throw new HttpError(400, "CATEGORY_UNAVAILABLE", "The selected category is not available.");
    if (current.categoryId !== input.categoryId) {
      const hasSales = await prisma.orderItem.count({ where: { productId: id } });
      if (hasSales > 0) {
        throw new HttpError(409, "CATEGORY_HAS_SALES", "A product with order history cannot be moved to another category.");
      }
    }
  }
  const item = await prisma.product.update({
    where: { id },
    data: { ...input, ...(input.sku ? { sku: input.sku.toUpperCase() } : {}) },
    include: { category: true },
  });
  response.json({ item: serializeProduct(item) });
});

productsRouter.delete("/:id", async (request, response) => {
  const id = parseOrThrow(z.string().uuid(), request.params.id);
  const existing = await prisma.product.findFirst({ where: { id, ownerId: request.authUser!.id } });
  if (!existing) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product not found.");
  await prisma.product.delete({ where: { id } });
  response.status(204).end();
});
