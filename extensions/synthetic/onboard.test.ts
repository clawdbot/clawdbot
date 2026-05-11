import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryModel,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { SYNTHETIC_DEFAULT_MODEL_REF as SYNTHETIC_DEFAULT_MODEL_REF_PUBLIC } from "./api.js";
import { buildSyntheticModelDefinition, SYNTHETIC_MODEL_CATALOG } from "./models.js";
import {
  applySyntheticConfig,
  applySyntheticProviderConfig,
  SYNTHETIC_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("synthetic onboard", () => {
  it("adds synthetic provider with correct settings", () => {
    const cfg = applySyntheticConfig({});
    const provider = cfg.models?.providers?.synthetic;
    expect(provider?.baseUrl).toBe("https://api.synthetic.new/anthropic");
    expect(provider?.api).toBe("anthropic-messages");
    expect(provider?.models.map((model) => model.id)).toContain(
      SYNTHETIC_DEFAULT_MODEL_REF.replace(/^synthetic\//, ""),
    );
    expect(cfg.agents?.defaults?.models?.[SYNTHETIC_DEFAULT_MODEL_REF]).toEqual({
      alias: "MiniMax M2.5",
    });
    expect(cfg.agents?.defaults?.model).toEqual({
      primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5",
    });
    expect(provider).toEqual({
      baseUrl: "https://api.synthetic.new/anthropic",
      api: "anthropic-messages",
      models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
    });
    expectProviderOnboardPrimaryModel({
      applyConfig: applySyntheticConfig,
      modelRef: SYNTHETIC_DEFAULT_MODEL_REF_PUBLIC,
    });
  });

  it("keeps the public default model ref aligned", () => {
    expect(SYNTHETIC_DEFAULT_MODEL_REF).toBe(SYNTHETIC_DEFAULT_MODEL_REF_PUBLIC);
    expectProviderOnboardPrimaryModel({
      applyConfig: applySyntheticConfig,
      modelRef: SYNTHETIC_DEFAULT_MODEL_REF,
    });
  });

  it("merges existing synthetic provider models", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applySyntheticProviderConfig,
      providerId: "synthetic",
      providerApi: "anthropic-messages",
      baseUrl: "https://api.synthetic.new/anthropic",
      legacyApi: "openai-completions",
    });
    const ids = provider?.models.map((m) => m.id);
    expect(ids).toContain("old-model");
    expect(ids).toContain(SYNTHETIC_DEFAULT_MODEL_REF.replace(/^synthetic\//, ""));
  });
});
