import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { VENICE_DEFAULT_MODEL_REF } from "./models.js";
import { applyVeniceConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Venice onboarding", () => {
  it("applies the manifest catalog, default, and alias", () => {
    const config = applyVeniceConfig({});

    expect(config.models?.providers?.venice?.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.venice.models.map((model) => model.id),
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      VENICE_DEFAULT_MODEL_REF,
    );
    expect(VENICE_DEFAULT_MODEL_REF).toBe("venice/zai-org-glm-4.7");
    expect(config.agents?.defaults?.models).toEqual({
      [VENICE_DEFAULT_MODEL_REF]: { alias: "GLM 4.7" },
    });
  });
});
