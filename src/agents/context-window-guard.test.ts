import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  formatContextWindowBlockMessage,
  formatContextWindowWarningMessage,
  resolveContextWindowInfo,
} from "./context-window-guard.js";

describe("context-window-guard", () => {
  it("blocks below 16k (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 8000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.source).toBe("model");
    expect(guard.tokens).toBe(8000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(true);
  });

  it("warns below 32k but does not block at 16k+", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "small",
      modelContextWindow: 24_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.tokens).toBe(24_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not warn at 32k+ (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "ok",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("uses models.providers.*.models[].contextWindow when present", () => {
    const cfg = {
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
    const cfg = {
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
                contextWindow: 1_050_000,
                contextTokens: 12_000,
                maxTokens: 256,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

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

  it("allows overriding thresholds", () => {
    const info = { tokens: 10_000, source: "model" as const };
    const guard = evaluateContextWindowGuard({
      info,
      warnBelowTokens: 12_000,
      hardMinTokens: 9_000,
    });
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("exports thresholds as expected", () => {
    expect(CONTEXT_WINDOW_HARD_MIN_TOKENS).toBe(16_000);
    expect(CONTEXT_WINDOW_WARN_BELOW_TOKENS).toBe(32_000);
  });

  it("adds a local-model hint to warning messages for localhost endpoints", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 24_000, source: "model" },
    });

    expect(
      formatContextWindowWarningMessage({
        provider: "lmstudio",
        modelId: "qwen3",
        guard,
        runtimeBaseUrl: "http://127.0.0.1:1234/v1",
      }),
    ).toContain("local/self-hosted runs work best at 32000+ tokens");
  });

  it("does not add local-model hints for generic custom endpoints", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 24_000, source: "model" },
    });

    expect(
      formatContextWindowWarningMessage({
        provider: "custom",
        modelId: "hosted-proxy-model",
        guard,
        runtimeBaseUrl: "https://models.example.com/v1",
      }),
    ).toBe("low context window: custom/hosted-proxy-model ctx=24000 (warn<32000) source=model");
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
      info: { tokens: 8_000, source: "model" },
    });

    expect(
      formatContextWindowBlockMessage({
        guard,
        runtimeBaseUrl: "https://api.openai.com/v1",
      }),
    ).toBe(`Model context window too small (8000 tokens; source=model). Minimum is 16000.`);
  });
});
