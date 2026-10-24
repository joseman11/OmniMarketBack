import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError } from "../http/errors.js";

type Transaction = Prisma.TransactionClient;

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export interface StoredResponse {
  status: number;
  body: unknown;
}

/** The header is optional; when present it must be 1-255 visible ASCII characters. */
export function parseIdempotencyKey(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const key = header.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1-255 visible ASCII characters.");
  }
  return key;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** SHA-256 of the validated command with sorted keys, so formatting differences do not count as a different request. */
export function commandHash(command: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(command))).digest("hex");
}

/**
 * Runs inside the write transaction: waits for any concurrent request with the same key, then returns the stored
 * response for a repeated command or rejects a different command reusing the key with 409.
 */
export async function findIdempotentReplay(
  tx: Transaction,
  scope: { ownerId: string; operation: string; key: string },
  requestHash: string,
): Promise<StoredResponse | undefined> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`idempotency:${scope.ownerId}:${scope.operation}:${scope.key}`}, 0))`);
  const stored = await tx.idempotencyKey.findUnique({ where: { ownerId_operation_key: scope } });
  if (!stored) return undefined;
  if (stored.requestHash !== requestHash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with a different request.");
  }
  return { status: stored.responseStatus, body: stored.responseBody };
}

/** Saves the JSON exactly as the client receives it, in the same transaction as the write it describes. */
export async function saveIdempotentResponse(
  tx: Transaction,
  scope: { ownerId: string; operation: string; key: string },
  requestHash: string,
  response: StoredResponse,
): Promise<StoredResponse> {
  const body = JSON.parse(JSON.stringify(response.body)) as Prisma.InputJsonValue;
  await tx.idempotencyKey.create({
    data: { ...scope, requestHash, responseStatus: response.status, responseBody: body },
  });
  return { status: response.status, body };
}
