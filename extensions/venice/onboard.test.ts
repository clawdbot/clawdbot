import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { VENICE_DEFAULT_MODEL_REF, VENICE_MODEL_CATALOG } from "./models.js";
import { applyVeniceConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Venice onboarding", () => {
  it("keeps generated model prices out of merge-mode config while selecting the default and alias", () => {
    const config = applyVeniceConfig({});

    expect(config.models?.providers?.venice?.models).toEqual([]);
    expect(config.models?.mode).toBe("merge");
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
    const [seed] = VENICE_MODEL_CATALOG;
    if (!seed) {
      throw new Error("expected a Venice seed model");
    }
    const model = {
      ...structuredClone(seed),
      cost,
    };
    config.models!.providers!.venice!.models = [model];
    config.models!.providers!.venice!.apiKey = "fixture-key";
    config.agents!.defaults!.model = { primary: "custom/primary", fallbacks: ["custom/fallback"] };
    config.agents!.defaults!.models = { [VENICE_DEFAULT_MODEL_REF]: { alias: "My alias" } };

    const reapplied = applyVeniceConfig(config);

    expect(
      reapplied.models?.providers?.venice?.models.find(({ id }) => id === model.id)?.cost,
    ).toEqual(cost);
    expect(reapplied.models?.providers?.venice?.models).toEqual([model]);
    expect(reapplied.models?.providers?.venice?.apiKey).toBe("fixture-key");
    expect(reapplied.agents?.defaults).toEqual(config.agents?.defaults);
  });

  it("retains the explicit offline seed in replace mode where discovery is disabled", () => {
    const config = applyVeniceConfig({ models: { mode: "replace" } });
    expect(config.models?.mode).toBe("replace");
    expect(config.models?.providers?.venice?.models.map(({ id, cost }) => ({ id, cost }))).toEqual(
      manifest.modelCatalog.providers.venice.models.map(({ id, cost }) => ({ id, cost })),
    );
  });
});
