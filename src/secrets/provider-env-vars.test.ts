import { describe, expect, it } from "vitest";
import {
  getProviderEnvVars,
  listKnownProviderAuthEnvVarNames,
  listKnownSecretEnvVarNames,
  omitEnvKeysCaseInsensitive,
} from "./provider-env-vars.js";

describe("provider env vars", () => {
  it("keeps the auth scrub list broader than the global secret env list", () => {
    const sharedSecretNames = [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "BRAVE_API_KEY",
      "DEEPGRAM_API_KEY",
      "FIRECRAWL_API_KEY",
      "GROQ_API_KEY",
      "PERPLEXITY_API_KEY",
      "OPENROUTER_API_KEY",
      "TAVILY_API_KEY",
    ];
    const providerAuthNames = listKnownProviderAuthEnvVarNames();
    const secretNames = listKnownSecretEnvVarNames();
    for (const name of sharedSecretNames) {
      expect(providerAuthNames).toContain(name);
      expect(secretNames).toContain(name);
    }
    expect(providerAuthNames).toContain("MINIMAX_CODE_PLAN_KEY");
    expect(providerAuthNames).toContain("MINIMAX_CODING_API_KEY");
    expect(listKnownSecretEnvVarNames()).not.toContain("OPENCLAW_API_KEY");
  });

  it("omits env keys case-insensitively", () => {
    const env = omitEnvKeysCaseInsensitive(
      {
        OpenAI_Api_Key: "openai-secret",
        Github_Token: "gh-secret",
        OPENCLAW_API_KEY: "keep-me",
      },
      ["OPENAI_API_KEY", "GITHUB_TOKEN"],
    );

    expect(env.OpenAI_Api_Key).toBeUndefined();
    expect(env.Github_Token).toBeUndefined();
    expect(env.OPENCLAW_API_KEY).toBe("keep-me");
  });

  it("ignores prototype-chain keys when resolving provider env vars", () => {
    expect(getProviderEnvVars("__proto__")).toStrictEqual([]);
    expect(getProviderEnvVars("constructor")).toStrictEqual([]);
    expect(getProviderEnvVars("openai")).toEqual(["OPENAI_API_KEY"]);
    expect(getProviderEnvVars("anthropic")).toEqual(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    expect(getProviderEnvVars("fal")).toEqual(["FAL_KEY", "FAL_API_KEY"]);
  });
});
