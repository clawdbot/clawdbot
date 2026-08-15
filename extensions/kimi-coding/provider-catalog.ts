// Kimi Coding provider module implements model/runtime integration.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const KIMI_PROVIDER_ID = "kimi";
const KIMI_CODING_CATALOG = manifest.modelCatalog.providers.kimi;
const KIMI_LEGACY_MODEL_IDS = ["kimi-code", "k2p5"] as const;

export const KIMI_CODING_BASE_URL = KIMI_CODING_CATALOG.baseUrl;
export const KIMI_CODING_DEFAULT_MODEL_ID = KIMI_CODING_CATALOG.defaultModel;
export const KIMI_CODING_LEGACY_MODEL_IDS = KIMI_LEGACY_MODEL_IDS;

export function buildKimiCodingProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: KIMI_PROVIDER_ID,
    catalog: KIMI_CODING_CATALOG,
  });
}

export function normalizeKimiCodingModelId(modelId: string): string {
  // Legacy k3[1m] was retired upstream and normalizes to k3 for shipped configurations.
  if (modelId === "k3[1m]") {
    return "k3";
  }
  return KIMI_LEGACY_MODEL_IDS.includes(modelId as (typeof KIMI_LEGACY_MODEL_IDS)[number])
    ? KIMI_CODING_DEFAULT_MODEL_ID
    : modelId;
}
