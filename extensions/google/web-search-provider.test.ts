import { withEnv } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { __testing, createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

describe("google web search provider", () => {
  it("falls back to GEMINI_API_KEY from the environment", () => {
    withEnv({ GEMINI_API_KEY: "AIza-env-test" }, () => {
      expect(__testing.resolveGeminiApiKey()).toBe("AIza-env-test");
    });
  });

  it("prefers configured api keys over env fallbacks", () => {
    withEnv({ GEMINI_API_KEY: "AIza-env-test" }, () => {
      expect(__testing.resolveGeminiApiKey({ apiKey: "AIza-configured-test" })).toBe(
        "AIza-configured-test",
      );
    });
  });

  it("stores configured credentials at the canonical plugin config path", () => {
    const provider = createGeminiWebSearchProvider();
    const config = {} as OpenClawConfig;

    provider.setConfiguredCredentialValue?.(config, "AIza-plugin-test");

    expect(provider.credentialPath).toBe("plugins.entries.google.config.webSearch.apiKey");
    expect(provider.getConfiguredCredentialValue?.(config)).toBe("AIza-plugin-test");
  });

  it("defaults the Gemini web search model and trims explicit overrides", () => {
    expect(__testing.resolveGeminiModel()).toBe("gemini-2.5-flash");
    expect(__testing.resolveGeminiModel({ model: "  gemini-2.5-pro  " })).toBe("gemini-2.5-pro");
  });
});
