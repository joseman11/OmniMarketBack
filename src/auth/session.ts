import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { User } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { appendCookie, clearCookie } from "./cookies.js";

export const SESSION_COOKIE = "omni_session";
const SESSION_DAYS = 30;

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string, response: Response): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: { userId, sessionToken: hashSessionToken(token), expires },
  });
  appendCookie(response, SESSION_COOKIE, token, {
    maxAgeSeconds: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function deleteSession(token: string | undefined, response: Response): Promise<void> {
  if (token) {
    await prisma.session.deleteMany({ where: { sessionToken: hashSessionToken(token) } });
  }
  clearCookie(response, SESSION_COOKIE);
}

export function publicUser(user: Pick<User, "id" | "email" | "name" | "image" | "role">) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    role: user.role,
  };
}
