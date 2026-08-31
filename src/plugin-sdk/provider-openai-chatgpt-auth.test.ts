// OpenAI ChatGPT auth tests cover auth status normalization and token expiry handling.
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
      email: "credential@example.com",
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

  it("falls back to credential email before synthetic ids", () => {
    expect(
      resolveOpenAICodexAuthIdentity({
        access: jwt({ sub: "jwt-subject" }),
        email: "credential@example.com",
      }),
    ).toEqual({
      email: "credential@example.com",
      profileName: "credential@example.com",
    });
  });

  it("decodes URL-safe base64 JWT payloads", () => {
    const access = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "w_ébé_1fzcswWN6Pi5zL",
      },
    });
    expect(access.split(".")[1]).toContain("_");

    expect(resolveOpenAICodexAuthIdentity({ access })).toEqual({
      accountId: "w_ébé_1fzcswWN6Pi5zL",
    });
  });

  it("uses the OIDC issuer pair without treating workspace ids as user subjects", () => {
    expect(
      resolveOpenAICodexAuthIdentity({
        access: jwt({ iss: "https://accounts.openai.com", sub: "user-abc" }),
      }),
    ).toEqual({
      profileName: `id-${Buffer.from("https://accounts.openai.com|user-abc").toString("base64url")}`,
    });

    expect(
      resolveOpenAICodexAuthIdentity({
        access: jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "workspace-only" },
        }),
      }),
    ).toEqual({ accountId: "workspace-only" });
  });

  it("returns no identity metadata for non-JWT input", () => {
    expect(resolveOpenAICodexAuthIdentity({ access: "not-a-jwt" })).toEqual({});
  });

  it("resolves access-token expiry from numeric and string JWT exp claims", () => {
    expect(resolveOpenAICodexAccessTokenExpiry(jwt({ exp: 1234.9 }))).toBe(1_234_000);
    expect(resolveOpenAICodexAccessTokenExpiry(jwt({ exp: "1234" }))).toBe(1_234_000);
    expect(resolveOpenAICodexAccessTokenExpiry(jwt({ exp: 0 }))).toBeUndefined();
    expect(
      resolveOpenAICodexAccessTokenExpiry(jwt({ exp: Number.MAX_SAFE_INTEGER })),
    ).toBeUndefined();
    expect(resolveOpenAICodexAccessTokenExpiry("not-a-jwt")).toBeUndefined();
  });
});
