import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../http/errors.js";
import { readCookie } from "./cookies.js";
import { hashSessionToken, SESSION_COOKIE } from "./session.js";

export async function attachSessionUser(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return next();

  const session = await prisma.session.findUnique({
    where: { sessionToken: hashSessionToken(token) },
    include: { user: true },
  });
  if (!session) return next();
  if (session.expires <= new Date()) {
    await prisma.session.delete({ where: { id: session.id } });
    return next();
  }

  request.authUser = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image,
    role: session.user.role,
  };
  next();
}

export function requireAuth(request: Request, _response: Response, next: NextFunction): void {
  if (!request.authUser) return next(new HttpError(401, "UNAUTHENTICATED", "Sign in with Google or GitHub to continue."));
  next();
}

export function requireAdmin(request: Request, _response: Response, next: NextFunction): void {
  if (request.authUser?.role !== "ADMIN") {
    return next(new HttpError(403, "FORBIDDEN", "Administrator access is required."));
  }
  next();
}
