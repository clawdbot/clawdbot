/**
 * Resolves model catalog scope from config and discovery options.
 */
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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
  // Scope ordering feeds deterministic discovery and prompt/cache inputs.
  return {
    providerRefs: normalizeUniqueSingleOrTrimmedStringList([provider, providerConfig?.api]),
    modelRefs: normalizeUniqueSingleOrTrimmedStringList(modelRefs),
  };
}
