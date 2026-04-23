import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyProviderAuthConfigPatch } from "./provider-auth-choice-helpers.js";

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
    const patch = { agents: { defaults: { models: { "openai-codex/gpt-5.4": {} } } } };
    const next = applyProviderAuthConfigPatch(base, patch);
    expect(next.agents?.defaults?.models).toEqual({
      ...base.agents.defaults.models,
      "openai-codex/gpt-5.4": {},
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
});
