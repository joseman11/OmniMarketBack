import type { ZodType } from "zod";
import { HttpError } from "./errors.js";

export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(400, "VALIDATION_ERROR", "The request contains invalid fields.", result.error.issues);
  }
  return result.data;
}
