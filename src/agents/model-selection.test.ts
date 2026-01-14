import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import {
  buildAllowedModelSet,
  modelKey,
  parseModelRef,
  resolveAllowedModelRef,
  resolveHooksGmailModel,
} from "./model-selection.js";

const catalog = [
  {
    provider: "openai",
    id: "gpt-4",
    name: "GPT-4",
  },
];

describe("buildAllowedModelSet", () => {
  it("always allows the configured default model", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4": { alias: "gpt4" },
          },
        },
      },
    } as ClawdbotConfig;

    const allowed = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "claude-cli",
      defaultModel: "opus-4.5",
    });

    expect(allowed.allowAny).toBe(false);
    expect(allowed.allowedKeys.has(modelKey("openai", "gpt-4"))).toBe(true);
    expect(allowed.allowedKeys.has(modelKey("claude-cli", "opus-4.5"))).toBe(
      true,
    );
  });

  it("includes the default model when no allowlist is set", () => {
    const cfg = {
      agents: { defaults: {} },
    } as ClawdbotConfig;

    const allowed = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "claude-cli",
      defaultModel: "opus-4.5",
    });

    expect(allowed.allowAny).toBe(true);
    expect(allowed.allowedKeys.has(modelKey("openai", "gpt-4"))).toBe(true);
    expect(allowed.allowedKeys.has(modelKey("claude-cli", "opus-4.5"))).toBe(
      true,
    );
  });

  it("allows explicit custom providers from models.providers", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "moonshot/kimi-k2-0905-preview": { alias: "kimi" },
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            apiKey: "x",
            api: "openai-completions",
            models: [{ id: "kimi-k2-0905-preview", name: "Kimi" }],
          },
        },
      },
    } as ClawdbotConfig;

    const allowed = buildAllowedModelSet({
      cfg,
      catalog: [],
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });

    expect(allowed.allowAny).toBe(false);
    expect(
      allowed.allowedKeys.has(modelKey("moonshot", "kimi-k2-0905-preview")),
    ).toBe(true);
  });
});

describe("parseModelRef", () => {
  it("normalizes anthropic/opus-4.5 to claude-opus-4-5", () => {
    const ref = parseModelRef("anthropic/opus-4.5", "anthropic");
    expect(ref).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
  });

  it("normalizes google gemini 3 models to preview ids", () => {
    expect(parseModelRef("google/gemini-3-pro", "anthropic")).toEqual({
      provider: "google",
      model: "gemini-3-pro-preview",
    });
    expect(parseModelRef("google/gemini-3-flash", "anthropic")).toEqual({
      provider: "google",
      model: "gemini-3-flash-preview",
    });
  });

  it("normalizes default-provider google models", () => {
    expect(parseModelRef("gemini-3-pro", "google")).toEqual({
      provider: "google",
      model: "gemini-3-pro-preview",
    });
  });
});

describe("resolveHooksGmailModel", () => {
  it("returns null when hooks.gmail.model is not set", () => {
    const cfg = {} satisfies ClawdbotConfig;
    const result = resolveHooksGmailModel({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    expect(result).toBeNull();
  });

  it("returns null when hooks.gmail.model is empty", () => {
    const cfg = {
      hooks: { gmail: { model: "" } },
    } satisfies ClawdbotConfig;
    const result = resolveHooksGmailModel({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    expect(result).toBeNull();
  });

  it("parses provider/model from hooks.gmail.model", () => {
    const cfg = {
      hooks: { gmail: { model: "openrouter/meta-llama/llama-3.3-70b:free" } },
    } satisfies ClawdbotConfig;
    const result = resolveHooksGmailModel({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    expect(result).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b:free",
    });
  });

  it("resolves alias from agent.models", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },
          },
        },
      },
      hooks: { gmail: { model: "Sonnet" } },
    } satisfies ClawdbotConfig;
    const result = resolveHooksGmailModel({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    expect(result).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-1",
    });
  });

  it("uses default provider when model omits provider", () => {
    const cfg = {
      hooks: { gmail: { model: "claude-haiku-3-5" } },
    } satisfies ClawdbotConfig;
    const result = resolveHooksGmailModel({
      cfg,
      defaultProvider: "anthropic",
    });
    expect(result).toEqual({
      provider: "anthropic",
      model: "claude-haiku-3-5",
    });
  });
});

describe("resolveAllowedModelRef", () => {
  it("resolves aliases when allowed", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },
          },
        },
      },
    } satisfies ClawdbotConfig;
    const resolved = resolveAllowedModelRef({
      cfg,
      catalog: [
        {
          provider: "anthropic",
          id: "claude-sonnet-4-1",
          name: "Sonnet",
        },
      ],
      raw: "Sonnet",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });
    expect("error" in resolved).toBe(false);
    if ("ref" in resolved) {
      expect(resolved.ref).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-1",
      });
    }
  });

  it("rejects disallowed models", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4": { alias: "GPT4" },
          },
        },
      },
    } satisfies ClawdbotConfig;
    const resolved = resolveAllowedModelRef({
      cfg,
      catalog: [
        { provider: "openai", id: "gpt-4", name: "GPT-4" },
        { provider: "anthropic", id: "claude-sonnet-4-1", name: "Sonnet" },
      ],
      raw: "anthropic/claude-sonnet-4-1",
      defaultProvider: "openai",
      defaultModel: "gpt-4",
    });
    expect(resolved).toEqual({
      error: "model not allowed: anthropic/claude-sonnet-4-1",
    });
  });
});
