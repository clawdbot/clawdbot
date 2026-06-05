/**
 * Resolves model catalog scope from config and discovery options.
 */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Scope refs feed provider discovery and model catalog lookups. Keep the
// ordering deterministic so prompt/cache inputs do not drift across runs.
function dedupeCatalogScopeRefs(values: Array<string | undefined>): string[] {
  return normalizeUniqueSingleOrTrimmedStringList(values);
}

// Accept provider/model refs in addition to separate provider fields so aliases
// and user-entered model refs discover the owning provider catalog.
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

function providerConfigDeclaresModel(
  providerConfig: { models?: readonly { id?: string }[] } | undefined,
  model: string,
): boolean {
  const trimmedModel = model.trim();
  return Boolean(
    trimmedModel &&
    providerConfig?.models?.some((candidate) => candidate.id?.trim() === trimmedModel),
  );
}

/** Resolves provider/model refs used to scope model catalog discovery. */
export function resolveModelCatalogScope(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): { providerRefs: string[]; modelRefs: string[] } {
  const provider = params.provider.trim();
  const model = params.model.trim();
  const providerConfig = findNormalizedProviderValue(params.cfg?.models?.providers, provider);
  const modelRefs = providerConfigDeclaresModel(providerConfig, model)
    ? [provider && model ? `${provider}/${model}` : model]
    : [provider && model ? `${provider}/${model}` : model, model];
  return {
    providerRefs: dedupeCatalogScopeRefs([provider, providerConfig?.api]),
    modelRefs: dedupeCatalogScopeRefs(modelRefs),
  };
}

/** Extracts provider ids from resolved catalog scope refs for discovery calls. */
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
