import type { Request, Response } from "express";
import { getEnv } from "../config/env.js";

export function readCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function appendCookie(
  response: Response,
  name: string,
  value: string,
  options: { maxAgeSeconds: number; path?: string; httpOnly?: boolean; sameSite?: "Lax" | "None" },
): void {
  const env = getEnv();
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${options.maxAgeSeconds}`,
    "SameSite=" + (options.sameSite ?? (env.NODE_ENV === "production" ? "None" : "Lax")),
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (env.NODE_ENV === "production") parts.push("Secure");
  response.append("Set-Cookie", parts.join("; "));
}

export function clearCookie(
  response: Response,
  name: string,
  path = "/",
  sameSite?: "Lax" | "None",
): void {
  appendCookie(response, name, "", {
    maxAgeSeconds: 0,
    path,
    ...(sameSite === undefined ? {} : { sameSite }),
  });
}
