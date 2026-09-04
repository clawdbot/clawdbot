// Anthropic tests cover provider policy api plugin behavior.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { parseAnthropicModelRef } from "./claude-model-refs.js";
import {
  applyConfigDefaults,
  deprecatedProfileIds,
  normalizeConfig,
  resolveThinkingProfile,
} from "./provider-policy-api.js";

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

function collectLegacyExtendedLevelIds(levels: readonly { id: string }[] | undefined): string[] {
  const ids: string[] = [];
  for (const level of levels ?? []) {
    if (level.id === "xhigh" || level.id === "max") {
      ids.push(level.id);
    }
  }
  return ids;
}

function levelIds(levels: readonly { id: string }[] | undefined): string[] {
  return (levels ?? []).map((level) => level.id);
}

const modelRefCases: Array<[string, string | null, string | null, boolean | null]> = [
  ["", null, null, null],
  ["claude-test", "anthropic", "claude-test", false],
  ["/claude-test", "anthropic", "/claude-test", false],
  ["anthropic/", null, null, null],
  ["anthropic/team/claude-test", "anthropic", "team/claude-test", true],
  ["  AnThRoPiC / claude-test  ", "anthropic", "claude-test", true],
  ["anthropic/claude-test@anthropic:work", "anthropic", "claude-test@anthropic:work", true],
  ["bedrock/anthropic.claude-test", "amazon-bedrock", "anthropic.claude-test", true],
  ["AWS-BEDROCK/anthropic.claude-test", "amazon-bedrock", "anthropic.claude-test", true],
];

describe("anthropic provider policy public artifact", () => {
  it.each(modelRefCases)(
    "parses Anthropic model ref %s",
    (raw, provider, model, explicitProvider) => {
      expect(parseAnthropicModelRef(raw)).toEqual(
        provider === null ? null : { provider, model, explicitProvider },
      );
    },
  );

  it("publishes native Claude profiles retired from generic auth", () => {
    expect(deprecatedProfileIds).toEqual(["anthropic:claude-cli"]);
  });

  it("normalizes Anthropic provider config", () => {
    const normalized = normalizeConfig({
      provider: "anthropic",
      providerConfig: {
        baseUrl: "https://api.anthropic.com",
        models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
      },
    });
    expect(normalized.api).toBe("anthropic-messages");
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("normalizes Claude CLI provider config", () => {
    const normalized = normalizeConfig({
      provider: "claude-cli",
      providerConfig: {
        baseUrl: "https://api.anthropic.com",
        models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
      },
    });
    expect(normalized.api).toBe("anthropic-messages");
  });

  it("does not normalize non-Anthropic provider config", () => {
    const providerConfig = {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      models: [createModel("gpt-5.4", "GPT-5.4")],
    };

    expect(
      normalizeConfig({
        provider: "openai",
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

    expect(nextConfig.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
    expect(nextConfig.agents?.defaults?.contextPruning?.ttl).toBe("1h");
  });

  it("adds cacheRetention defaults for dated Anthropic primary model refs", () => {
    const nextConfig = applyConfigDefaults({
      config: {
        auth: {
          profiles: {
            "anthropic:default": {
              provider: "anthropic",
              mode: "api_key",
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-20250514" },
          },
        },
      },
      env: {},
    });

    expect(
      nextConfig.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it("exposes Claude Opus 4.8 thinking levels without loading the full provider plugin", () => {
    const profile = resolveThinkingProfile({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    });
    const ids = levelIds(profile?.levels);
    expect(ids).toContain("xhigh");
    expect(ids).toContain("adaptive");
    expect(ids).toContain("max");
    expect(profile?.defaultLevel).toBe("off");
  });

  it.each(["claude-fable-5", "claude-fable-5-1", "claude-mythos-5"])(
    "exposes the mandatory-adaptive %s thinking profile",
    (modelId) => {
      const profile = resolveThinkingProfile({
        provider: "anthropic",
        modelId,
      });

      expect(profile).toEqual({
        levels: [
          { id: "minimal" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "xhigh" },
          { id: "adaptive" },
          { id: "max" },
        ],
        defaultLevel: "high",
        preserveWhenCatalogReasoningFalse: true,
      });
    },
  );

  it.each(["claude-fable-5", "claude-fable-5-1"])(
    "keeps the %s thinking profile identical across API and CLI routes",
    (modelId) => {
      expect(resolveThinkingProfile({ provider: "claude-cli", modelId })).toEqual(
        resolveThinkingProfile({ provider: "anthropic", modelId }),
      );
    },
  );

  it("keeps direct-only Mythos thinking disabled on the CLI route", () => {
    expect(resolveThinkingProfile({ provider: "claude-cli", modelId: "claude-mythos-5" })).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
  });

  it("does not return fable-5 off-thinking profile for claude-fable-50 (prefix boundary check)", () => {
    const profile = resolveThinkingProfile({
      provider: "claude-cli",
      modelId: "claude-fable-50",
    });

    expect(profile).not.toBeNull();
    expect(profile?.defaultLevel).not.toBe("off");
  });

  it("preserves the existing Claude CLI Mythos Preview thinking profile", () => {
    const profile = resolveThinkingProfile({
      provider: "claude-cli",
      modelId: "claude-mythos-preview",
    });

    expect(profile?.defaultLevel).toBe("adaptive");
    expect(profile?.levels.map((level) => level.id)).not.toContain("max");
  });

  it("exposes native max without xhigh for direct Claude 4.6 routes", () => {
    for (const provider of ["anthropic", "claude-cli"]) {
      const profile = resolveThinkingProfile({
        provider,
        modelId: "claude-opus-4-6",
      });

      if (!profile) {
        throw new Error(`Expected ${provider} policy profile`);
      }
      expect(levelIds(profile.levels)).toContain("adaptive");
      expect(levelIds(profile.levels)).toContain("max");
      expect(profile.defaultLevel).toBe("adaptive");
      expect(collectLegacyExtendedLevelIds(profile.levels)).toStrictEqual(["max"]);
    }
  });

  it("does not expose Anthropic thinking profiles for unrelated providers", () => {
    expect(
      resolveThinkingProfile({
        provider: "openai",
        modelId: "claude-opus-4-7",
      }),
    ).toBeNull();
  });
});
