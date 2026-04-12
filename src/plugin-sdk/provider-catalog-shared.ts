// Shared provider catalog helpers for provider plugins.
//
// Keep provider-owned exports out of this subpath so plugin loaders can import it
// without recursing through provider-specific facades.

import { findNormalizedProviderKey } from "../agents/provider-id.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderRequestCapabilities } from "./provider-http.js";
import type { ModelProviderConfig } from "./provider-model-shared.js";

export type { ProviderCatalogContext, ProviderCatalogResult } from "../plugins/types.js";

export {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "../plugins/provider-catalog.js";

export type ConfiguredProviderCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "document">;
};

function normalizeConfiguredCatalogModelInput(
  input: unknown,
): ConfiguredProviderCatalogEntry["input"] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.filter(
    (item): item is "text" | "image" | "document" =>
      item === "text" || item === "image" || item === "document",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function resolveConfiguredProviderModels(
  config: OpenClawConfig | undefined,
  providerId: string,
): ModelDefinitionConfig[] {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  const providerKey = findNormalizedProviderKey(providers, providerId);
  if (!providerKey) {
    return [];
  }
  const providerConfig = providers[providerKey];
  if (!providerConfig || typeof providerConfig !== "object") {
    return [];
  }
  return Array.isArray(providerConfig.models) ? providerConfig.models : [];
}

export function readConfiguredProviderCatalogEntries(params: {
  config?: OpenClawConfig;
  providerId: string;
  publishedProviderId?: string;
}): ConfiguredProviderCatalogEntry[] {
  const provider = params.publishedProviderId ?? params.providerId;
  const models = resolveConfiguredProviderModels(params.config, params.providerId);
  const entries: ConfiguredProviderCatalogEntry[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) {
      continue;
    }
    const name = (typeof model.name === "string" ? model.name : id).trim() || id;
    const contextWindow =
      typeof model.contextWindow === "number" && model.contextWindow > 0
        ? model.contextWindow
        : undefined;
    const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : undefined;
    const input = normalizeConfiguredCatalogModelInput(model.input);
    entries.push({
      provider,
      id,
      name,
      ...(contextWindow ? { contextWindow } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(input ? { input } : {}),
    });
  }
  return entries;
}

function withStreamingUsageCompat(provider: ModelProviderConfig): ModelProviderConfig {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return provider;
  }

  let changed = false;
  const models = provider.models.map((model) => {
    if (model.compat?.supportsUsageInStreaming !== undefined) {
      return model;
    }
    changed = true;
    return {
      ...model,
      compat: {
        ...model.compat,
        supportsUsageInStreaming: true,
      },
    };
  });

  return changed ? { ...provider, models } : provider;
}

export function supportsNativeStreamingUsageCompat(params: {
  providerId: string;
  baseUrl: string | undefined;
}): boolean {
  return resolveProviderRequestCapabilities({
    provider: params.providerId,
    api: "openai-completions",
    baseUrl: params.baseUrl,
    capability: "llm",
    transport: "stream",
  }).supportsNativeStreamingUsageCompat;
}

export function applyProviderNativeStreamingUsageCompat(params: {
  providerId: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  return supportsNativeStreamingUsageCompat({
    providerId: params.providerId,
    baseUrl: params.providerConfig.baseUrl,
  })
    ? withStreamingUsageCompat(params.providerConfig)
    : params.providerConfig;
}
