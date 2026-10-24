import { randomUUID } from "node:crypto";

type Level = "info" | "warn" | "error";

const instanceId = randomUUID().slice(0, 8);
const serviceVersion = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? process.env.npm_package_version ?? "dev";

const MAX_MESSAGE = 500;
const MAX_STACK_FRAMES = 15;

// Secrets that can appear inside error messages or stacks: connection strings, Bearer tokens,
// OAuth parameters and session cookies. Order matters: URLs first so their query is dropped too.
const redactions: Array<[RegExp, string]> = [
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|prisma):\/\/[^\s'"`]+/gi, "[redacted-connection-string]"],
  [/\bhttps?:\/\/[^\s'"`]*@[^\s'"`]+/gi, "[redacted-url]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [/\b(code|state|code_verifier|access_token|refresh_token|id_token|client_secret|token|password|session_token)=[^&\s'"`]+/gi, "$1=[redacted]"],
  [/("?(?:access_token|refresh_token|id_token|client_secret|code_verifier|password|authorization|cookie|session_token)"?\s*:\s*)"[^"]*"/gi, "$1\"[redacted]\""],
  [/\b(omni_[a-z_]+=)[^;\s'"`]+/gi, "$1[redacted]"],
];

export function sanitize(text: string): string {
  return redactions.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

/** Keeps only stack frames: Prisma repeats its full message (including query arguments) in the stack header. */
function sanitizeStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const frames = stack.split("\n").filter((line) => /^\s+at /.test(line)).slice(0, MAX_STACK_FRAMES);
  return frames.length ? sanitize(frames.map((line) => line.trim()).join("\n")) : undefined;
}

/** Prisma invocation errors embed the call arguments (request data); their last line carries the cause. */
function errorMessage(error: Error): string {
  const lines = error.message.split("\n").map((line) => line.trim()).filter(Boolean);
  const message = error.name.startsWith("PrismaClient") ? (lines.at(-1) ?? "") : lines.join(" ");
  return sanitize(message).slice(0, MAX_MESSAGE);
}

export function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error_name: typeof error, error_message: "Non-Error value thrown." };
  const code = (error as { code?: unknown }).code;
  return {
    error_name: error.name,
    error_message: errorMessage(error),
    ...(typeof code === "string" && /^[A-Z0-9_]{1,40}$/i.test(code) ? { error_cause_code: code } : {}),
    stack: sanitizeStack(error.stack),
  };
}

/** One JSON line per event on stdout/stderr, which Vercel collects as Runtime Logs. */
export function logEvent(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "omnimarket-api",
    service_version: serviceVersion,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    instance_id: instanceId,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path without query string and with identifiers collapsed, so logs never carry callback parameters or IDs. */
export function normalizeRoute(originalUrl: string): string {
  const path = originalUrl.split("?")[0] ?? "/";
  return path
    .split("/")
    .map((segment) => (UUID_SEGMENT.test(segment) ? ":id" : /^\d+$/.test(segment) ? ":n" : segment))
    .join("/")
    .slice(0, 200);
}
