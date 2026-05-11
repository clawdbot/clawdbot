import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyDefaultModel, applyProviderAuthConfigPatch } from "./provider-auth-choice-helpers.js";

describe("applyProviderAuthConfigPatch", () => {
  const base = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-5.2"] },
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
          "anthropic/claude-opus-4-6": { alias: "Opus" },
          "openai/gpt-5.2": {},
        },
      },
    },
  };

  it("merges default model maps by default so other providers survive login", () => {
    const patch = { agents: { defaults: { models: { "openai/gpt-5.5": {} } } } };
    const next = applyProviderAuthConfigPatch(base, patch);
    expect(next.agents?.defaults?.models).toEqual({
      ...base.agents.defaults.models,
      "openai/gpt-5.5": {},
    });
    expect(next.agents?.defaults?.model).toEqual(base.agents.defaults.model);
  });

  it("replaces the allowlist only when replaceDefaultModels is set", () => {
    const patch = {
      agents: {
        defaults: {
          models: {
            "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
            "openai/gpt-5.2": {},
          },
        },
      },
    };
    const next = applyProviderAuthConfigPatch(base, patch, { replaceDefaultModels: true });
    expect(next.agents?.defaults?.models).toEqual(patch.agents.defaults.models);
    expect(next.agents?.defaults?.model).toEqual(base.agents.defaults.model);
  });

  it("drops prototype-pollution keys from the merge", () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"agents":{"defaults":{}}}');
    const next = applyProviderAuthConfigPatch(base, patch);
    expect(next.agents?.defaults?.models).toEqual(base.agents.defaults.models);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(next).polluted).toBeUndefined();
  });

  it("drops prototype-pollution keys from opt-in model replacement", () => {
    const patch = JSON.parse(
      '{"agents":{"defaults":{"models":{"__proto__":{"polluted":true},"claude-cli/claude-sonnet-4-6":{"alias":"Sonnet","params":{"constructor":{"polluted":true},"maxTokens":12000}}}}}}',
    );
    const next = applyProviderAuthConfigPatch(base, patch, { replaceDefaultModels: true });
    const models = next.agents?.defaults?.models;
    expect(models).toEqual({
      "claude-cli/claude-sonnet-4-6": {
        alias: "Sonnet",
        params: { maxTokens: 12000 },
      },
    });
    expect(Object.prototype.hasOwnProperty.call(models, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(Object.assign({}, models)).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps normal recursive merges for unrelated provider auth patch fields", () => {
    const base = {
      agents: {
        defaults: {
          contextPruning: {
            mode: "cache-ttl",
            ttl: "30m",
          },
        },
      },
    } satisfies OpenClawConfig;
    const patch = {
      agents: {
        defaults: {
          contextPruning: {
            ttl: "1h",
          },
        },
      },
    };

    const next = applyProviderAuthConfigPatch(base, patch);

    expect(next).toEqual({
      agents: {
        defaults: {
          contextPruning: {
            mode: "cache-ttl",
            ttl: "1h",
          },
        },
      },
    });
  });

  it("normalizes retired Google Gemini model refs from provider config patches", () => {
    const patch = {
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3-pro-preview",
            fallbacks: ["google/gemini-3-pro-preview", "openai/gpt-5.5"],
          },
          models: {
            "google/gemini-3-pro-preview": {
              alias: "gemini",
              params: { thinking: "high" },
            },
            "google/gemini-3.1-pro-preview": {
              params: { maxTokens: 12_000 },
            },
          },
        },
      },
    };

    const next = applyProviderAuthConfigPatch({}, patch);

    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview", "openai/gpt-5.5"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "gemini",
        params: { thinking: "high", maxTokens: 12_000 },
      },
    });
  });

  it("normalizes retired Google Gemini keys when replacing provider model maps", () => {
    const patch = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3-pro-preview": {},
          },
        },
      },
    };

    const next = applyProviderAuthConfigPatch(base, patch, { replaceDefaultModels: true });

    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {},
    });
  });

  it("normalizes retired Google Gemini provider catalog rows from provider config patches", () => {
    const patch = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            api: "openai-completions",
            apiKey: "GOOGLE_API_KEY",
            models: [
              {
                id: "google/gemini-3-pro-preview",
                name: "Gemini 3 Pro Preview",
                input: ["text", "image"],
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyProviderAuthConfigPatch({}, patch);

    expect(next.models?.providers?.google?.models?.[0]?.id).toBe("google/gemini-3.1-pro-preview");
    expect(next.models?.providers?.google?.api).toBe("openai-completions");
  });

  it("normalizes nested retired Gemini provider catalog rows from proxy config patches", () => {
    const patch = {
      models: {
        providers: {
          kilocode: {
            baseUrl: "https://proxy.example/v1",
            api: "openai-completions",
            apiKey: "KILOCODE_API_KEY",
            models: [
              {
                id: "google/gemini-3-pro-preview",
                name: "Gemini via Kilo",
                input: ["text", "image"],
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyProviderAuthConfigPatch({}, patch);

    expect(next.models?.providers?.kilocode?.models?.[0]?.id).toBe("google/gemini-3.1-pro-preview");
  });
});

describe("applyDefaultModel", () => {
  it("sets the primary when none exists", () => {
    const config = {
      agents: { defaults: {} },
    } as OpenClawConfig;
    const next = applyDefaultModel(config, "openrouter/auto");
    expect(next.agents?.defaults?.model).toEqual({ primary: "openrouter/auto" });
  });

  it("overwrites an existing primary by default", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as OpenClawConfig;
    const next = applyDefaultModel(config, "openrouter/auto");
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openrouter/auto",
    });
  });

  it("preserves an existing primary when requested", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as OpenClawConfig;
    const next = applyDefaultModel(config, "openrouter/auto", {
      preserveExistingPrimary: true,
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
    });
  });

  it("normalizes a preserved retired Google Gemini primary", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-3-pro-preview" },
        },
      },
    } as OpenClawConfig;
    const next = applyDefaultModel(config, "openrouter/auto", {
      preserveExistingPrimary: true,
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
    });
  });

  it("preserves an existing primary and keeps fallbacks", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.4"],
          },
        },
      },
    } as OpenClawConfig;
    const next = applyDefaultModel(config, "openrouter/auto", {
      preserveExistingPrimary: true,
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-5.4"],
    });
  });

  it("adds the model to the allowlist", () => {
    const config = {
      agents: { defaults: { models: { "anthropic/claude-sonnet-4-6": {} } } },
    } as OpenClawConfig;
    const next = applyDefaultModel(config, "openrouter/auto");
    expect(next.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": {},
      "openrouter/auto": {},
    });
  });

  it("normalizes retired Google Gemini default models before writing config", () => {
    const config = {
      agents: { defaults: { models: { "anthropic/claude-sonnet-4-6": {} } } },
    } as OpenClawConfig;
    const next = applyDefaultModel(config, "google/gemini-3-pro-preview");
    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
    });
    expect(next.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": {},
      "google/gemini-3.1-pro-preview": {},
    });
  });

  it("normalizes existing retired Google Gemini model keys before writing defaults", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3-pro-preview": {
              alias: "gemini",
              params: { thinking: "high" },
            },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyDefaultModel(config, "google/gemini-3.1-pro-preview");

    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "gemini",
        params: { thinking: "high" },
      },
    });
  });

  it("normalizes retired Google Gemini fallbacks when writing config", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["google/gemini-3-pro-preview"],
          },
        },
      },
    } as OpenClawConfig;
    const next = applyDefaultModel(config, "openrouter/auto");
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openrouter/auto",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
  });
});
