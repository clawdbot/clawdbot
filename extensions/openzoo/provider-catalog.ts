// Openzoo provider module implements model/runtime integration.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  discoverOpenzooModels,
  OPENZOO_DEFAULT_BASE_URL,
  OPENZOO_PROVIDER_ID,
} from "./provider-models.js";

export function buildOpenzooProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: OPENZOO_PROVIDER_ID,
    catalog: manifest.modelCatalog.providers.openzoo,
  });
}

export async function buildOpenzooProviderWithDiscovery(params?: {
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  const baseUrl = params?.baseUrl ?? OPENZOO_DEFAULT_BASE_URL;
  const models = await discoverOpenzooModels({
    baseUrl,
    ...(params?.signal ? { signal: params.signal } : {}),
  });
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}
