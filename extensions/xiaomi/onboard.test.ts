import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryModel,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { applyXiaomiConfig, applyXiaomiProviderConfig } from "./onboard.js";
import { buildXiaomiProvider } from "./provider-catalog.js";

describe("xiaomi onboard", () => {
  it("adds Xiaomi provider with correct settings", () => {
    const cfg = applyXiaomiConfig({});
    const provider = cfg.models?.providers?.xiaomi;
    expect(provider).toEqual(buildXiaomiProvider());
    expect(provider?.models.map((m) => m.id)).toEqual([
      "mimo-v2-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
    ]);
    expect(cfg.agents?.defaults?.models?.["xiaomi/mimo-v2-flash"]).toEqual({ alias: "Xiaomi" });
    expect(cfg.agents?.defaults?.model).toEqual({ primary: "xiaomi/mimo-v2-flash" });
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
