import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { buildDeepSeekProvider } from "./api.js";
import { applyDeepSeekConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const DEEPSEEK_DEFAULT_MODEL_REF = `deepseek/${manifest.modelCatalog.providers.deepseek.defaultModel}`;

describe("DeepSeek onboarding", () => {
  it("applies the manifest catalog, default, and alias", () => {
    const config = applyDeepSeekConfig({ models: { mode: "replace" } });

    expect(config.models?.providers?.deepseek?.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.deepseek.models.map((model) => model.id),
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      DEEPSEEK_DEFAULT_MODEL_REF,
    );
    expect(DEEPSEEK_DEFAULT_MODEL_REF).toBe("deepseek/deepseek-v4-pro");
    expect(config.agents?.defaults?.models).toEqual({
      [DEEPSEEK_DEFAULT_MODEL_REF]: { alias: "DeepSeek" },
    });
  });

  it.each([undefined, "merge"] as const)("keeps discovery-owned rows out of %s config", (mode) => {
    const empty = applyDeepSeekConfig({ models: { mode } });
    expect(empty.models?.providers?.deepseek?.models).toEqual([]);
    expect(resolveAgentModelPrimaryValue(empty.agents?.defaults?.model)).toBe(
      DEEPSEEK_DEFAULT_MODEL_REF,
    );

    const provider = buildDeepSeekProvider();
    const authored = provider.models.map((model) =>
      Object.assign({}, model, { id: `operator-${model.id}` }),
    );
    const configured = applyDeepSeekConfig({
      models: { mode, providers: { deepseek: { ...provider, models: authored } } },
    });
    expect(configured.models?.providers?.deepseek?.models).toEqual(authored);
  });
});
