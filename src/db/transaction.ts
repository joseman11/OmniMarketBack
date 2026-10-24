import { setTimeout as sleep } from "node:timers/promises";
import { HttpError } from "../http/errors.js";
import { logEvent } from "../http/logger.js";

const MAX_ATTEMPTS = 3;
// Stays well inside the default Vercel function timeout (10 s on Hobby) even with three attempts.
const DEADLINE_MS = 8_000;
const BASE_DELAY_MS = 25;

/** Only aborts that PostgreSQL resolves by killing one transaction: write conflicts, deadlocks, serialization failures. */
export function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof HttpError) return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  if (candidate?.code === "P2034") return true;
  if (candidate?.code === "40001" || candidate?.code === "40P01") return true;
  if (candidate?.meta?.code === "40001" || candidate?.meta?.code === "40P01") return true;
  return typeof candidate?.message === "string" && /deadlock detected|could not serialize access/i.test(candidate.message);
}

/**
 * Re-runs a whole transaction after a retryable abort: at most 3 attempts, short random backoff and a deadline.
 * Business conflicts (HttpError, e.g. 409 for a stale expectedVersion) are never retried.
 */
export async function withTransactionRetry<T>(operation: string, run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + DEADLINE_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const delay = Math.round(BASE_DELAY_MS * attempt * (1 + Math.random()));
      if (attempt >= MAX_ATTEMPTS || !isRetryableTransactionError(error) || Date.now() + delay >= deadline) throw error;
      logEvent("warn", "transaction.retry", {
        operation,
        attempt,
        prisma_code: (error as { code?: unknown }).code,
        retry_delay_ms: delay,
        deadline_remaining_ms: deadline - Date.now(),
      });
      await sleep(delay);
    }
  }
}
