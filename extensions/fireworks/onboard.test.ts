import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyFireworksConfig } from "./onboard.js";
import { FIREWORKS_DEFAULT_MODEL_REF, buildFireworksCatalogModels } from "./provider-catalog.js";

describe("Fireworks onboarding", () => {
  it("applies the manifest catalog, default, and alias in replace mode", () => {
    const config = applyFireworksConfig({ models: { mode: "replace" } });

    expect(config.models?.providers?.fireworks?.models).toEqual(buildFireworksCatalogModels());
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      FIREWORKS_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [FIREWORKS_DEFAULT_MODEL_REF]: { alias: "GLM 5.2 Fast" },
    });
  });

  it.each([undefined, "merge"] as const)("leaves ordinary %s catalogs runtime-owned", (mode) => {
    const config = applyFireworksConfig({ models: { mode } });

    expect(config.models?.providers?.fireworks?.models).toEqual([]);
    expect(config.agents?.defaults?.models?.[FIREWORKS_DEFAULT_MODEL_REF]).toEqual({
      alias: "GLM 5.2 Fast",
    });
    expect(applyFireworksConfig(config)).toEqual(config);
  });
});
