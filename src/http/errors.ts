export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorResponse(error: unknown): {
  status: number;
  body: { error: { code: string; message: string; details?: unknown } };
} {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }

  // express.json() (body-parser) marks client mistakes with a type and an exposable 4xx status.
  const parserError = error as { type?: unknown; status?: unknown; expose?: unknown } | null;
  if (parserError?.type === "entity.parse.failed") {
    return { status: 400, body: { error: { code: "INVALID_JSON", message: "The request body is not valid JSON." } } };
  }
  if (parserError?.type === "entity.too.large") {
    return { status: 413, body: { error: { code: "PAYLOAD_TOO_LARGE", message: "The request body exceeds the 1 MB limit." } } };
  }
  if (
    parserError?.expose === true && typeof parserError.status === "number" &&
    parserError.status >= 400 && parserError.status < 500
  ) {
    return { status: parserError.status, body: { error: { code: "BAD_REQUEST", message: "The request body could not be read." } } };
  }

  const prismaCode = (error as { code?: unknown } | null)?.code;
  if (prismaCode === "P2002") {
    return {
      status: 409,
      body: { error: { code: "CONFLICT", message: "A record with these values already exists." } },
    };
  }
  if (prismaCode === "P2003" || prismaCode === "P2014") {
    return {
      status: 409,
      body: { error: { code: "RELATION_CONFLICT", message: "This record is still referenced by other records." } },
    };
  }
  if (prismaCode === "P2025") {
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "The requested record was not found." } } };
  }

  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } },
  };
}
