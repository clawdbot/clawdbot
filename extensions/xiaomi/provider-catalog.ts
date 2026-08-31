// Xiaomi provider module implements model/runtime integration.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const XIAOMI_PROVIDER_ID = "xiaomi";
export const XIAOMI_TOKEN_PLAN_PROVIDER_ID = "xiaomi-token-plan";
export const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2.5";
export const XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_ID = "mimo-v2.5-pro";

const XIAOMI_TOKEN_PLAN_BASE_URLS = {
  ams: "https://token-plan-ams.xiaomimimo.com/v1",
  cn: "https://token-plan-cn.xiaomimimo.com/v1",
  sgp: "https://token-plan-sgp.xiaomimimo.com/v1",
} as const;

export type XiaomiTokenPlanRegion = keyof typeof XIAOMI_TOKEN_PLAN_BASE_URLS;

export function buildXiaomiProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: XIAOMI_PROVIDER_ID,
    catalog: manifest.modelCatalog.providers.xiaomi,
  });
}

export function buildXiaomiTokenPlanProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: XIAOMI_TOKEN_PLAN_PROVIDER_ID,
    catalog: manifest.modelCatalog.providers[XIAOMI_TOKEN_PLAN_PROVIDER_ID],
  });
}

export function resolveXiaomiTokenPlanBaseUrl(region: XiaomiTokenPlanRegion): string {
  return XIAOMI_TOKEN_PLAN_BASE_URLS[region];
}
