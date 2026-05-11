import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPreservesPrimary,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { buildMinimaxApiModelDefinition } from "./model-definitions.js";
import { applyMinimaxApiConfig, applyMinimaxApiProviderConfig } from "./onboard.js";

describe("minimax onboard", () => {
  it("adds minimax provider with correct settings", () => {
    const cfg = applyMinimaxApiConfig({});
    expect(cfg.models?.providers?.minimax).toEqual({
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
      authHeader: true,
      models: [buildMinimaxApiModelDefinition("MiniMax-M2.7")],
    });
    expect(cfg.agents?.defaults?.models?.["minimax/MiniMax-M2.7"]).toEqual({
      alias: "Minimax",
    });
    expect(cfg.agents?.defaults?.model).toEqual({ primary: "minimax/MiniMax-M2.7" });
  });

  it("keeps reasoning enabled for MiniMax-M2.7", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.7");
    expect(cfg.models?.providers?.minimax?.models[0]?.reasoning).toBe(true);
  });

  it("keeps MiniMax chat models text-only so image tools use MiniMax-VL-01", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.7-highspeed");
    expect(cfg.models?.providers?.minimax?.models).toEqual([
      {
        id: "MiniMax-M2.7-highspeed",
        name: "MiniMax M2.7 Highspeed",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 },
        contextWindow: 204800,
        maxTokens: 131072,
      },
    ]);
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
    expect(cfg.agents?.defaults?.models?.["minimax/MiniMax-M2.7"]).toEqual({
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
    expect(cfg.models?.providers).toHaveProperty("anthropic");
    expect(cfg.models?.providers).toHaveProperty("minimax");
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
