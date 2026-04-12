import { describe, expect, it } from "vitest";
import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryModel,
} from "../../test/helpers/plugins/provider-onboard.js";
import { applyXiaomiConfig, applyXiaomiProviderConfig } from "./onboard.js";

describe("xiaomi onboard", () => {
  it("adds Xiaomi provider with correct settings", () => {
    const cfg = applyXiaomiConfig({});
    expect(cfg.models?.providers?.xiaomi).toMatchObject({
      baseUrl: "https://api.xiaomimimo.com/v1",
      api: "openai-completions",
    });
    expect(cfg.models?.providers?.xiaomi?.models.map((m) => m.id)).toEqual([
      "mimo-v2-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
    ]);
    expectProviderOnboardPrimaryModel({
      applyConfig: applyXiaomiConfig,
      modelRef: "xiaomi/mimo-v2-flash",
    });
  });

  it("merges Xiaomi models and keeps existing provider overrides", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applyXiaomiProviderConfig,
      providerId: "xiaomi",
      providerApi: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      legacyApi: "openai-completions",
      legacyModelId: "custom-model",
      legacyModelName: "Custom",
    });
    expect(provider?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "mimo-v2-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
    ]);
  });
});
