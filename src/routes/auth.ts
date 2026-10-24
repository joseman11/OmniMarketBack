import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Prisma } from "@prisma/client";
import { getEnv } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../http/errors.js";
import { appendCookie, clearCookie, readCookie } from "../auth/cookies.js";
import { createSession, deleteSession, publicUser, SESSION_COOKIE } from "../auth/session.js";
import { TEST_ADMIN_ID } from "../services/test-fixtures.js";
import { requireAuth } from "../auth/middleware.js";

export const authRouter = Router();

type Provider = "google" | "github";
type Identity = {
  provider: Provider;
  providerAccountId: string;
  email: string;
  name: string | null;
  image: string | null;
};

const callbackPath = (provider: Provider) => `/api/auth/${provider}/callback`;
const stateCookie = (provider: Provider) => `omni_${provider}_oauth_state`;
const verifierCookie = (provider: Provider) => `omni_${provider}_oauth_verifier`;
const returnToCookie = (provider: Provider) => `omni_${provider}_oauth_return_to`;
const stateLifetime = 10 * 60;

function safeReturnPath(value: unknown): string {
  if (typeof value !== "string") return "/dashboard";
  try {
    const origin = new URL(getEnv().WEB_ORIGIN).origin;
    const target = new URL(value, origin);
    if (target.origin !== origin) return "/dashboard";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/dashboard";
  }
}

function providerCredentials(provider: Provider): { id: string; secret: string } {
  const env = getEnv();
  return provider === "google"
    ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
    : { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET };
}

function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function createChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function startOAuth(provider: Provider, request: Request, response: Response): void {
  const credentials = providerCredentials(provider);
  if (!credentials.id || !credentials.secret) {
    throw new HttpError(503, "OAUTH_NOT_CONFIGURED", `${provider} sign-in is not configured.`);
  }

  const state = createVerifier();
  const verifier = createVerifier();
  appendCookie(response, stateCookie(provider), state, {
    maxAgeSeconds: stateLifetime,
    path: callbackPath(provider),
    sameSite: "Lax",
  });
  appendCookie(response, verifierCookie(provider), verifier, {
    maxAgeSeconds: stateLifetime,
    path: callbackPath(provider),
    sameSite: "Lax",
  });
  appendCookie(response, returnToCookie(provider), safeReturnPath(request.query.returnTo), {
    maxAgeSeconds: stateLifetime,
    path: callbackPath(provider),
    sameSite: "Lax",
  });

  const authorizeUrl = new URL(
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://github.com/login/oauth/authorize",
  );
  authorizeUrl.searchParams.set("client_id", credentials.id);
  authorizeUrl.searchParams.set("redirect_uri", new URL(callbackPath(provider), getEnv().API_ORIGIN).toString());
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", createChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set(
    "scope",
    provider === "google" ? "openid email profile" : "read:user user:email",
  );
  if (provider === "google") authorizeUrl.searchParams.set("access_type", "online");
  response.redirect(302, authorizeUrl.toString());
}

async function exchangeCode(provider: Provider, code: string, verifier: string): Promise<string> {
  const credentials = providerCredentials(provider);
  const tokenUrl = provider === "google"
    ? "https://oauth2.googleapis.com/token"
    : "https://github.com/login/oauth/access_token";
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: credentials.id,
      client_secret: credentials.secret,
      code,
      redirect_uri: new URL(callbackPath(provider), getEnv().API_ORIGIN).toString(),
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new HttpError(502, "OAUTH_TOKEN_EXCHANGE_FAILED", "The identity provider rejected sign-in.");
  const result = await response.json() as { access_token?: string; error?: string };
  if (!result.access_token) throw new HttpError(401, "OAUTH_TOKEN_INVALID", "The identity provider did not return an access token.");
  return result.access_token;
}

async function fetchIdentity(provider: Provider, accessToken: string): Promise<Identity> {
  if (provider === "google") {
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new HttpError(401, "OAUTH_PROFILE_FAILED", "Could not verify the Google account.");
    const profile = await response.json() as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (!profile.sub || !profile.email || profile.email_verified !== true) {
      throw new HttpError(401, "OAUTH_EMAIL_UNVERIFIED", "Google must provide a verified email address.");
    }
    return {
      provider,
      providerAccountId: profile.sub,
      email: profile.email.toLowerCase(),
      name: profile.name ?? null,
      image: profile.picture ?? null,
    };
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "OmniMarket-Operations-Hub",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const profileResponse = await fetch("https://api.github.com/user", {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!profileResponse.ok) throw new HttpError(401, "OAUTH_PROFILE_FAILED", "Could not verify the GitHub account.");
  const profile = await profileResponse.json() as {
    id?: number;
    name?: string | null;
    login?: string;
    avatar_url?: string;
  };
  if (!profile.id) throw new HttpError(401, "OAUTH_PROFILE_INVALID", "GitHub returned an invalid account.");

  const emailsResponse = await fetch("https://api.github.com/user/emails", {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!emailsResponse.ok) throw new HttpError(401, "OAUTH_EMAIL_FAILED", "Could not verify the GitHub email address.");
  const emails = await emailsResponse.json() as Array<{
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }>;
  const email = emails.find((entry) => entry.primary && entry.verified)?.email
    ?? emails.find((entry) => entry.verified)?.email;
  if (!email) throw new HttpError(401, "OAUTH_EMAIL_UNVERIFIED", "GitHub must provide a verified email address.");

  return {
    provider,
    providerAccountId: String(profile.id),
    email: email.toLowerCase(),
    name: profile.name ?? profile.login ?? null,
    image: profile.avatar_url ?? null,
  };
}

async function findOrCreateUser(identity: Identity) {
  const env = getEnv();
  const adminEmails = new Set(env.ADMIN_EMAILS.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
  const accountWhere = {
    provider_providerAccountId: {
      provider: identity.provider,
      providerAccountId: identity.providerAccountId,
    },
  };

  try {
    return await prisma.$transaction(async (tx) => {
      const linked = await tx.account.findUnique({ where: accountWhere, include: { user: true } });
      if (linked) {
        if (adminEmails.has(identity.email) && linked.user.role !== "ADMIN") {
          return tx.user.update({ where: { id: linked.user.id }, data: { role: "ADMIN" } });
        }
        return linked.user;
      }

      const existing = await tx.user.findUnique({ where: { email: identity.email } });
      const user = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              name: existing.name ?? identity.name,
              image: existing.image ?? identity.image,
              emailVerified: existing.emailVerified ?? new Date(),
              ...(adminEmails.has(identity.email) ? { role: "ADMIN" as const } : {}),
            },
          })
        : await tx.user.create({
            data: {
              email: identity.email,
              name: identity.name,
              image: identity.image,
              emailVerified: new Date(),
              ...(adminEmails.has(identity.email) ? { role: "ADMIN" } : {}),
            },
          });
      await tx.account.create({
        data: {
          userId: user.id,
          type: "oauth",
          provider: identity.provider,
          providerAccountId: identity.providerAccountId,
        },
      });
      return user;
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "P2002") {
      const linked = await prisma.account.findUnique({ where: accountWhere, include: { user: true } });
      if (linked) return linked.user;
    }
    throw error;
  }
}

async function finishOAuth(provider: Provider, request: Request, response: Response): Promise<void> {
  const state = readCookie(request, stateCookie(provider));
  const verifier = readCookie(request, verifierCookie(provider));
  const returnTo = readCookie(request, returnToCookie(provider));
  clearCookie(response, stateCookie(provider), callbackPath(provider), "Lax");
  clearCookie(response, verifierCookie(provider), callbackPath(provider), "Lax");
  clearCookie(response, returnToCookie(provider), callbackPath(provider), "Lax");

  const queryState = request.query.state;
  const code = request.query.code;
  if (
    typeof state !== "string" || typeof queryState !== "string" ||
    !secureEquals(state, queryState) || typeof verifier !== "string" || typeof code !== "string"
  ) {
    throw new HttpError(400, "OAUTH_STATE_INVALID", "The sign-in request expired or could not be verified.");
  }

  const accessToken = await exchangeCode(provider, code, verifier);
  const identity = await fetchIdentity(provider, accessToken);
  const user = await findOrCreateUser(identity);
  await createSession(user.id, response);
  response.redirect(302, new URL(safeReturnPath(returnTo), getEnv().WEB_ORIGIN).toString());
}

authRouter.get("/google", (request, response) => startOAuth("google", request, response));
authRouter.get("/github", (request, response) => startOAuth("github", request, response));
authRouter.get("/google/callback", async (request, response) => finishOAuth("google", request, response));
authRouter.get("/github/callback", async (request, response) => finishOAuth("github", request, response));

authRouter.get("/session", (request, response) => {
  response.json({ user: request.authUser ?? null });
});

authRouter.delete("/session", async (request, response) => {
  const token = readCookie(request, SESSION_COOKIE);
  await deleteSession(token, response);
  response.status(204).end();
});

authRouter.get("/me", requireAuth, (request, response) => {
  response.json({ user: request.authUser });
});

authRouter.post("/test/session", async (request, response, next) => {
  try {
    const env = getEnv();
    if (env.NODE_ENV !== "test" || env.E2E_TEST_AUTH !== "true") {
      throw new HttpError(404, "NOT_FOUND", "Route not found.");
    }
    if (!isTestTokenValid(request, env.TEST_API_TOKEN)) {
      throw new HttpError(401, "INVALID_TEST_TOKEN", "A valid test token is required.");
    }
    const user = await prisma.user.findUnique({ where: { id: TEST_ADMIN_ID } });
    if (!user) throw new HttpError(409, "TEST_USER_MISSING", "Seed the test administrator before starting E2E tests.");
    await createSession(user.id, response);
    response.status(200).json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

export function isTestTokenValid(request: Request, expected: string): boolean {
  const authorization = request.header("authorization");
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!expected || !supplied) return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

export type OAuthAccountCreateInput = Prisma.AccountCreateInput;
