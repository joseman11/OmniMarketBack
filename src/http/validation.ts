import type { ZodTypeAny, output } from "zod";
import { HttpError } from "./errors.js";

/** Upper bound on validation issues returned to the client, so one request cannot produce a huge error body. */
export const MAX_VALIDATION_ISSUES = 20;

export function parseOrThrow<T extends ZodTypeAny>(schema: T, input: unknown): output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(400, "VALIDATION_ERROR", "The request contains invalid fields.", result.error.issues.slice(0, MAX_VALIDATION_ISSUES));
  }
  return result.data;
}
