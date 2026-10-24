import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock, resetPrismaMock } from "./helpers/prisma-mock.js";
import { startServer, type TestServer } from "./helpers/http.js";

vi.mock("../../src/db/prisma.js", async () => ({ prisma: (await import("./helpers/prisma-mock.js")).prismaMock }));

const { createApp } = await import("../../src/application.js");
const { resetEnvForTests } = await import("../../src/config/env.js");
const { hashSessionToken } = await import("../../src/auth/session.js");

const user = { id: "11111111-1111-4111-8111-111111111111", email: "ana@example.test", name: "Ana", image: null, role: "OPERATOR" };
const callbackCookies = "omni_google_oauth_state=state-123; omni_google_oauth_verifier=verifier-456; omni_session=previous-token";
let server: TestServer;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" });
  resetEnvForTests();
  server = await startServer(createApp());
});
afterAll(async () => {
  await server.close();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  resetEnvForTests();
});
beforeEach(() => {
  resetPrismaMock();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  prismaMock.session.findUnique.mockResolvedValue({ id: "s-old", expires: new Date(Date.now() + 60_000), user });
});
afterEach(() => vi.unstubAllGlobals());

/** Fakes the provider endpoints while leaving the test's own HTTP calls to the local server untouched. */
function stubProvider(tokenStatus: number): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "provider-access-token" }), { status: tokenStatus });
    }
    if (url.startsWith("https://openidconnect.googleapis.com/")) {
      return new Response(JSON.stringify({ sub: "google-1", email: user.email, email_verified: true, name: "Ana" }), { status: 200 });
    }
    return realFetch(input, init);
  }));
}

describe("OAuth sign-in and the existing session", () => {
  it("starting a sign-in does not revoke or clear the current session", async () => {
    const response = await server.request("GET", "/api/auth/google", { headers: { Cookie: "omni_session=previous-token" } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(prismaMock.session.deleteMany).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("omni_session="))).toBe(false);
    // state, PKCE verifier and return path cookies are still issued.
    expect(response.headers.getSetCookie().map((cookie) => cookie.split("=")[0])).toEqual([
      "omni_google_oauth_state", "omni_google_oauth_verifier", "omni_google_oauth_return_to",
    ]);
  });

  it("revokes the previous session only after the new sign-in succeeds", async () => {
    stubProvider(200);
    prismaMock.account.findUnique.mockResolvedValue({ user });
    const response = await server.request("GET", "/api/auth/google/callback?code=code-1&state=state-123", {
      headers: { Cookie: callbackCookies },
    });
    expect(response.status).toBe(302);
    expect(prismaMock.session.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({ where: { sessionToken: hashSessionToken("previous-token") } });
    expect(prismaMock.session.create.mock.invocationCallOrder[0]!).toBeLessThan(prismaMock.session.deleteMany.mock.invocationCallOrder[0]!);
    const sessionCookies = response.headers.getSetCookie().filter((cookie) => cookie.startsWith("omni_session="));
    expect(sessionCookies).toHaveLength(1);
    expect(sessionCookies[0]).not.toMatch(/^omni_session=;/);
  });

  it("keeps the previous session when the provider rejects the sign-in", async () => {
    stubProvider(400);
    const response = await server.request("GET", "/api/auth/google/callback?code=code-1&state=state-123", {
      headers: { Cookie: callbackCookies },
    });
    expect(response.status).toBe(502);
    expect(prismaMock.session.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.session.create).not.toHaveBeenCalled();
  });

  it("keeps the previous session when the state does not match", async () => {
    const response = await server.request("GET", "/api/auth/google/callback?code=code-1&state=other", {
      headers: { Cookie: callbackCookies },
    });
    expect(response.status).toBe(400);
    expect(prismaMock.session.deleteMany).not.toHaveBeenCalled();
  });
});
