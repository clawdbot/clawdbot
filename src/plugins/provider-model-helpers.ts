// Normalizes provider model metadata from plugin manifests and hooks.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { normalizeModelCompat } from "./provider-model-compat.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderResolveDynamicModelContext } from "./types.js";

type FamilyForwardCompatTemplateSource = {
  providerId?: string;
  templateIds: readonly string[];
};
type FamilyForwardCompatContext = {
  modelId: string;
  normalizedModelId: string;
  providerId: string;
  template?: ProviderRuntimeModel;
};

type FamilyForwardCompatCase = {
  match: readonly string[] | ((normalizedModelId: string) => boolean);
  patch?:
    | Partial<ProviderRuntimeModel>
    | ((context: FamilyForwardCompatContext) => Partial<ProviderRuntimeModel> | undefined);
  templateIds?: readonly string[];
  templateSources?: readonly FamilyForwardCompatTemplateSource[];
};

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
  return resolveFamilyForwardCompatModel({
    providerId: params.providerId,
    modelId: params.modelId,
    ctx: params.ctx,
    cases: [{ match: () => true, templateIds: params.templateIds }],
    patch: params.patch,
  });
}

export function resolveFamilyForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
  cases: readonly FamilyForwardCompatCase[];
  modelId?: string;
  normalizedModelId?: string;
  patch?: Partial<ProviderRuntimeModel>;
  preserveExisting?: boolean;
  synthesize?: boolean;
}): ProviderRuntimeModel | undefined {
  const modelId = (params.modelId ?? params.ctx.modelId).trim();
  const normalizedModelId = params.normalizedModelId ?? normalizeLowercaseStringOrEmpty(modelId);
  const family = params.cases.find((candidate) =>
    typeof candidate.match === "function"
      ? candidate.match(normalizedModelId)
      : candidate.match.includes(normalizedModelId),
  );
  if (!family) {
    return undefined;
  }
  const existing = params.preserveExisting
    ? (params.ctx.modelRegistry.find(params.providerId, modelId) as ProviderRuntimeModel | null)
    : null;
  if (existing) {
    return existing;
  }

  const context: FamilyForwardCompatContext = {
    modelId,
    normalizedModelId,
    providerId: params.providerId,
  };
  const resolvePatch = (template?: ProviderRuntimeModel) => {
    const patchContext = { ...context, template };
    const familyPatch =
      typeof family.patch === "function" ? family.patch(patchContext) : family.patch;
    return { ...params.patch, ...familyPatch };
  };
  const templateSources = family.templateSources ?? [{ templateIds: family.templateIds ?? [] }];

  for (const source of templateSources) {
    for (const templateId of uniqueStrings(source.templateIds).filter(Boolean)) {
      const template = params.ctx.modelRegistry.find(
        source.providerId ?? params.providerId,
        templateId,
      ) as ProviderRuntimeModel | null;
      if (template) {
        return normalizeModelCompat({
          ...template,
          id: modelId,
          name: modelId,
          ...resolvePatch(template),
        } as ProviderRuntimeModel);
      }
    }
  }

  if (!params.synthesize) {
    return undefined;
  }
  const patch = resolvePatch();
  return normalizeModelCompat({
    id: modelId,
    name: modelId,
    ...patch,
    cost: patch?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: patch?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    maxTokens: patch?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
  } as ProviderRuntimeModel);
}
