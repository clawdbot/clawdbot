import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPreservesPrimary,
} from "../../test/helpers/plugins/provider-onboard.js";
import { applyMinimaxApiConfig, applyMinimaxApiProviderConfig } from "./onboard.js";

describe("minimax onboard", () => {
  it("adds minimax provider with correct settings", () => {
    const cfg = applyMinimaxApiConfig({});
    expect(cfg.models?.providers?.minimax).toMatchObject({
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
      authHeader: true,
    });
  });

  it("keeps reasoning enabled for MiniMax-M2.7", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.7");
    expect(cfg.models?.providers?.minimax?.models[0]?.reasoning).toBe(true);
  });

  it("preserves existing model params when adding alias", () => {
    const cfg = applyMinimaxApiConfig(
      {
        agents: {
          defaults: {
            models: {
              "minimax/MiniMax-M2.7": {
                alias: "MiniMax",
                params: { custom: "value" },
              },
            },
          },
        },
      },
      "MiniMax-M2.7",
    );
    expect(cfg.agents?.defaults?.models?.["minimax/MiniMax-M2.7"]).toMatchObject({
      alias: "Minimax",
      params: { custom: "value" },
    });
  });

  it("merges existing minimax provider models", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applyMinimaxApiConfig,
      providerId: "minimax",
      providerApi: "anthropic-messages",
      baseUrl: "https://api.minimax.io/anthropic",
      legacyApi: "openai-completions",
    });
    expect(provider?.authHeader).toBe(true);
    expect(provider?.models.map((m) => m.id)).toEqual(["old-model", "MiniMax-M2.7"]);
  });

  it("preserves other providers when adding minimax", () => {
    const cfg = applyMinimaxApiConfig({
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            apiKey: "anthropic-key",
            api: "anthropic-messages",
            models: [
              {
                id: "claude-opus-4-5",
                name: "Claude Opus 4.5",
                reasoning: false,
                input: ["text"],
                cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });
    expect(cfg.models?.providers?.anthropic).toBeDefined();
    expect(cfg.models?.providers?.minimax).toBeDefined();
  });

  it("preserves existing models mode", () => {
    const cfg = applyMinimaxApiConfig({
      models: { mode: "replace", providers: {} },
    });
    expect(cfg.models?.mode).toBe("replace");
  });

  it("does not overwrite existing primary model in provider-only mode", () => {
    expectProviderOnboardPreservesPrimary({
      applyProviderConfig: applyMinimaxApiProviderConfig,
      primaryModelRef: "anthropic/claude-opus-4-5",
    });
  });

  it("sets the chosen model as primary in config mode", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.7-highspeed");
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      "minimax/MiniMax-M2.7-highspeed",
    );
  });
});
