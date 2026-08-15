// Moonshot provider module implements model/runtime integration.
import {
  applyProviderNativeStreamingUsageCompat,
  buildManifestModelProviderConfig,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
export const MOONSHOT_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  "moonshot",
)!;
export const MOONSHOT_DEFAULT_MODEL_ID = MOONSHOT_DEFAULT_MODEL_REF.slice("moonshot/".length);

export function isNativeMoonshotBaseUrl(baseUrl: string | undefined): boolean {
  return [MOONSHOT_BASE_URL, MOONSHOT_CN_BASE_URL].some(
    (official) => baseUrl === official || baseUrl === `${official}/`,
  );
}

export function applyMoonshotNativeStreamingUsageCompat(
  provider: ModelProviderConfig,
): ModelProviderConfig {
  return applyProviderNativeStreamingUsageCompat({
    providerId: "moonshot",
    providerConfig: provider,
  });
}

export function buildMoonshotProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "moonshot",
    catalog: manifest.modelCatalog.providers.moonshot,
  });
}
