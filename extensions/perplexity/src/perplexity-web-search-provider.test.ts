import { withEnv } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { __testing } from "./perplexity-web-search-provider.js";

const openRouterApiKeyEnv = ["OPENROUTER_API", "KEY"].join("_");
const perplexityApiKeyEnv = ["PERPLEXITY_API", "KEY"].join("_");
const openRouterPerplexityApiKey = ["sk", "or", "v1", "test"].join("-");
const directPerplexityApiKey = ["pplx", "test"].join("-");
const enterprisePerplexityApiKey = ["enterprise", "perplexity", "test"].join("-");

describe("perplexity web search provider", () => {
  it("infers provider routing from api key prefixes", () => {
    expect(__testing.inferPerplexityBaseUrlFromApiKey("pplx-abc")).toBe("direct");
    expect(__testing.inferPerplexityBaseUrlFromApiKey("sk-or-v1-abc")).toBe("openrouter");
    expect(__testing.inferPerplexityBaseUrlFromApiKey("unknown")).toBeUndefined();
  });

  it("resolves base url from auth source and request model by transport", () => {
    expect(__testing.resolvePerplexityBaseUrl(undefined, "perplexity_env")).toBe(
      "https://api.perplexity.ai",
    );
    expect(__testing.resolvePerplexityBaseUrl(undefined, "openrouter_env")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(
      __testing.resolvePerplexityRequestModel("https://api.perplexity.ai", "perplexity/sonar-pro"),
    ).toBe("sonar-pro");
    expect(
      __testing.resolvePerplexityRequestModel(
        "https://openrouter.ai/api/v1",
        "perplexity/sonar-pro",
      ),
    ).toBe("perplexity/sonar-pro");
  });

  it("chooses direct search_api transport only for direct base urls without legacy overrides", () => {
    expect(
      __testing.resolvePerplexityTransport({
        baseUrl: "https://api.perplexity.ai",
      }).transport,
    ).toBe("chat_completions");

    expect(
      __testing.resolvePerplexityTransport({
        apiKey: "pplx-secret",
      }).transport,
    ).toBe("search_api");
  });

  it("prefers explicit baseUrl over key-based defaults", () => {
    expect(
      __testing.resolvePerplexityBaseUrl({ baseUrl: "https://example.com" }, "config", "pplx-123"),
    ).toBe("https://example.com");
  });

  it("resolves OpenRouter env auth and transport", () => {
    withEnv(
      { [perplexityApiKeyEnv]: undefined, [openRouterApiKeyEnv]: openRouterPerplexityApiKey },
      () => {
        expect(__testing.resolvePerplexityApiKey(undefined)).toEqual({
          apiKey: openRouterPerplexityApiKey,
          source: "openrouter_env",
        });
        expect(__testing.resolvePerplexityTransport(undefined)).toMatchObject({
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
          transport: "chat_completions",
        });
      },
    );
  });

  it("uses native Search API for direct Perplexity when no legacy overrides exist", () => {
    withEnv(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      () => {
        expect(__testing.resolvePerplexityTransport(undefined)).toMatchObject({
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
          transport: "search_api",
        });
      },
    );
  });

  it("switches direct Perplexity to chat completions when model override is configured", () => {
    expect(__testing.resolvePerplexityModel({ model: "perplexity/sonar-reasoning-pro" })).toBe(
      "perplexity/sonar-reasoning-pro",
    );
    expect(
      __testing.resolvePerplexityTransport({
        apiKey: directPerplexityApiKey,
        model: "perplexity/sonar-reasoning-pro",
      }),
    ).toMatchObject({
      baseUrl: "https://api.perplexity.ai",
      model: "perplexity/sonar-reasoning-pro",
      transport: "chat_completions",
    });
  });

  it("treats unrecognized configured keys as direct Perplexity by default", () => {
    expect(
      __testing.resolvePerplexityTransport({
        apiKey: enterprisePerplexityApiKey,
      }),
    ).toMatchObject({
      baseUrl: "https://api.perplexity.ai",
      transport: "search_api",
    });
  });
});
