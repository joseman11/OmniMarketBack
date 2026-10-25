import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as typeof globalThis & { omniPrisma?: PrismaClient };

// One client per process, kept on globalThis in every environment: a warm Vercel function reuses its connection
// pool across invocations instead of opening a new one per request (and dev reloads do not leak clients).
export const prisma = globalForPrisma.omniPrisma ?? new PrismaClient();

globalForPrisma.omniPrisma = prisma;
