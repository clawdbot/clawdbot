// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildDefaultModelsPatch,
  buildProviderApiKeyPatch,
  DEFAULT_MODELS_REPLACE_PATHS,
} from "./mutations.ts";

describe("model provider config patches", () => {
  it("sets and removes provider API keys with minimal merge patches", () => {
    expect(buildProviderApiKeyPatch("openai", "new-key")).toEqual({
      models: { providers: { openai: { apiKey: "new-key" } } },
    });
    expect(buildProviderApiKeyPatch("openai", null)).toEqual({
      models: { providers: { openai: { apiKey: null } } },
    });
  });

  it("batches primary, fallbacks, and utility into one patch", () => {
    expect(buildDefaultModelsPatch("openai/gpt-5", [], null)).toEqual({
      agents: { defaults: { model: "openai/gpt-5", utilityModel: null } },
    });
    expect(
      buildDefaultModelsPatch("openai/gpt-5", ["anthropic/claude-sonnet-4-5"], "openai/gpt-5-mini"),
    ).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5",
            fallbacks: ["anthropic/claude-sonnet-4-5"],
          },
          utilityModel: "openai/gpt-5-mini",
        },
      },
    });
    expect(buildDefaultModelsPatch("openai/gpt-5", [], "")).toEqual({
      agents: { defaults: { model: "openai/gpt-5", utilityModel: "" } },
    });
  });

  it("confirms fallback-array shrinkage for the gateway destructive-array guard", () => {
    expect(DEFAULT_MODELS_REPLACE_PATHS).toEqual(["agents.defaults.model.fallbacks"]);
  });
});
