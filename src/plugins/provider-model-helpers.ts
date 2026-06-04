// Normalizes provider model metadata from plugin manifests and hooks.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeModelCompat } from "./provider-model-compat.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderResolveDynamicModelContext } from "./types.js";

/** True when an id matches a normalized exact value or value prefix. */
export function matchesExactOrPrefix(id: string, values: readonly string[]): boolean {
  const normalizedId = normalizeLowercaseStringOrEmpty(id);
  return values.some((value) => {
    const normalizedValue = normalizeLowercaseStringOrEmpty(value);
    return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
  });
}

/** Clones the first available template model and patches it for a dynamic model id. */
export function cloneFirstTemplateModel(params: {
  providerId: string;
  modelId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
  patch?: Partial<ProviderRuntimeModel>;
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.modelId.trim();
  for (const templateId of uniqueStrings(params.templateIds).filter(Boolean)) {
    const template = params.ctx.modelRegistry.find(
      params.providerId,
      templateId,
    ) as ProviderRuntimeModel | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
      ...params.patch,
    } as ProviderRuntimeModel);
  }
  return undefined;
}
