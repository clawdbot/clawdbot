// Normalizes provider model compatibility metadata from plugins.
import { resolveUnsupportedToolSchemaKeywords } from "@openclaw/ai/internal/openai";
import { resolveOpenAICompletionsCompat } from "@openclaw/ai/transports";
import { resolveProviderRequestCapabilities } from "../agents/provider-attribution.js";
import { getModelProviderRequestRouteFacts } from "../agents/provider-request-config.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import type { Model } from "../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "./plugin-metadata-snapshot.types.js";

export function extractModelCompat(
  modelOrCompat: { compat?: unknown } | ModelCompatConfig | undefined,
): ModelCompatConfig | undefined {
  if (!modelOrCompat || typeof modelOrCompat !== "object") {
    return undefined;
  }
  if ("compat" in modelOrCompat) {
    const compat = (modelOrCompat as { compat?: unknown }).compat;
    return compat && typeof compat === "object" ? (compat as ModelCompatConfig) : undefined;
  }
  return modelOrCompat as ModelCompatConfig;
}

/** @deprecated Provider-owned model compat helper; do not use from third-party plugins. */
export function applyModelCompatPatch<T extends { compat?: ModelCompatConfig }>(
  model: T,
  patch: Partial<ModelCompatConfig> & Record<string, unknown>,
): T {
  const nextCompat = { ...model.compat, ...patch } as ModelCompatConfig;
  const currentCompat = model.compat as (Record<string, unknown> & ModelCompatConfig) | undefined;
  if (
    model.compat &&
    Object.entries(patch).every(([key, value]) => currentCompat?.[key] === value)
  ) {
    return model;
  }
  return {
    ...model,
    compat: nextCompat,
  };
}

export function hasToolSchemaProfile(
  modelOrCompat: { compat?: unknown } | ModelCompatConfig | undefined,
  profile: string,
): boolean {
  return extractModelCompat(modelOrCompat)?.toolSchemaProfile === profile;
}

export function resolveToolCallArgumentsEncoding(
  modelOrCompat: { compat?: unknown } | ModelCompatConfig | undefined,
): ModelCompatConfig["toolCallArgumentsEncoding"] | undefined {
  return extractModelCompat(modelOrCompat)?.toolCallArgumentsEncoding;
}

// Tool-schema compat predicates moved into @openclaw/ai (agent-tools-parameter-schema);
// re-export so existing core/plugin callers keep one canonical import site.
export { resolveUnsupportedToolSchemaKeywords };

function isOpenAiCompletionsModel(model: Model): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

function isAnthropicMessagesModel(model: Model): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

export function normalizeModelCompat(
  model: Model,
  providerMetadataOwners?: PluginMetadataSnapshotOwnerMaps,
): Model {
  const baseUrl = model.baseUrl ?? "";

  if (isAnthropicMessagesModel(model) && baseUrl) {
    const normalized = normalizeAnthropicBaseUrl(baseUrl);
    if (normalized !== baseUrl) {
      return { ...model, baseUrl: normalized } as Model<"anthropic-messages">;
    }
  }

  if (!isOpenAiCompletionsModel(model)) {
    return model;
  }

  const compat = model.compat ?? undefined;
  if (!baseUrl) {
    return model;
  }
  const resolvedProviderMetadataOwners =
    providerMetadataOwners ?? getModelProviderRequestRouteFacts(model)?.providerMetadataOwners;
  // Metadata supplies its capability resolver explicitly; only execution facades
  // install the transport host, which would pull runtime into plugin discovery.
  const resolved = resolveOpenAICompletionsCompat(model, (input) =>
    resolveProviderRequestCapabilities({
      ...input,
      ...(resolvedProviderMetadataOwners
        ? { providerMetadataOwners: resolvedProviderMetadataOwners }
        : {}),
    }),
  );
  if (
    resolved.supportsDeveloperRole &&
    resolved.supportsUsageInStreaming &&
    resolved.supportsStrictMode
  ) {
    return model;
  }
  const patch = {
    ...(compat?.supportsDeveloperRole === undefined
      ? { supportsDeveloperRole: resolved.supportsDeveloperRole }
      : {}),
    ...(compat?.supportsUsageInStreaming === undefined
      ? { supportsUsageInStreaming: resolved.supportsUsageInStreaming }
      : {}),
    ...(compat?.supportsStrictMode === undefined
      ? { supportsStrictMode: resolved.supportsStrictMode }
      : {}),
  };
  if (Object.keys(patch).length === 0) {
    return model;
  }

  return {
    ...model,
    compat: { ...compat, ...patch },
  } as typeof model;
}
