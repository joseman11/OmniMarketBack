import { Prisma, type OrderStatus } from "@prisma/client";

type Transaction = Prisma.TransactionClient;

/**
 * Serializes writers of the same Kanban columns of one workspace with transaction-scoped advisory locks.
 * Keys are sorted so concurrent transactions always lock in the same order and cannot deadlock each other.
 * Transaction-level locks are released on COMMIT/ROLLBACK, so they are safe behind a transaction-mode pooler.
 */
export async function lockBoardColumns(tx: Transaction, ownerId: string, statuses: readonly OrderStatus[]): Promise<void> {
  for (const status of [...new Set(statuses)].sort()) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`board:${ownerId}:${status}`}, 0))`);
  }
}
