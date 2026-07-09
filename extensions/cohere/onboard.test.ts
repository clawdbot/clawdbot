import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  buildCohereCatalogModels,
  COHERE_BASE_URL,
  COHERE_COMMAND_A_REASONING_MODEL_ID,
  COHERE_COMMAND_A_VISION_MODEL_ID,
  COHERE_MODEL_CATALOG,
  COHERE_NORTH_MINI_CODE_MODEL_ID,
} from "./models.js";
import { applyCohereConfig, COHERE_DEFAULT_MODEL_ID, COHERE_DEFAULT_MODEL_REF } from "./onboard.js";

describe("Cohere onboarding", () => {
  it("registers the manifest catalog through the onboarding preset", () => {
    const result = applyCohereConfig({});
    const provider = result.models?.providers?.cohere;

    expect(provider).toMatchObject({
      baseUrl: COHERE_BASE_URL,
      api: "openai-completions",
    });
    expect(provider?.models?.map((model) => model.id)).toEqual([
      COHERE_DEFAULT_MODEL_ID,
      "command-a-03-2025",
      COHERE_COMMAND_A_REASONING_MODEL_ID,
      COHERE_COMMAND_A_VISION_MODEL_ID,
      COHERE_NORTH_MINI_CODE_MODEL_ID,
    ]);
    expect(buildCohereCatalogModels()).toHaveLength(COHERE_MODEL_CATALOG.length);
  });

  it("sets Cohere only when there is no primary model", () => {
    const existing: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
    };

    const result = applyCohereConfig(existing);

    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe("openai/gpt-5.5");
    expect(result.agents?.defaults?.models?.[COHERE_DEFAULT_MODEL_REF]).toEqual({
      alias: "Cohere Command A+",
    });
  });

  it("uses Cohere as the first configured primary model", () => {
    const result = applyCohereConfig({});

    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
      COHERE_DEFAULT_MODEL_REF,
    );
  });
});
