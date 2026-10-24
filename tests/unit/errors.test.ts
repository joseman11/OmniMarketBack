import { describe, expect, it } from "vitest";
import { errorResponse, HttpError } from "../../src/http/errors.js";

describe("HTTP error mapping", () => {
  it("preserves the status, code, message, and details of an HttpError", () => {
    const details = [{ path: ["name"], message: "Required" }];

    expect(errorResponse(new HttpError(400, "VALIDATION_ERROR", "Invalid input.", details))).toEqual({
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid input.", details } },
    });
  });

  it("omits details when the HttpError has none", () => {
    expect(errorResponse(new HttpError(401, "UNAUTHENTICATED", "Sign in."))).toEqual({
      status: 401,
      body: { error: { code: "UNAUTHENTICATED", message: "Sign in." } },
    });
  });

  it("maps Prisma unique constraint errors to conflict", () => {
    expect(errorResponse({ code: "P2002" })).toEqual({
      status: 409,
      body: { error: { code: "CONFLICT", message: "A record with these values already exists." } },
    });
  });

  it("maps Prisma foreign key errors to relation conflict", () => {
    expect(errorResponse({ code: "P2003" })).toEqual({
      status: 409,
      body: { error: { code: "RELATION_CONFLICT", message: "This record is still referenced by other records." } },
    });
  });

  it("maps Prisma required relation errors to relation conflict", () => {
    expect(errorResponse({ code: "P2014" })).toEqual({
      status: 409,
      body: { error: { code: "RELATION_CONFLICT", message: "This record is still referenced by other records." } },
    });
  });

  it("maps missing Prisma records to not found", () => {
    expect(errorResponse({ code: "P2025" })).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "The requested record was not found." } },
    });
  });

  it("hides unknown errors behind a generic internal error", () => {
    expect(errorResponse(new Error("database password should not leak"))).toEqual({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } },
    });
  });
});
