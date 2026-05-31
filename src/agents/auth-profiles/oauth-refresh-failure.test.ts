import { describe, expect, it } from "vitest";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
} from "./oauth-refresh-failure.js";

describe("oauth refresh failure hints", () => {
  it("canonicalizes retired OpenAI provider ids in refresh-failure login hints", () => {
    const legacyProvider = ["openai", "codex"].join("-");

    expect(
      classifyOAuthRefreshFailure(
        `OAuth token refresh failed for ${legacyProvider}: invalid_grant`,
      ),
    ).toEqual({
      provider: "openai",
      reason: "invalid_grant",
    });
    expect(buildOAuthRefreshFailureLoginCommand(legacyProvider)).toBe(
      "openclaw models auth login --provider openai",
    );
  });
});
