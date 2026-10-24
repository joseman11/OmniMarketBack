import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  API_ORIGIN: z.string().url().default("http://localhost:3001"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  ADMIN_EMAILS: z.string().default(""),
  TEST_API_TOKEN: z.string().default(""),
  ALLOW_TEST_DATA_RESET: z.string().default("false"),
  E2E_TEST_AUTH: z.string().default("false"),
});

export type AppEnvironment = z.infer<typeof schema>;

let cached: AppEnvironment | undefined;

export function getEnv(): AppEnvironment {
  cached ??= schema.parse(process.env);
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}
