import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { buildTokenHubProvider, buildTokenPlanProvider } from "./api.js";
import {
  applyTokenHubConfig,
  applyTokenPlanConfig,
  TOKENHUB_DEFAULT_MODEL_REF,
  TOKENPLAN_DEFAULT_MODEL_REF,
} from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Tencent onboarding", () => {
  it("applies the TokenHub manifest catalog, default, and aliases", () => {
    const config = applyTokenHubConfig({ models: { mode: "replace" } });

    expect(config.models?.providers?.["tencent-tokenhub"]?.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers["tencent-tokenhub"].models.map((model) => model.id),
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      TOKENHUB_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [TOKENHUB_DEFAULT_MODEL_REF]: { alias: "Hy3 (TokenHub)" },
      "tencent-tokenhub/hy3-preview": { alias: "Hy3 preview (TokenHub)" },
    });
  });

  it("applies the TokenPlan manifest catalog, default, and alias", () => {
    const config = applyTokenPlanConfig({ models: { mode: "replace" } });

    expect(
      config.models?.providers?.["tencent-tokenplan"]?.models.map((model) => model.id),
    ).toEqual(manifest.modelCatalog.providers["tencent-tokenplan"].models.map((model) => model.id));
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      TOKENPLAN_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [TOKENPLAN_DEFAULT_MODEL_REF]: { alias: "Hy3 (TokenPlan)" },
    });
  });

  it.each([
    { providerId: "tencent-tokenhub", apply: applyTokenHubConfig, build: buildTokenHubProvider },
    { providerId: "tencent-tokenplan", apply: applyTokenPlanConfig, build: buildTokenPlanProvider },
  ])("keeps $providerId generated rows out of merge config", ({ providerId, apply, build }) => {
    expect(apply({}).models?.providers?.[providerId]?.models).toEqual([]);
    const provider = build();
    const authored = provider.models.map((model) =>
      Object.assign({}, model, { id: `operator-${model.id}` }),
    );
    const result = apply({
      models: { mode: "merge", providers: { [providerId]: { ...provider, models: authored } } },
    });
    expect(result.models?.providers?.[providerId]?.models).toEqual(authored);
  });
});
