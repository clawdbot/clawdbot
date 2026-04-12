import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeModelCompat } from "./provider-model-compat.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderResolveDynamicModelContext } from "./types.js";

export function matchesExactOrPrefix(id: string, values: readonly string[]): boolean {
  const normalizedId = normalizeLowercaseStringOrEmpty(id);
  return values.some((value) => {
    const normalizedValue = normalizeLowercaseStringOrEmpty(value);
    return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
  });
}

export function cloneFirstTemplateModel(params: {
  providerId: string;
  modelId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
  patch?: Partial<ProviderRuntimeModel>;
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.modelId.trim();
  for (const templateId of [...new Set(params.templateIds)].filter(Boolean)) {
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
