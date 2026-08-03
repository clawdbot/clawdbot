/** Tests Chutes OAuth callback parsing and PKCE generation. */
import { describe, expect, it } from "vitest";
import { generateChutesPkce, parseOAuthCallbackInput } from "./chutes-oauth.js";

describe("parseOAuthCallbackInput", () => {
  it("rejects code-only input (state required)", () => {
    const parsed = parseOAuthCallbackInput("abc123", "expected-state");
    expect(parsed).toEqual({
      error: "Paste the full redirect URL (must include code + state).",
    });
  });

  it("accepts full redirect URL when state matches", () => {
    const parsed = parseOAuthCallbackInput(
      "http://127.0.0.1:1456/oauth-callback?code=abc123&state=expected-state",
      "expected-state",
    );
    expect(parsed).toEqual({ code: "abc123", state: "expected-state" });
  });

  it("accepts querystring-only input when state matches", () => {
    const parsed = parseOAuthCallbackInput("code=abc123&state=expected-state", "expected-state");
    expect(parsed).toEqual({ code: "abc123", state: "expected-state" });
  });

  it("rejects missing state", () => {
    const parsed = parseOAuthCallbackInput(
      "http://127.0.0.1:1456/oauth-callback?code=abc123",
      "expected-state",
    );
    expect(parsed).toEqual({
      error: "Missing 'state' parameter. Paste the full redirect URL.",
    });
  });

  it("rejects state mismatch", () => {
    const parsed = parseOAuthCallbackInput(
      "http://127.0.0.1:1456/oauth-callback?code=abc123&state=evil",
      "expected-state",
    );
    expect(parsed).toEqual({
      error: "OAuth state mismatch - possible CSRF attack. Please retry login.",
    });
  });
});

describe("generateChutesPkce", () => {
  it("returns verifier and challenge", () => {
    const pkce = generateChutesPkce();
    expect(pkce.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
