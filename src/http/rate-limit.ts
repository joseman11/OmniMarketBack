import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError } from "./errors.js";
import { logEvent } from "./logger.js";

export interface RateLimitPolicy {
  id: string;
  windowMs: number;
  max: number;
  /** Methods the policy applies to; all methods when omitted. */
  methods?: readonly string[];
}

/**
 * Generous per-client limits (fixed one-minute windows, keyed by client IP). On Vercel each function instance
 * keeps its own counters, so this is only a basic per-instance defence; a real shared quota needs a shared store.
 */
export const RATE_LIMITS = {
  audit: { id: "audit", windowMs: 60_000, max: 600 },
  auditReset: { id: "audit-reset", windowMs: 60_000, max: 30, methods: ["POST"] },
  analytics: { id: "analytics", windowMs: 60_000, max: 300, methods: ["GET"] },
  writes: { id: "writes", windowMs: 60_000, max: 300, methods: ["POST", "PATCH", "PUT", "DELETE"] },
} as const satisfies Record<string, RateLimitPolicy>;

const MAX_TRACKED_CLIENTS = 10_000;

const pseudonymize = (ip: string) => createHash("sha256").update(ip).digest("hex").slice(0, 16);

export function createRateLimiter(policy: RateLimitPolicy, now: () => number = Date.now): RequestHandler {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return (request: Request, response: Response, next: NextFunction) => {
    if (policy.methods && !policy.methods.includes(request.method)) return next();
    const time = now();
    if (windows.size >= MAX_TRACKED_CLIENTS) {
      for (const [key, window] of windows) if (window.resetAt <= time) windows.delete(key);
      // Bounded memory even under a flood of distinct addresses: start over rather than grow.
      if (windows.size >= MAX_TRACKED_CLIENTS) windows.clear();
    }
    const client = request.ip ?? "unknown";
    let window = windows.get(client);
    if (!window || window.resetAt <= time) {
      window = { count: 0, resetAt: time + policy.windowMs };
      windows.set(client, window);
    }
    window.count += 1;
    response.setHeader("RateLimit-Limit", String(policy.max));
    response.setHeader("RateLimit-Remaining", String(Math.max(0, policy.max - window.count)));
    if (window.count <= policy.max) return next();

    const retryAfterMs = window.resetAt - time;
    response.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    logEvent("warn", "security.rate_limited", {
      request_id: response.getHeader("X-Request-Id"),
      policy_id: policy.id,
      client: pseudonymize(client),
      retry_after_ms: retryAfterMs,
    });
    next(new HttpError(429, "RATE_LIMITED", "Too many requests; retry later."));
  };
}
