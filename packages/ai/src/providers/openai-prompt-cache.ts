import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import { isNativeOpenAIEndpoint } from "../transports/openai-completions-compat.js";
import type { CacheRetention, Model, OpenAICompletionsCompat } from "../types.js";

const EXTENDED_RETENTION_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-chat-latest",
  "gpt-5",
  "gpt-5-codex",
  "gpt-4.1",
]);

/** Selects documented lifetime fields shared by Responses and Chat Completions. */
export function resolveOpenAIPromptCacheParams(
  model: Pick<Model, "id" | "provider" | "baseUrl">,
  cacheRetention: CacheRetention,
  compat: Required<
    Pick<OpenAICompletionsCompat, "supportsPromptCacheKey" | "supportsLongCacheRetention">
  >,
): { prompt_cache_retention?: "24h"; prompt_cache_options?: { ttl: "30m" } } {
  if (
    cacheRetention !== "long" ||
    !compat.supportsPromptCacheKey ||
    !compat.supportsLongCacheRetention
  ) {
    return {};
  }
  // GPT-5.6 and later replace legacy retention on both APIs.
  // https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model.id);
  if (
    version &&
    (Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2]) >= 6))
  ) {
    return { prompt_cache_options: { ttl: "30m" } };
  }
  const modelId = model.id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return !isNativeOpenAIEndpoint(model) || EXTENDED_RETENTION_MODELS.has(modelId)
    ? { prompt_cache_retention: "24h" }
    : {};
}

/** Maximum prompt cache key length accepted by OpenAI-compatible request metadata. */
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** Truncates a prompt cache key by Unicode code point count. */
export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  return truncateCodePoints(key, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
}
