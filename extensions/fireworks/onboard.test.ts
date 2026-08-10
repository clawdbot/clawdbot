import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyFireworksConfig } from "./onboard.js";
import { FIREWORKS_DEFAULT_MODEL_REF, buildFireworksCatalogModels } from "./provider-catalog.js";

describe("Fireworks onboarding", () => {
  it("applies the manifest catalog, default, and alias", () => {
    const config = applyFireworksConfig({});

    expect(config.models?.providers?.fireworks?.models).toEqual(buildFireworksCatalogModels());
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      FIREWORKS_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [FIREWORKS_DEFAULT_MODEL_REF]: { alias: "GLM 5.2 Fast" },
    });
  });
});
