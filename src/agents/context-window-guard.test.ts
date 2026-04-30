import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  formatContextWindowBlockMessage,
  formatContextWindowWarningMessage,
  resolveContextWindowGuardThresholds,
  resolveContextWindowInfo,
} from "./context-window-guard.js";

describe("context-window-guard", () => {
  function openRouterModelConfig(params: { contextWindow: number; contextTokens?: number }) {
    return {
      models: {
        providers: {
          openrouter: {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "tiny",
                name: "tiny",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: params.contextWindow,
                contextTokens: params.contextTokens,
                maxTokens: 256,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
  }

  it("blocks below the hard-min floor (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 3999,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.source).toBe("model");
    expect(guard.tokens).toBe(3999);
    expect(guard.hardMinTokens).toBe(4000);
    expect(guard.warnBelowTokens).toBe(8000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(true);
  });

  it("warns below the warning floor but does not block at hard-min+", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "small",
      modelContextWindow: 6_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.tokens).toBe(6_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not warn at the warning floor (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "ok",
      modelContextWindow: 8_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("uses models.providers.*.models[].contextWindow when present", () => {
    const cfg = openRouterModelConfig({ contextWindow: 3_000 });

    const info = resolveContextWindowInfo({
      cfg,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("modelsConfig");
    expect(guard.shouldBlock).toBe(true);
  });

  it("prefers models.providers.*.models[].contextTokens over contextWindow", () => {
    const cfg = openRouterModelConfig({ contextWindow: 1_050_000, contextTokens: 12_000 });

    const info = resolveContextWindowInfo({
      cfg,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 64_000,
      modelContextTokens: 48_000,
      defaultTokens: 200_000,
    });

    expect(info).toEqual({
      source: "modelsConfig",
      tokens: 12_000,
    });
  });

  it("normalizes provider aliases when reading models config context windows", () => {
    const cfg = {
      models: {
        providers: {
          "z.ai": {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "glm-5",
                name: "glm-5",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 12_000,
                maxTokens: 256,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      provider: "z-ai",
      modelId: "glm-5",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });

    expect(info).toEqual({
      source: "modelsConfig",
      tokens: 12_000,
    });
  });

  it("caps with agents.defaults.contextTokens", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 20_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      provider: "anthropic",
      modelId: "whatever",
      modelContextWindow: 200_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("agentContextTokens");
    expect(info.tokens).toBe(20_000);
    expect(info.referenceTokens).toBe(200_000);
    expect(guard.hardMinTokens).toBe(20_000);
    expect(guard.warnBelowTokens).toBe(40_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not override when cap exceeds base window", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 128_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      provider: "anthropic",
      modelId: "whatever",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    expect(info.source).toBe("model");
    expect(info.tokens).toBe(64_000);
  });

  it("uses default when nothing else is available", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "anthropic",
      modelId: "unknown",
      modelContextWindow: undefined,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("default");
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("normalizes invalid default context tokens to the warning floor", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "anthropic",
      modelId: "unknown",
      defaultTokens: Number.NaN,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info).toEqual({ source: "default", tokens: 8_000 });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("blocks invalid guard token counts instead of silently passing", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: Number.NaN, source: "model" },
    });
    expect(guard.tokens).toBe(0);
    expect(guard.hardMinTokens).toBe(4_000);
    expect(guard.warnBelowTokens).toBe(8_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(true);
  });

  it("allows overriding thresholds", () => {
    const info = { tokens: 10_000, source: "model" as const };
    const guard = evaluateContextWindowGuard({
      info,
      warnBelowTokens: 12_000,
      hardMinTokens: 9_000,
    });
    expect(guard.hardMinTokens).toBe(9_000);
    expect(guard.warnBelowTokens).toBe(12_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("exports threshold floors as expected", () => {
    expect(CONTEXT_WINDOW_HARD_MIN_TOKENS).toBe(4_000);
    expect(CONTEXT_WINDOW_WARN_BELOW_TOKENS).toBe(8_000);
  });

  it("derives percentage-based thresholds above the safe floors", () => {
    expect(resolveContextWindowGuardThresholds(1_000_000)).toEqual({
      hardMinTokens: 100_000,
      warnBelowTokens: 200_000,
    });
    expect(resolveContextWindowGuardThresholds(64_000)).toEqual({
      hardMinTokens: 6_400,
      warnBelowTokens: 12_800,
    });
    expect(resolveContextWindowGuardThresholds(Number.NaN)).toEqual({
      hardMinTokens: 4_000,
      warnBelowTokens: 8_000,
    });
  });

  it("derives guard thresholds from the reference window when capped", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 150_000, referenceTokens: 1_000_000, source: "agentContextTokens" },
    });
    expect(guard.hardMinTokens).toBe(100_000);
    expect(guard.warnBelowTokens).toBe(200_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not let inflated reference metadata hard-block a valid effective cap", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 20_000, referenceTokens: 1_000_000_000, source: "agentContextTokens" },
    });
    expect(guard.hardMinTokens).toBe(20_000);
    expect(guard.warnBelowTokens).toBe(200_000_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("adds a local-model hint to warning messages for localhost endpoints", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 6_000, source: "model" },
    });

    expect(
      formatContextWindowWarningMessage({
        provider: "lmstudio",
        modelId: "qwen3",
        guard,
        runtimeBaseUrl: "http://127.0.0.1:1234/v1",
      }),
    ).toContain("local/self-hosted runs work best at 8000+ tokens");
  });

  it("does not add local-model hints for generic custom endpoints", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 6_000, source: "model" },
    });

    expect(
      formatContextWindowWarningMessage({
        provider: "custom",
        modelId: "hosted-proxy-model",
        guard,
        runtimeBaseUrl: "https://models.example.com/v1",
      }),
    ).toBe("low context window: custom/hosted-proxy-model ctx=6000 (warn<8000) source=model");
  });

  it("adds a local-model hint to block messages for localhost endpoints", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 8_000, source: "model" },
    });

    expect(
      formatContextWindowBlockMessage({
        guard,
        runtimeBaseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toContain("This looks like a local model endpoint.");
  });

  it("points config-backed block remediation at agents.defaults.contextTokens", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 8_000, source: "agentContextTokens" },
    });

    const message = formatContextWindowBlockMessage({
      guard,
      runtimeBaseUrl: "http://127.0.0.1:11434/v1",
    });

    expect(message).toContain("OpenClaw is capped by agents.defaults.contextTokens.");
    expect(message).not.toContain("choose a larger model");
  });

  it("points model config block remediation at contextWindow/contextTokens", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 8_000, source: "modelsConfig" },
    });

    expect(
      formatContextWindowBlockMessage({
        guard,
        runtimeBaseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toContain("Raise contextWindow/contextTokens or choose a larger model.");
  });

  it("keeps block messages concise for public providers", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 3_000, source: "model" },
    });

    expect(
      formatContextWindowBlockMessage({
        guard,
        runtimeBaseUrl: "https://api.openai.com/v1",
      }),
    ).toBe(`Model context window too small (3000 tokens; source=model). Minimum is 4000.`);
  });
});
