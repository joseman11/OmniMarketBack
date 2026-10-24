import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as typeof globalThis & { omniPrisma?: PrismaClient };

export const prisma = globalForPrisma.omniPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.omniPrisma = prisma;
