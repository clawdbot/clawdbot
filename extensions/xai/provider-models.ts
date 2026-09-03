// Xai provider module implements model/runtime integration.
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeModelCompat,
  type ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveXaiCatalogEntry,
  XAI_BASE_URL,
  XAI_DEFAULT_CONTEXT_WINDOW,
  XAI_DEFAULT_MAX_TOKENS,
  XAI_UNKNOWN_MODEL_COST,
} from "./model-definitions.js";
import { normalizeXaiModelId } from "./model-id.js";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";

const XAI_MODERN_MODEL_PREFIXES = [
  "grok-4.6",
  "grok-4.5",
  "grok-build-0.1",
  "grok-4.3",
  "grok-4.20",
] as const;

export function isModernXaiModel(modelId: string): boolean {
  const normalized = normalizeXaiModelId(modelId.trim());
  const lower = normalizeOptionalLowercaseString(normalized) ?? "";
  if (!lower || lower.includes("multi-agent")) {
    return false;
  }
  return XAI_MODERN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Grok ids newer than the manifest run with default limits and unknown pricing. */
function resolveXaiForwardCompatDefinition(modelId: string) {
  const curated = resolveXaiCatalogEntry(modelId);
  if (curated) {
    return curated;
  }
  const id = modelId.trim();
  const lower = normalizeOptionalLowercaseString(id) ?? "";
  if (!lower.startsWith("grok-") || lower.includes("multi-agent")) {
    return undefined;
  }
  return {
    id,
    name: id,
    reasoning: !lower.includes("non-reasoning"),
    input: ["text", "image"],
    cost: XAI_UNKNOWN_MODEL_COST,
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
  } satisfies ModelDefinitionConfig;
}

export function resolveXaiForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}) {
  const definition = resolveXaiForwardCompatDefinition(params.ctx.modelId);
  if (!definition) {
    return undefined;
  }

  return applyXaiRuntimeModelCompat(
    normalizeModelCompat({
      id: definition.id,
      name: definition.name,
      api: params.ctx.providerConfig?.api ?? "openai-responses",
      provider: params.providerId,
      baseUrl: normalizeOptionalString(params.ctx.providerConfig?.baseUrl) ?? XAI_BASE_URL,
      reasoning: definition.reasoning,
      input: definition.input,
      cost: definition.cost,
      contextWindow: definition.contextWindow,
      maxTokens: definition.maxTokens,
    } as ProviderRuntimeModel),
  );
}

export function normalizeXaiResolvedModel(model: ProviderRuntimeModel): ProviderRuntimeModel {
  return applyXaiRuntimeModelCompat(model);
}
