import { Router } from "express";
import { isTestTokenValid } from "./auth.js";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../http/errors.js";
import { getEnv } from "../config/env.js";
import { loadAnalytics } from "./analytics.js";
import { resetTestData } from "../services/test-fixtures.js";
import { loadKanbanStatus } from "./analytics.js";

export const testRouter = Router();

testRouter.get("/analytics", async (request, response) => {
  response.json(await loadAnalytics(request.query, true));
});

testRouter.get("/kanban-status", async (request, response) => {
  response.json(await loadKanbanStatus(request.query));
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
