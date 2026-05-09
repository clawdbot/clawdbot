import { describe, expect, it } from "vitest";
import { resolveCodexAuthIdentity } from "./openai-codex-auth-identity.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("resolveCodexAuthIdentity", () => {
  it("prefers JWT profile email when present", () => {
    const identity = resolveCodexAuthIdentity({
      accessToken: createJwt({
        "https://api.openai.com/profile": {
          email: "jwt-user@example.com",
        },
      }),
      email: "credential@example.com",
    });

    expect(identity).toEqual({
      email: "jwt-user@example.com",
      profileName: "jwt-user@example.com",
    });
  });

  it("extracts account and plan metadata from the JWT auth claim", () => {
    const identity = resolveCodexAuthIdentity({
      accessToken: createJwt({
        "https://api.openai.com/profile": {
          email: "jwt-user@example.com",
        },
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-123",
          chatgpt_plan_type: "prolite",
        },
      }),
    });

    expect(identity).toEqual({
      accountId: "acct-123",
      chatgptPlanType: "prolite",
      email: "jwt-user@example.com",
      profileName: "jwt-user@example.com",
    });
  });

  it("falls back to credential email before synthetic ids", () => {
    const identity = resolveCodexAuthIdentity({
      accessToken: createJwt({}),
      email: "credential@example.com",
    });

    expect(identity).toEqual({
      email: "credential@example.com",
      profileName: "credential@example.com",
    });
  });

  it("derives a stable profile id when email is missing", () => {
    const identity = resolveCodexAuthIdentity({
      accessToken: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_user_id: "user-123__acct-456",
        },
      }),
    });

    expect(identity).toEqual({
      profileName: `id-${Buffer.from("user-123__acct-456").toString("base64url")}`,
    });
  });

  it("returns no metadata when token parsing yields no identity", () => {
    expect(resolveCodexAuthIdentity({ accessToken: "not-a-jwt-token" })).toStrictEqual({});
  });
});
