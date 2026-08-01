import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  applyTokenHubConfig,
  applyTokenPlanConfig,
  TOKENHUB_DEFAULT_MODEL_REF,
  TOKENPLAN_DEFAULT_MODEL_REF,
} from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Tencent onboarding", () => {
  it("applies the TokenHub manifest catalog, default, and aliases", () => {
    const config = applyTokenHubConfig({});

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
    const config = applyTokenPlanConfig({});

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
});
