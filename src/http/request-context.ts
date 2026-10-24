import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
import { logEvent, normalizeRoute } from "./logger.js";

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Reuses a well-formed upstream X-Request-Id or creates one, and echoes it to the client. */
export function assignRequestId(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.header("x-request-id");
  response.setHeader("X-Request-Id", incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID());
  next();
}

/** Logs method, normalized route, status and duration once per request (no query, headers or bodies). */
export function logRequests(request: Request, response: Response, next: NextFunction): void {
  const startedAt = performance.now();
  let logged = false;
  const log = (event: "http.request.completed" | "http.request.aborted") => {
    if (logged) return;
    logged = true;
    const status = response.statusCode;
    logEvent(status >= 500 ? "error" : status >= 400 ? "warn" : "info", event, {
      request_id: response.getHeader("X-Request-Id"),
      trace_id: request.header("x-vercel-id"),
      method: request.method,
      route: normalizeRoute(request.originalUrl),
      status_code: status,
      duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
      outcome: event === "http.request.aborted" ? "aborted" : status >= 400 ? "error" : "success",
      ...(request.authUser ? { actor_id: request.authUser.id } : {}),
    });
  };
  response.once("finish", () => log("http.request.completed"));
  response.once("close", () => log(response.writableFinished ? "http.request.completed" : "http.request.aborted"));
  next();
}
