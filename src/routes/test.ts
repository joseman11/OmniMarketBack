import { Router, type Request } from "express";
import { isTestTokenValid } from "./auth.js";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../http/errors.js";
import { getEnv } from "../config/env.js";
import { loadAnalytics } from "./analytics.js";
import { resetTestData } from "../services/test-fixtures.js";
import { loadKanbanStatus } from "./analytics.js";
import { TEST_ADMIN_ID } from "../domain/workspace.js";

export const testRouter = Router();

// Audit reads stay public: anonymous callers see the synthetic fixture workspace and a signed-in account sees
// its own workspace. The owner always comes from the session, never from a request parameter.
const auditOwnerId = (request: Request) => request.authUser?.id ?? TEST_ADMIN_ID;

/**
 * Every request is answered from PostgreSQL. Only the anonymous synthetic dataset may then be cached by the CDN;
 * a response for a session is that account's data. `Vary: Cookie` keeps a shared cache from answering a signed-in
 * request with the anonymous copy.
 */
export const ANONYMOUS_AUDIT_CACHE = "public, s-maxage=30, stale-while-revalidate=300";

testRouter.get("/analytics", async (request, response) => {
  const body = await loadAnalytics(request.query, auditOwnerId(request));
  response.vary("Cookie");
  if (request.authUser) {
    response.setHeader("Cache-Control", "private, no-store");
  } else {
    response.setHeader("Cache-Control", ANONYMOUS_AUDIT_CACHE);
    response.setHeader("Vercel-CDN-Cache-Control", ANONYMOUS_AUDIT_CACHE);
  }
  response.json(body);
});

testRouter.get("/kanban-status", async (request, response) => {
  response.json(await loadKanbanStatus(request.query, auditOwnerId(request)));
});

testRouter.post("/reset-data", async (request, response) => {
  const env = getEnv();
  if (env.NODE_ENV === "production" && env.ALLOW_TEST_DATA_RESET !== "true") {
    throw new HttpError(503, "TEST_RESET_DISABLED", "Test data reset is disabled for this environment.");
  }
  if (!env.TEST_API_TOKEN) {
    throw new HttpError(503, "TEST_RESET_DISABLED", "The test reset token has not been configured.");
  }
  if (!isTestTokenValid(request, env.TEST_API_TOKEN)) {
    throw new HttpError(401, "INVALID_TEST_TOKEN", "A valid test token is required.");
  }
  response.json({ reset: true, counts: await resetTestData(prisma) });
});

testRouter.get("/contract", (_request, response) => {
  response.json({
    endpoints: [
      "GET /api/test/analytics?page=1&limit=50",
      "POST /api/test/reset-data",
      "GET /api/test/kanban-status?orderNumber=OM-TEST-1001",
    ],
  });
});
