import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError } from "../../src/http/errors.js";
import { parseOrThrow } from "../../src/http/validation.js";

describe("request validation adapter", () => {
  it("returns parsed data including schema defaults", () => {
    const schema = z.object({ page: z.coerce.number().int().min(1).default(1) }).strict();

    expect(parseOrThrow(schema, {})).toEqual({ page: 1 });
    expect(parseOrThrow(schema, { page: "3" })).toEqual({ page: 3 });
  });

  it("converts Zod issues into a structured HTTP 400 error", () => {
    const schema = z.object({ email: z.string().email() }).strict();

    try {
      parseOrThrow(schema, { email: "not-an-email" });
      throw new Error("Expected validation to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({
        status: 400,
        code: "VALIDATION_ERROR",
        message: "The request contains invalid fields.",
      });
      expect((error as HttpError).details).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["email"] }),
      ]));
    }
  });
});
