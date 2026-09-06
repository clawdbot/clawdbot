import type { CacheRetention, Model } from "../types.js";

/** Selects the documented cache lifetime fields for a Responses request. */
export function resolveOpenAIResponsesCacheParams(
  model: Pick<Model, "id" | "api" | "baseUrl">,
  cacheRetention: CacheRetention,
  supportsLongCacheRetention: boolean,
): { prompt_cache_retention?: "24h"; prompt_cache_options?: { ttl: "30m" } } {
  if (cacheRetention === "none") {
    return {};
  }
  if (model.id === "gpt-6-astra" && model.api === "openai-responses") {
    const endpoint = URL.parse(model.baseUrl ?? "https://api.openai.com/v1");
    if (
      endpoint?.protocol === "https:" &&
      (endpoint.hostname === "api.openai.com" || endpoint.hostname.endsWith(".api.openai.com"))
    ) {
      // Astra replaces legacy retention with a single supported 30-minute TTL.
      // https://developers.openai.com/api/docs/guides/latest-model
      return { prompt_cache_options: { ttl: "30m" } };
    }
  }
  return cacheRetention === "long" && supportsLongCacheRetention
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
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) {
    return key;
  }
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
