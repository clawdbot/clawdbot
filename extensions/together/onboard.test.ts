import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { TOGETHER_MODEL_CATALOG } from "./models.js";
import { applyTogetherConfig, TOGETHER_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Together onboarding", () => {
  it("applies the manifest catalog, default, and alias", () => {
    const config = applyTogetherConfig({});

    expect(config.models?.providers?.together?.models.map((model) => model.id)).toEqual(
      TOGETHER_MODEL_CATALOG.map((model) => model.id),
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      TOGETHER_DEFAULT_MODEL_REF,
    );
    expect(TOGETHER_DEFAULT_MODEL_REF).toBe(
      `together/${manifest.modelCatalog.providers.together.defaultModel}`,
    );
    expect(TOGETHER_DEFAULT_MODEL_REF).toBe("together/moonshotai/Kimi-K2.6");
    expect(config.agents?.defaults?.models?.[TOGETHER_DEFAULT_MODEL_REF]).toEqual({
      alias: "Together AI",
    });
  });
});
