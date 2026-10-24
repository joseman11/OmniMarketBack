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
