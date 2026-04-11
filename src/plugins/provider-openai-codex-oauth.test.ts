import { describe, expect, it } from "vitest";
import { __testing } from "./provider-openai-codex-oauth.js";

describe("provider-openai-codex-oauth", () => {
  it("normalizes required scopes for slash-terminated authorize URLs", () => {
    const normalized = __testing.normalizeOpenAICodexAuthorizeUrl(
      "https://auth.openai.com/oauth/authorize/?scope=openid%20profile",
    );
    const url = new URL(normalized);
    const scopes = new Set((url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean));

    expect(url.pathname).toBe("/oauth/authorize/");
    expect(scopes).toEqual(
      new Set([
        "openid",
        "profile",
        "email",
        "offline_access",
        "model.request",
        "api.responses.write",
      ]),
    );
  });
});
