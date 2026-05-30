import { describe, expect, it } from "vitest";
import {
  buildOpenAICodexCredentialExtra,
  resolveOpenAICodexAccessTokenExpiry,
  resolveOpenAICodexAuthIdentity,
  resolveOpenAICodexImportProfileName,
} from "./provider-auth.js";

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

describe("OpenAI Codex provider auth helpers", () => {
  it("resolves identity metadata from OpenAI Codex OAuth JWT claims", () => {
    const identity = resolveOpenAICodexAuthIdentity({
      access: jwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_123",
          chatgpt_plan_type: "plus",
        },
        "https://api.openai.com/profile": {
          email: "codex@example.com",
        },
      }),
    });

    expect(identity).toEqual({
      accountId: "acct_123",
      chatgptPlanType: "plus",
      email: "codex@example.com",
      profileName: "codex@example.com",
    });
    expect(resolveOpenAICodexImportProfileName(identity, "codex-import")).toBe("account-acct_123");
    expect(buildOpenAICodexCredentialExtra({ ...identity, idToken: "id-token" })).toEqual({
      accountId: "acct_123",
      chatgptPlanType: "plus",
      idToken: "id-token",
    });
  });

  it("builds stable imported profile names from subject claims before account fallback", () => {
    const identity = resolveOpenAICodexAuthIdentity({
      access: jwt({
        sub: "jwt-subject",
        "https://api.openai.com/auth": {
          chatgpt_account_user_id: "user-123__acct-456",
        },
      }),
      accountId: "acct/fallback",
    });

    expect(identity).toEqual({
      accountId: "acct/fallback",
      profileName: `id-${Buffer.from("user-123__acct-456").toString("base64url")}`,
    });
    expect(resolveOpenAICodexImportProfileName(identity, "codex-import")).toBe(
      "account-acct-fallback",
    );
  });

  it("falls back to account id when the access token has no stable subject", () => {
    const identity = resolveOpenAICodexAuthIdentity({
      access: jwt({}),
      accountId: "acct_only",
    });

    expect(identity).toEqual({
      accountId: "acct_only",
      profileName: `id-${Buffer.from("acct_only").toString("base64url")}`,
    });
  });

  it("resolves access-token expiry from numeric and string JWT exp claims", () => {
    expect(resolveOpenAICodexAccessTokenExpiry(jwt({ exp: 1234.9 }))).toBe(1_234_000);
    expect(resolveOpenAICodexAccessTokenExpiry(jwt({ exp: "1234" }))).toBe(1_234_000);
    expect(resolveOpenAICodexAccessTokenExpiry(jwt({ exp: 0 }))).toBeUndefined();
    expect(resolveOpenAICodexAccessTokenExpiry("not-a-jwt")).toBeUndefined();
  });
});
