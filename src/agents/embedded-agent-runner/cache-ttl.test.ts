import { describe, expect, it, vi } from "vitest";

vi.mock("../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.js")>(
    "../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderCacheTtlEligibility: (params: {
      context: { provider: string; modelId: string; modelApi?: string };
    }) => {
      if (params.context.provider === "anthropic") {
        return true;
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

  it("rejects unsupported providers and models", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-4o")).toBe(false);
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });

  it("allows direct Google Gemini cache-ttl models", () => {
    expect(
      isCacheTtlEligibleProvider("google", "gemini-3.1-pro-preview", "google-generative-ai"),
    ).toBe(true);
    expect(isCacheTtlEligibleProvider("google", "gemini-2.5-flash", "google-generative-ai")).toBe(
      true,
    );
  });

  it("rejects non-cacheable Google model families", () => {
    expect(
      isCacheTtlEligibleProvider("google", "gemini-live-2.5-flash-preview", "google-generative-ai"),
    ).toBe(false);
  });

  it("allows custom anthropic-messages providers", () => {
    expect(isCacheTtlEligibleProvider("litellm", "claude-sonnet-4-6", "anthropic-messages")).toBe(
      true,
    );
  });

  it("allows anthropic Bedrock models", () => {
    expect(
      isCacheTtlEligibleProvider(
        "amazon-bedrock",
        "us.anthropic.claude-sonnet-4-20250514-v1:0",
        "anthropic-messages",
      ),
    ).toBe(true);
  });
});

describe("readLastCacheTtlTimestamp", () => {
  it("returns the latest matching timestamp for the active provider/model", () => {
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
