import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAllowedModelRef, resolveConfiguredModelRef } from "./model-selection-resolve.js";

describe("model-selection-resolve OpenRouter compat aliases", () => {
  it("preserves exact configured proxy provider ids for cron-style aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "litellm/cron": {},
          },
        },
      },
      models: {
        providers: {
          litellm: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:4000/v1",
            models: [{ id: "cron", name: "Cron route" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAllowedModelRef({
        cfg,
        catalog: [],
        raw: "litellm/cron",
        defaultProvider: "ollama",
        defaultModel: "qwen35-27b-researcher",
      }),
    ).toEqual({
      key: "litellm/cron",
      ref: { provider: "litellm", model: "cron" },
    });
  });

  it("resolves openrouter:auto through the canonical OpenRouter auto model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openrouter:auto" },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      }),
    ).toEqual({ provider: "openrouter", model: "openrouter/auto" });
  });

  it("resolves openrouter:free through the runtime allowlist path", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/meta-llama/llama-3.3-70b-instruct:free": {},
          },
        },
      },
    } as OpenClawConfig;

    const catalog = [
      {
        provider: "openrouter",
        id: "meta-llama/llama-3.3-70b-instruct:free",
        name: "Llama 3.3 70B Free",
      },
    ];

    expect(
      resolveAllowedModelRef({
        cfg,
        catalog,
        raw: "openrouter:free",
        defaultProvider: "anthropic",
      }),
    ).toEqual({
      ref: {
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct:free",
      },
      key: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    });
  });
});
