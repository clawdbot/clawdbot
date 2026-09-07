import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionModelIdentityRef, resolveSessionModelRef } from "./session-model-ref.js";

function modelConfig(primary: string, models?: Record<string, object>): OpenClawConfig {
  return {
    agents: {
      defaults: { model: { primary }, ...(models ? { models } : {}) },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

describe("resolveSessionModelRef", () => {
  test("prefers a complete explicit override over runtime identity and current defaults", () => {
    const resolved = resolveSessionModelRef(
      modelConfig("anthropic/claude-opus-4-6"),
      {
        providerOverride: "openrouter",
        modelOverride: "moonshotai/kimi-k2.5",
        modelProvider: "openai",
        model: "gpt-5.4",
      },
      "main",
    );

    expect(resolved).toEqual({ provider: "openrouter", model: "moonshotai/kimi-k2.5" });
  });

  test("uses the current agent default instead of stale runtime identity", () => {
    const resolved = resolveSessionModelRef(
      modelConfig("anthropic/claude-opus-4-6"),
      { modelProvider: "openai", model: "gpt-5.4" },
      "main",
    );

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
  });

  test("preserves runtime identity for legacy callers without an agent id", () => {
    const resolved = resolveSessionModelRef(modelConfig("anthropic/claude-opus-4-6"), {
      modelProvider: "openai",
      model: "gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  test("prefers a legacy model-only override over runtime identity without an agent id", () => {
    const resolved = resolveSessionModelRef(modelConfig("anthropic/claude-opus-4-6"), {
      modelOverride: "claude-haiku-4-5",
      modelProvider: "openai",
      model: "gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  test("resolves a legacy model-only override under the current default provider", () => {
    const resolved = resolveSessionModelRef(
      modelConfig("anthropic/claude-opus-4-6"),
      {
        modelOverride: "claude-haiku-4-5",
        modelProvider: "openai",
        model: "gpt-5.4",
      },
      "main",
    );

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });
});

describe("resolveSessionModelIdentityRef", () => {
  const resolveLegacyIdentityRef = (cfg: OpenClawConfig, modelProvider?: string) =>
    resolveSessionModelIdentityRef(cfg, {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
      model: "claude-sonnet-4-6",
      modelProvider,
    });

  test("does not inherit default provider for unprefixed legacy runtime model", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview");

    expect(resolveLegacyIdentityRef(cfg)).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("infers provider from configured model allowlist when unambiguous", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview", {
      "anthropic/claude-sonnet-4-6": {},
    });

    expect(resolveLegacyIdentityRef(cfg)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  test("infers provider from configured provider catalogs when allowlist is absent", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview");
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    expect(
      resolveSessionModelIdentityRef(cfg, {
        sessionId: "custom-provider-runtime-model",
        updatedAt: Date.now(),
        model: "qwen-max",
        modelProvider: undefined,
      }),
    ).toEqual({ provider: "qwen-dashscope", model: "qwen-max" });
  });

  test("keeps provider unknown when configured models are ambiguous", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview", {
      "anthropic/claude-sonnet-4-6": {},
      "minimax/claude-sonnet-4-6": {},
    });

    expect(resolveLegacyIdentityRef(cfg)).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("keeps provider unknown when configured provider catalog matches are ambiguous", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview");
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
        qwen: {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    expect(
      resolveSessionModelIdentityRef(cfg, {
        sessionId: "ambiguous-custom-provider-runtime-model",
        updatedAt: Date.now(),
        model: "qwen-max",
        modelProvider: undefined,
      }),
    ).toEqual({ model: "qwen-max" });
  });

  test("preserves provider from slash-prefixed runtime model", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview");

    expect(
      resolveSessionModelIdentityRef(cfg, {
        sessionId: "slash-model",
        updatedAt: Date.now(),
        model: "anthropic/claude-sonnet-4-6",
        modelProvider: undefined,
      }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("infers wrapper provider for slash-prefixed runtime model when allowlist match is unique", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview", {
      "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
    });

    expect(
      resolveSessionModelIdentityRef(cfg, {
        sessionId: "slash-model",
        updatedAt: Date.now(),
        model: "anthropic/claude-sonnet-4-6",
        modelProvider: undefined,
      }),
    ).toEqual({
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4-6",
    });
  });
});
