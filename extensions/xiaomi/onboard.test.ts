// Xiaomi tests cover onboard plugin behavior.
import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryModel,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import {
  applyXiaomiConfig,
  applyXiaomiProviderConfig,
  applyXiaomiTokenPlanConfig,
} from "./onboard.js";
import { buildXiaomiProvider, buildXiaomiTokenPlanProvider } from "./provider-catalog.js";

describe("xiaomi onboard", () => {
  it("adds Xiaomi provider with correct settings", () => {
    const cfg = applyXiaomiConfig({});
    const provider = cfg.models?.providers?.xiaomi;
    expect(provider).toEqual(buildXiaomiProvider());
    expect(provider?.models.map((m) => m.id)).toEqual(["mimo-v2.5", "mimo-v2.5-pro"]);
    expect(cfg.agents?.defaults?.models?.["xiaomi/mimo-v2.5"]).toEqual({ alias: "Xiaomi" });
    expect(cfg.agents?.defaults?.model).toEqual({ primary: "xiaomi/mimo-v2.5" });
    expectProviderOnboardPrimaryModel({
      applyConfig: applyXiaomiConfig,
      modelRef: "xiaomi/mimo-v2.5",
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
      "mimo-v2.5",
      "mimo-v2.5-pro",
    ]);
  });

  it("adds Xiaomi Token Plan provider with a regional endpoint preset", () => {
    const cfg = applyXiaomiTokenPlanConfig({}, "ams");
    const provider = cfg.models?.providers?.["xiaomi-token-plan"];
    expect(provider).toEqual({
      ...buildXiaomiTokenPlanProvider(),
      baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
    });
    expect(provider?.models.map((m) => m.id)).toEqual(["mimo-v2.5-pro", "mimo-v2.5"]);
    expect(cfg.agents?.defaults?.models?.["xiaomi-token-plan/mimo-v2.5-pro"]).toEqual({
      alias: "Xiaomi MiMo V2.5 Pro",
    });
    expect(cfg.agents?.defaults?.model).toEqual({ primary: "xiaomi-token-plan/mimo-v2.5-pro" });
    expectProviderOnboardPrimaryModel({
      applyConfig: (config) => applyXiaomiTokenPlanConfig(config, "ams"),
      modelRef: "xiaomi-token-plan/mimo-v2.5-pro",
    });
  });

  it("merges Xiaomi Token Plan models and rewrites the selected regional base URL", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: (config) => applyXiaomiTokenPlanConfig(config, "sgp"),
      providerId: "xiaomi-token-plan",
      providerApi: "openai-completions",
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      legacyApi: "openai-completions",
      legacyModelId: "custom-token-plan-model",
      legacyModelName: "Custom Token Plan",
    });
    expect(provider?.models.map((m) => m.id)).toEqual([
      "custom-token-plan-model",
      "mimo-v2.5-pro",
      "mimo-v2.5",
    ]);
  });
});
