import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { readCookie } from "../../src/auth/cookies.js";
import { hashSessionToken, publicUser } from "../../src/auth/session.js";

describe("session helpers", () => {
  it("stores a deterministic SHA-256 digest instead of the raw token", () => {
    const first = hashSessionToken("session-token");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSessionToken("session-token")).toBe(first);
    expect(hashSessionToken("different-token")).not.toBe(first);
    expect(first).not.toContain("session-token");
  });

  it("exposes only public user fields", () => {
    const user = {
      id: "user-1",
      email: "ada@example.test",
      name: "Ada",
      image: null,
      role: "ADMIN" as const,
      emailVerified: new Date(),
      passwordHash: "must-not-leak",
    };

    expect(publicUser(user)).toEqual({
      id: "user-1",
      email: "ada@example.test",
      name: "Ada",
      image: null,
      role: "ADMIN",
    });
  });
});

describe("cookie reader", () => {
  const request = (cookie: string) => ({ headers: { cookie } }) as Request;

  it("matches the full cookie name and decodes its value", () => {
    expect(readCookie(request("omni_session_old=wrong; omni_session=abc%2B123"), "omni_session"))
      .toBe("abc+123");
  });

  it("supports values containing equals signs", () => {
    expect(readCookie(request("token=a=b=c"), "token")).toBe("a=b=c");
  });

  it("returns undefined for missing headers, missing names, and malformed encoding", () => {
    expect(readCookie({ headers: {} } as Request, "token")).toBeUndefined();
    expect(readCookie(request("other=value"), "token")).toBeUndefined();
    expect(readCookie(request("token=%E0%A4%A"), "token")).toBeUndefined();
  });
});
