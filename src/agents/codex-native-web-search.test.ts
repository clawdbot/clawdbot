import { describe, expect, it } from "vitest";
import {
  buildCodexNativeWebSearchTool,
  describeCodexNativeWebSearch,
  patchCodexNativeWebSearchPayload,
  resolveCodexNativeSearchActivation,
  resolveCodexNativeWebSearchConfig,
  isCodexNativeWebSearchRelevant,
  shouldSuppressManagedWebSearchTool,
} from "./codex-native-web-search.js";

const baseConfig = {
  tools: {
    web: {
      search: {
        enabled: true,
        openaiCodex: {
          enabled: true,
          mode: "cached",
        },
      },
    },
  },
} as const;

describe("resolveCodexNativeSearchActivation", () => {
  it("returns managed_only when native Codex search is disabled", () => {
    const result = resolveCodexNativeSearchActivation({
      config: { tools: { web: { search: { enabled: true } } } },
      modelProvider: "openai-codex",
      modelApi: "openai-codex-responses",
    });

    expect(result.state).toBe("managed_only");
    expect(result.inactiveReason).toBe("codex_not_enabled");
  });

  it("returns managed_only for non-eligible models", () => {
    const result = resolveCodexNativeSearchActivation({
      config: baseConfig,
      modelProvider: "openai",
      modelApi: "openai-responses",
    });

    expect(result.state).toBe("managed_only");
    expect(result.inactiveReason).toBe("model_not_eligible");
  });

  it("activates for direct openai-codex when auth exists", () => {
    const result = resolveCodexNativeSearchActivation({
      config: {
        ...baseConfig,
        auth: {
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              mode: "oauth",
            },
          },
        },
      },
      modelProvider: "openai-codex",
      modelApi: "openai-codex-responses",
    });

    expect(result.state).toBe("native_active");
    expect(result.codexMode).toBe("cached");
  });

  it("falls back to managed_only when direct openai-codex auth is missing", () => {
    const result = resolveCodexNativeSearchActivation({
      config: baseConfig,
      modelProvider: "openai-codex",
      modelApi: "openai-codex-responses",
    });

    expect(result.state).toBe("managed_only");
    expect(result.inactiveReason).toBe("codex_auth_missing");
  });

  it("activates for api-compatible openai-codex-responses providers without separate Codex auth", () => {
    const result = resolveCodexNativeSearchActivation({
      config: baseConfig,
      modelProvider: "gateway",
      modelApi: "openai-codex-responses",
    });

    expect(result.state).toBe("native_active");
  });

  it("keeps all search disabled when global web search is disabled", () => {
    const result = resolveCodexNativeSearchActivation({
      config: {
        tools: {
          web: {
            search: {
              enabled: false,
              openaiCodex: { enabled: true, mode: "live" },
            },
          },
        },
      },
      modelProvider: "openai-codex",
      modelApi: "openai-codex-responses",
    });

    expect(result.state).toBe("managed_only");
    expect(result.inactiveReason).toBe("globally_disabled");
  });
});

describe("Codex native web-search payload helpers", () => {
  it("omits the summary when global web search is disabled", () => {
    expect(
      describeCodexNativeWebSearch({
        tools: {
          web: {
            search: {
              enabled: false,
              openaiCodex: {
                enabled: true,
                mode: "live",
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("normalizes optional config values", () => {
    const result = resolveCodexNativeWebSearchConfig({
      tools: {
        web: {
          search: {
            openaiCodex: {
              enabled: true,
              allowedDomains: [" example.com ", "example.com", ""],
              contextSize: "high",
              userLocation: {
                country: " US ",
                city: " New York ",
                timezone: "America/New_York",
              },
            },
          },
        },
      },
    });

    expect(result.enabled).toBe(true);
    expect(result.mode).toBe("cached");
    expect(result.allowedDomains).toEqual(["example.com"]);
    expect(result.contextSize).toBe("high");
    expect(result.userLocation?.country).toBe("US");
    expect(result.userLocation?.city).toBe("New York");
    expect(result.userLocation?.timezone).toBe("America/New_York");
  });

  it("builds the native Responses web_search tool", () => {
    expect(
      buildCodexNativeWebSearchTool({
        tools: {
          web: {
            search: {
              openaiCodex: {
                enabled: true,
                mode: "live",
                allowedDomains: ["example.com"],
                contextSize: "medium",
                userLocation: { country: "US" },
              },
            },
          },
        },
      }),
    ).toEqual({
      type: "web_search",
      external_web_access: true,
      filters: { allowed_domains: ["example.com"] },
      search_context_size: "medium",
      user_location: {
        type: "approximate",
        country: "US",
      },
    });
  });

  it("injects native web_search into provider payloads", () => {
    const payload: Record<string, unknown> = { tools: [{ type: "function", name: "read" }] };
    const result = patchCodexNativeWebSearchPayload({ payload, config: baseConfig });

    expect(result.status).toBe("injected");
    expect(payload.tools).toEqual([
      { type: "function", name: "read" },
      { type: "web_search", external_web_access: false },
    ]);
  });

  it("does not inject a duplicate native web_search tool", () => {
    const payload: Record<string, unknown> = { tools: [{ type: "web_search" }] };
    const result = patchCodexNativeWebSearchPayload({ payload, config: baseConfig });

    expect(result.status).toBe("native_tool_already_present");
    expect(payload.tools).toEqual([{ type: "web_search" }]);
  });
});

describe("shouldSuppressManagedWebSearchTool", () => {
  it("suppresses managed web_search only when native Codex search is active", () => {
    expect(
      shouldSuppressManagedWebSearchTool({
        config: baseConfig,
        modelProvider: "gateway",
        modelApi: "openai-codex-responses",
      }),
    ).toBe(true);

    expect(
      shouldSuppressManagedWebSearchTool({
        config: baseConfig,
        modelProvider: "openai",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });
});

describe("isCodexNativeWebSearchRelevant", () => {
  it("treats a default model with model-level openai-codex-responses api as relevant", () => {
    expect(
      isCodexNativeWebSearchRelevant({
        config: {
          agents: {
            defaults: {
              model: {
                primary: "gateway/gpt-5.4",
              },
            },
          },
          models: {
            providers: {
              gateway: {
                api: "openai-responses",
                baseUrl: "https://gateway.example/v1",
                models: [
                  {
                    id: "gpt-5.4",
                    name: "gpt-5.4",
                    api: "openai-codex-responses",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 16_384,
                  },
                ],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });
});
