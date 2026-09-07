/**
 * Resolves provider/model prompt-cache retention behavior.
 */
import { resolveOpenAIPromptCacheKeySupport } from "@openclaw/ai/transports";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAnthropicCacheRetentionFamily } from "../../llm/providers/stream-wrappers/anthropic-family-cache-semantics.js";
import type { OpenAICompletionsCompat } from "../../llm/types.js";

type CacheRetention = "none" | "short" | "long";

export function parseCacheRetention(value: unknown): CacheRetention | undefined {
  return value === "none" || value === "short" || value === "long" ? value : undefined;
}

export function isGooglePromptCacheEligible(params: {
  modelApi?: string;
  modelId?: string;
}): boolean {
  if (params.modelApi !== "google-generative-ai") {
    return false;
  }
  const normalizedModelId = normalizeLowercaseStringOrEmpty(params.modelId);
  return normalizedModelId.startsWith("gemini-2.5") || normalizedModelId.startsWith("gemini-3");
}

export function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelApi?: string,
  modelId?: string,
  compat?: Pick<OpenAICompletionsCompat, "supportsPromptCacheKey" | "cacheControlFormat">,
  baseUrl?: string,
): CacheRetention | undefined {
  const hasExplicitCacheConfig =
    extraParams?.cacheRetention !== undefined || extraParams?.cacheControlTtl !== undefined;
  const family = resolveAnthropicCacheRetentionFamily({
    provider,
    modelApi,
    modelId,
    hasExplicitCacheConfig,
  });
  const openAIEligible =
    (modelApi === "openai-responses" ||
      modelApi === "openai-chatgpt-responses" ||
      modelApi === "openai-completions") &&
    resolveOpenAIPromptCacheKeySupport({ provider, api: modelApi, baseUrl, compat });
  const googleEligible = isGooglePromptCacheEligible({ modelApi, modelId });
  // Marker-based caches accept retention without accepting OpenAI cache-key fields.
  // Keep these capabilities independent so explicit "none" can suppress markers.
  const compatEligible =
    compat?.supportsPromptCacheKey === true || compat?.cacheControlFormat === "anthropic";

  // Bedrock's provider owner decides model eligibility and checkpoint TTLs.
  const bedrockEligible = modelApi === "bedrock-converse-stream";
  if (!family && !googleEligible && !openAIEligible && !compatEligible && !bedrockEligible) {
    return undefined;
  }

  const newVal = parseCacheRetention(extraParams?.cacheRetention);
  if (newVal) {
    return newVal;
  }

  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m" && (family || googleEligible)) {
    return "short";
  }
  if (legacy === "1h" && (family || googleEligible)) {
    return "long";
  }

  return family === "anthropic-direct" ? "short" : undefined;
}
