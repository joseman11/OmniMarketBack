import { defineRailway, postgres, preserve, project, service } from "railway/iac";

// Railway currently recommends Infrastructure as Code for new services.
// The GitHub source is intentionally attached in Railway after the repository
// and owner are known; this file declares the service and managed database.
export default defineRailway(() => {
  const database = postgres("omnimarket-postgres");
  const api = service("omnimarket-backend", {
    build: "npm run build",
    start: "npm run start",
    preDeploy: "npm run db:migrate && npm run db:seed",
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    env: {
      DATABASE_URL: database.env.DATABASE_URL,
      NODE_ENV: "production",
      ALLOW_TEST_DATA_RESET: "true",
      API_ORIGIN: preserve(),
      WEB_ORIGIN: preserve(),
      CORS_ALLOWED_ORIGINS: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      GITHUB_CLIENT_ID: preserve(),
      GITHUB_CLIENT_SECRET: preserve(),
      ADMIN_EMAILS: preserve(),
      TEST_API_TOKEN: preserve(),
    },
  });

  return project("OmniMarket Operations Hub", { resources: [database, api] });
});
