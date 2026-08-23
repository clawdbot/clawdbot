// Cache-TTL eligibility coverage for native and provider-routed model families.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.js")>(
    "../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderCacheTtlEligibility: (params: {
      context: {
        provider: string;
        modelId: string;
        modelApi?: string;
        baseUrl?: string;
        supportsPromptCacheKey?: boolean;
      };
    }) => {
      // Provider runtime owns model-family-specific eligibility; tests mirror
      // plugin decisions without loading actual provider plugins.
      if (params.context.provider === "anthropic") {
        return true;
      }
      if (params.context.provider === "openai") {
        return (
          params.context.supportsPromptCacheKey ??
          (params.context.baseUrl === "https://api.openai.com/v1" ||
            params.context.baseUrl === "https://chatgpt.com/backend-api/codex")
        );
      }
      if (params.context.provider === "moonshot" || params.context.provider === "zai") {
        return true;
      }
      if (params.context.provider === "openrouter") {
        return ["anthropic/", "deepseek/", "moonshot/", "moonshotai/", "zai/"].some((prefix) =>
          params.context.modelId.startsWith(prefix),
        );
      }
      return undefined;
    },
  };
});

import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  it("allows anthropic", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-sonnet-4-20250514")).toBe(true);
  });

  it("allows moonshot and zai providers", () => {
    expect(isCacheTtlEligibleProvider("moonshot", "kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("zai", "glm-5")).toBe(true);
  });

  it("is case-insensitive for native providers", () => {
    expect(isCacheTtlEligibleProvider("Moonshot", "Kimi-K2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("ZAI", "GLM-5")).toBe(true);
  });

  it("allows openrouter cache-ttl models", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-sonnet-4")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "deepseek/deepseek-v3.2")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshot/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "zai/glm-5")).toBe(true);
  });

  it.each([
    {
      name: "native OpenAI",
      baseUrl: "https://api.openai.com/v1",
      compat: undefined,
      expected: true,
    },
    {
      name: "ChatGPT OAuth",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      compat: undefined,
      expected: true,
    },
    {
      name: "custom proxy",
      baseUrl: "https://openai-proxy.example/v1",
      compat: undefined,
      expected: false,
    },
    {
      name: "opted-in custom proxy",
      baseUrl: "https://openai-proxy.example/v1",
      compat: { supportsPromptCacheKey: true },
      expected: true,
    },
    {
      name: "opted-out native OpenAI",
      baseUrl: "https://api.openai.com/v1",
      compat: { supportsPromptCacheKey: false },
      expected: false,
    },
  ])(
    "passes the resolved route to the $name provider hook",
    ({ api, baseUrl, compat, expected }) => {
      expect(
        isCacheTtlEligibleProvider("openai", "gpt-4o", {
          provider: "openai",
          id: "gpt-4o",
          api: api ?? "openai-responses",
          baseUrl,
          compat,
        } as never),
      ).toBe(expected);
    },
  );

  it("does not widen OpenRouter while consulting provider hooks", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });

  it("allows direct Google Gemini cache-ttl models", () => {
    expect(
      isCacheTtlEligibleProvider("google", "gemini-3.1-pro-preview", {
        api: "google-generative-ai",
      } as never),
    ).toBe(true);
    expect(
      isCacheTtlEligibleProvider("google", "gemini-2.5-flash", {
        api: "google-generative-ai",
      } as never),
    ).toBe(true);
  });

  it("rejects non-cacheable Google model families", () => {
    expect(
      isCacheTtlEligibleProvider("google", "gemini-live-2.5-flash-preview", {
        api: "google-generative-ai",
      } as never),
    ).toBe(false);
  });

  it("allows custom anthropic-messages providers", () => {
    expect(
      isCacheTtlEligibleProvider("litellm", "claude-sonnet-4-6", {
        api: "anthropic-messages",
      } as never),
    ).toBe(true);
  });

  it("allows anthropic Bedrock models", () => {
    expect(
      isCacheTtlEligibleProvider("amazon-bedrock", "us.anthropic.claude-sonnet-4-20250514-v1:0", {
        api: "anthropic-messages",
      } as never),
    ).toBe(true);
  });
});

describe("readLastCacheTtlTimestamp", () => {
  it("returns the latest matching timestamp for the active provider/model", () => {
    // Replay only reuses cache TTL entries scoped to the current model target;
    // stale entries for other providers must not reset pruning clocks.
    const sessionManager = {
      getEntries: () => [
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            timestamp: 1_700_000_000_000,
            provider: "anthropic",
            modelId: "claude-sonnet-4-5",
          },
        },
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            timestamp: 1_700_000_001_000,
            provider: "google",
            modelId: "gemini-3.1-pro-preview",
          },
        },
      ],
    };

    expect(
      readLastCacheTtlTimestamp(sessionManager, {
        provider: "Anthropic",
        modelId: "Claude-Sonnet-4-5",
      }),
    ).toBe(1_700_000_000_000);
  });

  it("ignores unscoped cache-ttl entries when a context filter is requested", () => {
    const sessionManager = {
      getEntries: () => [
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            timestamp: 1_700_000_000_000,
          },
        },
      ],
    };

    expect(
      readLastCacheTtlTimestamp(sessionManager, {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }),
    ).toBeNull();
  });
});
