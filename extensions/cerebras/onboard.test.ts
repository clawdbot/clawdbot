import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyCerebrasConfig, CEREBRAS_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Cerebras onboarding", () => {
  it("applies the manifest catalog, default, and alias", () => {
    const config = applyCerebrasConfig({});

    expect(config.models?.providers?.cerebras?.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.cerebras.models.map((model) => model.id),
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      CEREBRAS_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [CEREBRAS_DEFAULT_MODEL_REF]: { alias: "Cerebras GLM 4.7" },
    });
  });
});
