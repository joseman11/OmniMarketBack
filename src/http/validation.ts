import type { ZodTypeAny, output } from "zod";
import { HttpError } from "./errors.js";

export function parseOrThrow<T extends ZodTypeAny>(schema: T, input: unknown): output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(400, "VALIDATION_ERROR", "The request contains invalid fields.", result.error.issues);
  }
  return result.data;
}
