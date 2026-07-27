// Provider OAuth runtime tests cover PKCE redirects, callback parsing, and token exchange helpers.
import { describe, expect, it } from "vitest";
import {
  generateOAuthState,
  generatePKCE,
  parseOAuthAuthorizationInput,
  resolveOAuthTokenExpiresAt,
  resolveOAuthTokenLifetimeMs,
} from "./provider-oauth-runtime.js";

describe("provider OAuth runtime", () => {
  it("generates OAuth state independently from the PKCE verifier", async () => {
    const { verifier } = await generatePKCE();
    const state = generateOAuthState();
    const nextState = generateOAuthState();

    expect(state).toHaveLength(43);
    expect(state).not.toBe(verifier);
    expect(nextState).toHaveLength(43);
    expect(nextState).not.toBe(state);
  });

  it("parses authorization code input from redirect URLs, query strings, and raw codes", () => {
    expect(
      parseOAuthAuthorizationInput("http://localhost/callback?code=oauth-code&state=oauth-state"),
    ).toEqual({ code: "oauth-code", state: "oauth-state" });
    expect(parseOAuthAuthorizationInput("code=oauth-code&state=oauth-state")).toEqual({
      code: "oauth-code",
      state: "oauth-state",
    });
    expect(parseOAuthAuthorizationInput("oauth-code#oauth-state")).toEqual({
      code: "oauth-code",
      state: "oauth-state",
    });
    expect(parseOAuthAuthorizationInput(" oauth-code ")).toEqual({ code: "oauth-code" });
    expect(parseOAuthAuthorizationInput("   ")).toEqual({});
  });

  it("resolves safe OAuth token lifetimes and expiry timestamps", () => {
    expect(resolveOAuthTokenLifetimeMs("30")).toBe(30_000);
    expect(resolveOAuthTokenExpiresAt(30, { nowMs: 1_000, refreshSkewMs: 5_000 })).toBe(26_000);
  });

  it("rejects invalid OAuth token lifetimes and Date-invalid expiries", () => {
    expect(resolveOAuthTokenLifetimeMs(0)).toBeUndefined();
    expect(resolveOAuthTokenLifetimeMs(1.5)).toBeUndefined();
    expect(resolveOAuthTokenLifetimeMs(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(resolveOAuthTokenExpiresAt(Number.MAX_SAFE_INTEGER, { nowMs: 1_000 })).toBeUndefined();
    expect(
      resolveOAuthTokenExpiresAt(30, {
        nowMs: 8_640_000_000_000_000,
      }),
    ).toBeUndefined();
    expect(
      resolveOAuthTokenExpiresAt(30, {
        nowMs: 8_640_000_000_000_001,
      }),
    ).toBeUndefined();
  });
});
