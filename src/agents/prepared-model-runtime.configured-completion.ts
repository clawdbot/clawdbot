import type { ConfiguredModelRef } from "@openclaw/model-catalog-core/configured-model-refs";
import {
  buildModelCatalogMergeKey,
  parseModelCatalogRef,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.configured.js";

export function completeConfiguredRuntimeModels(params: {
  configuredModelRefs: readonly ConfiguredModelRef[];
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  resolveDynamicModel: (lookup: {
    provider: string;
    modelId: string;
  }) => ProviderRuntimeModel | undefined;
}): PreparedConfiguredRuntimeModel[] {
  const existing = new Map(
    params.configuredRuntimeModels.map((configured) => [
      buildModelCatalogMergeKey(configured.provider, configured.modelId),
      configured,
    ]),
  );
  const completed: PreparedConfiguredRuntimeModel[] = [];
  const seen = new Set<string>();
  for (const { value } of params.configuredModelRefs) {
    const parsed = parseModelCatalogRef(value);
    if (!parsed) {
      continue;
    }
    const key = buildModelCatalogMergeKey(parsed.provider, parsed.modelId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const prepared = existing.get(key);
    const model = prepared?.model ?? params.resolveDynamicModel(parsed);
    if (model) {
      completed.push({ provider: parsed.provider, modelId: parsed.modelId, model });
    }
  }
  return completed;
}
