import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findNormalizedProviderValue, normalizeProviderId } from "./provider-id.js";

function dedupeCatalogScopeRefs(values: Array<string | undefined>): string[] {
  const refs = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      refs.add(trimmed);
    }
  }
  return [...refs];
}

function providerFromModelRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
  return provider || undefined;
}

export function resolveModelCatalogScope(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): { providerRefs: string[]; modelRefs: string[] } {
  const provider = params.provider.trim();
  const model = params.model.trim();
  const providerConfig = findNormalizedProviderValue(params.cfg?.models?.providers, provider);
  return {
    providerRefs: dedupeCatalogScopeRefs([provider, providerConfig?.api]),
    modelRefs: dedupeCatalogScopeRefs([provider && model ? `${provider}/${model}` : model, model]),
  };
}

export function resolveProviderDiscoveryProviderIdsForCatalogScope(params: {
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
}): string[] | undefined {
  const providerIds = dedupeCatalogScopeRefs([
    ...(params.providerRefs ?? []),
    ...(params.modelRefs ?? []).map(providerFromModelRef),
  ]);
  return providerIds.length > 0 ? providerIds : undefined;
}
