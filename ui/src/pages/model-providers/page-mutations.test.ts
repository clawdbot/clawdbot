// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildDefaultsPatch,
  buildProviderApiKeyPatch,
  DEFAULT_MODELS_REPLACE_PATHS,
  modelProviderErrorMessage,
} from "./page-mutations.ts";

describe("model provider config patches", () => {
  it("redacts secrets in displayed mutation failures", () => {
    expect(modelProviderErrorMessage(new Error("OPENAI_API_KEY=sk-1234567890abcdef"))).toBe(
      "OPENAI_API_KEY=sk-123...cdef",
    );
  });

  it("sets and removes provider API keys with minimal merge patches", () => {
    expect(buildProviderApiKeyPatch("openai", "new-key")).toEqual({
      models: { providers: { openai: { apiKey: "new-key" } } },
    });
    expect(buildProviderApiKeyPatch("openai", null)).toEqual({
      models: { providers: { openai: { apiKey: null } } },
    });
  });

  it("batches model and behavior defaults into one patch", () => {
    expect(
      buildDefaultsPatch({
        primary: "openai/gpt-5",
        fallbacks: [],
        utilityModel: null,
        thinkingLevel: "high",
        thinkingOverridden: true,
        fastMode: false,
        fastModeOverridden: true,
      }),
    ).toEqual({
      agents: {
        defaults: {
          model: "openai/gpt-5",
          utilityModel: null,
          thinkingDefault: "high",
          fastModeDefault: false,
        },
      },
    });
    expect(
      buildDefaultsPatch({
        primary: "openai/gpt-5",
        fallbacks: ["anthropic/claude-sonnet-4-5"],
        utilityModel: "openai/gpt-5-mini",
        thinkingLevel: undefined,
        thinkingOverridden: false,
        fastMode: undefined,
        fastModeOverridden: false,
      }),
    ).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5",
            fallbacks: ["anthropic/claude-sonnet-4-5"],
          },
          utilityModel: "openai/gpt-5-mini",
          thinkingDefault: null,
          fastModeDefault: null,
        },
      },
    });
  });

  it("confirms fallback-array shrinkage for the gateway destructive-array guard", () => {
    expect(DEFAULT_MODELS_REPLACE_PATHS).toEqual(["agents.defaults.model.fallbacks"]);
  });
});
