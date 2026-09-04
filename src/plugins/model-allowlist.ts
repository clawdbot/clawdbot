import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  normalizeBuiltInProviderModelId,
  stripSelfProviderModelPrefix,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";

export type CompiledModelAllowlist = {
  configured: boolean;
  allowAny: boolean;
  models: Set<string>;
};

export function compileModelAllowlist(params: {
  configured: boolean;
  values?: readonly string[];
  // Match the caller's resolved-target representation, including provider-qualified model IDs.
  formatKey: (provider: string, model: string) => string;
}): CompiledModelAllowlist {
  const models = new Set<string>();
  let allowAny = false;
  for (const raw of params.values ?? []) {
    const trimmed = raw.trim();
    if (trimmed === "*") {
      allowAny = true;
      continue;
    }
    const parsed = parseModelCatalogRef(trimmed);
    if (!parsed) {
      continue;
    }
    // Operator allowlists already name canonical targets; keep policy setup independent
    // of plugin metadata and provider-runtime discovery.
    const modelId = normalizeBuiltInProviderModelId(
      parsed.provider,
      stripSelfProviderModelPrefix(parsed.provider, parsed.modelId),
    );
    models.add(params.formatKey(parsed.provider, modelId));
  }
  return { configured: params.configured, allowAny, models };
}
