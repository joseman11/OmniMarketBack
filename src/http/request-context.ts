import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Reuses a well-formed upstream X-Request-Id or creates one, and echoes it to the client. */
export function assignRequestId(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.header("x-request-id");
  response.setHeader("X-Request-Id", incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID());
  next();
}
