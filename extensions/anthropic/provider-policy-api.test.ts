import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { applyConfigDefaults, normalizeConfig } from "./provider-policy-api.js";

function createModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

describe("anthropic provider policy public artifact", () => {
  it("normalizes Anthropic provider config", () => {
    expect(
      normalizeConfig({
        provider: "anthropic",
        providerConfig: {
          baseUrl: "https://api.anthropic.com",
          models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
        },
      }),
    ).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });
  });

  it("normalizes Claude CLI provider config", () => {
    expect(
      normalizeConfig({
        provider: "claude-cli",
        providerConfig: {
          baseUrl: "https://api.anthropic.com",
          models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
        },
      }),
    ).toMatchObject({
      api: "anthropic-messages",
    });
  });

  it("does not normalize non-Anthropic provider config", () => {
    const providerConfig = {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      models: [createModel("gpt-5.4", "GPT-5.4")],
    };

    expect(
      normalizeConfig({
        provider: "openai-codex",
        providerConfig,
      }),
    ).toBe(providerConfig);
  });

  it("applies Anthropic API-key defaults without loading the full provider plugin", () => {
    const nextConfig = applyConfigDefaults({
      config: {
        auth: {
          profiles: {
            "anthropic:default": {
              provider: "anthropic",
              mode: "api_key",
            },
          },
          order: { anthropic: ["anthropic:default"] },
        },
        agents: {
          defaults: {},
        },
      },
      env: {},
    });

    expect(nextConfig.agents?.defaults?.contextPruning).toMatchObject({
      mode: "cache-ttl",
      ttl: "1h",
    });
  });
});
