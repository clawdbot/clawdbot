import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { VENICE_DEFAULT_MODEL_REF } from "./models.js";
import { applyVeniceConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Venice onboarding", () => {
  it("applies the manifest catalog, default, and alias", () => {
    const config = applyVeniceConfig({});

    expect(config.models?.providers?.venice?.models.map(({ id, cost }) => ({ id, cost }))).toEqual(
      manifest.modelCatalog.providers.venice.models.map(({ id, cost }) => ({ id, cost })),
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      VENICE_DEFAULT_MODEL_REF,
    );
    expect(VENICE_DEFAULT_MODEL_REF).toBe("venice/zai-org-glm-4.7");
    expect(config.agents?.defaults?.models).toEqual({
      [VENICE_DEFAULT_MODEL_REF]: { alias: "GLM 4.7" },
    });
  });

  it.each([
    { label: "zero", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { label: "custom", cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 } },
  ])("preserves existing $label pricing when onboarding again", ({ cost }) => {
    const config = applyVeniceConfig({});
    const model = config.models!.providers!.venice!.models[0]!;
    model.cost = { ...cost };

    const reapplied = applyVeniceConfig(config);

    expect(
      reapplied.models?.providers?.venice?.models.find(({ id }) => id === model.id)?.cost,
    ).toEqual(cost);
  });
});
