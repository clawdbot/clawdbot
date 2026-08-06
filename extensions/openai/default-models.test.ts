// Openai tests cover default models plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyOpenAIConfig, applyOpenAIProviderConfig, OPENAI_DEFAULT_MODEL } from "./api.js";

describe("openai default models", () => {
  it("adds allowlist entry for the default model", () => {
    const next = applyOpenAIProviderConfig({});
    expect(Object.keys(next.agents?.defaults?.models ?? {})).toEqual([OPENAI_DEFAULT_MODEL]);
    expect(next.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]).toEqual({ alias: "GPT" });
  });

  it("preserves existing alias for the default model", () => {
    const next = applyOpenAIProviderConfig({
      agents: {
        defaults: {
          models: {
            [OPENAI_DEFAULT_MODEL]: { alias: "My GPT" },
          },
        },
      },
    });
    expect(next.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]?.alias).toBe("My GPT");
  });

  it("does not move the GPT alias from an existing model", () => {
    const next = applyOpenAIProviderConfig({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "GPT" },
            "custom/model": { alias: "Custom" },
          },
        },
      },
    });

    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "GPT" },
      "custom/model": { alias: "Custom" },
      [OPENAI_DEFAULT_MODEL]: {},
    });
  });

  it("does not duplicate a case-insensitive custom GPT alias", () => {
    const next = applyOpenAIProviderConfig({
      agents: {
        defaults: {
          models: {
            "custom/model": { alias: "gPt" },
          },
        },
      },
    });

    expect(next.agents?.defaults?.models?.["custom/model"]?.alias).toBe("gPt");
    expect(next.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]).toEqual({});
  });

  it("sets the default model when it is unset", () => {
    const next = applyOpenAIConfig({});
    expect(next.agents?.defaults?.model).toEqual({ primary: OPENAI_DEFAULT_MODEL });
  });

  it("preserves an explicit primary and its fallbacks", () => {
    const next = applyOpenAIConfig({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] } } },
    } as OpenClawConfig);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: [],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "anthropic/claude-opus-4-6": {},
      [OPENAI_DEFAULT_MODEL]: { alias: "GPT" },
    });
  });

  it("fills a missing object-form primary while preserving fallbacks", () => {
    const next = applyOpenAIConfig({
      agents: { defaults: { model: { fallbacks: ["anthropic/claude-opus-4-6"] } } },
    } as OpenClawConfig);

    expect(next.agents?.defaults?.model).toEqual({
      primary: OPENAI_DEFAULT_MODEL,
      fallbacks: ["anthropic/claude-opus-4-6"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "anthropic/claude-opus-4-6": {},
      [OPENAI_DEFAULT_MODEL]: { alias: "GPT" },
    });
  });
});
