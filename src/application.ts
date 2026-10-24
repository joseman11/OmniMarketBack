import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import helmet from "helmet";
import { attachSessionUser, requireAuth } from "./auth/middleware.js";
import { getEnv } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { errorResponse, HttpError } from "./http/errors.js";
import { describeError, logEvent, normalizeRoute } from "./http/logger.js";
import { assignRequestId, logRequests } from "./http/request-context.js";
import { analyticsRouter } from "./routes/analytics.js";
import { authRouter } from "./routes/auth.js";
import { ordersRouter } from "./routes/orders.js";
import { categoriesRouter, productsRouter } from "./routes/products.js";
import { testRouter } from "./routes/test.js";

const helmetFn: () => RequestHandler = ((helmet as unknown as { default?: () => RequestHandler })?.default ?? (helmet as unknown as () => RequestHandler));

export function createApp(app = express()) {
  const env = getEnv();
  if (env.NODE_ENV === "production") app.set("trust proxy", 1);

  const allowedOrigins = new Set([
    env.WEB_ORIGIN,
    ...env.CORS_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
  ]);
  app.use(assignRequestId);
  app.use(logRequests);
  app.use(helmetFn());
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      callback(new HttpError(403, "ORIGIN_NOT_ALLOWED", "This origin is not allowed."));
    },
  }));
  app.use(express.json({ limit: "1mb" }));
  app.use(attachSessionUser);

  app.get("/api/health", async (_request, response) => {
    await prisma.$queryRaw`SELECT 1`;
    response.status(200).json({ status: "ok", service: "omnimarket-api" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/analytics", requireAuth, analyticsRouter);
  app.use("/api/categories", requireAuth, categoriesRouter);
  app.use("/api/products", requireAuth, productsRouter);
  app.use("/api/orders", requireAuth, ordersRouter);
  app.use("/api/test", testRouter);

  app.use((_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "Route not found.")));

  const handleError: ErrorRequestHandler = (error, request, response, _next) => {
    const result = errorResponse(error);
    // Se registra también en producción (Runtime Logs de Vercel); al cliente solo llega el mensaje genérico.
    if (result.status === 500) {
      logEvent("error", "http.request.failed", {
        request_id: response.getHeader("X-Request-Id"),
        method: request.method,
        route: normalizeRoute(request.originalUrl),
        status_code: 500,
        error_code: result.body.error.code,
        ...describeError(error),
      });
    }
    response.status(result.status).json(result.body);
  };
  app.use(handleError);
  return app;
}
