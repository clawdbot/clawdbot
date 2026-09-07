import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyMoonshotConfig, applyMoonshotConfigCn } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./provider-catalog.js";

describe("Moonshot onboarding", () => {
  it.each([
    ["international", applyMoonshotConfig, MOONSHOT_BASE_URL],
    ["China", applyMoonshotConfigCn, MOONSHOT_CN_BASE_URL],
  ])(
    "applies the replace-mode manifest default on the %s endpoint",
    (_name, applyConfig, baseUrl) => {
      const config = applyConfig({ models: { mode: "replace" } });
      const provider = config.models?.providers?.moonshot;

      expect(MOONSHOT_DEFAULT_MODEL_ID).toBe(manifest.modelCatalog.providers.moonshot.defaultModel);
      expect(provider?.baseUrl).toBe(baseUrl);
      expect(provider?.models.map((model) => model.id)).toEqual([MOONSHOT_DEFAULT_MODEL_ID]);
      expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
        MOONSHOT_DEFAULT_MODEL_REF,
      );
      expect(config.agents?.defaults?.models).toEqual({
        [MOONSHOT_DEFAULT_MODEL_REF]: { alias: "Kimi" },
      });
    },
  );

  it.each([
    ["international", applyMoonshotConfig],
    ["China", applyMoonshotConfigCn],
  ] as const)("leaves ordinary %s catalogs runtime-owned", (_name, applyConfig) => {
    for (const mode of [undefined, "merge"] as const) {
      const config = applyConfig({ models: { mode } });
      expect(config.models?.providers?.moonshot?.models).toEqual([]);
      expect(config.agents?.defaults?.models?.[MOONSHOT_DEFAULT_MODEL_REF]).toEqual({
        alias: "Kimi",
      });
      expect(applyConfig(config)).toEqual(config);
    }
  });
});
