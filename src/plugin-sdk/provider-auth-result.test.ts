import { describe, expect, it } from "vitest";
import { buildOauthProviderAuthResult } from "./provider-auth-result.js";

describe("buildOauthProviderAuthResult", () => {
  it("normalizes retired Gemini defaults before emitting config patches", () => {
    const result = buildOauthProviderAuthResult({
      providerId: "google",
      defaultModel: "google/gemini-3-pro-preview",
      access: "access-token",
    });

    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": {},
          },
        },
      },
    });
  });
});
