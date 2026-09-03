import { codePointCountExceeds, sliceCodePoints } from "@openclaw/normalization-core/code-points";
/** Maximum prompt cache key length accepted by OpenAI-compatible request metadata. */
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** Truncates a prompt cache key by Unicode code point count. */
export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  return codePointCountExceeds(key, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH)
    ? sliceCodePoints(key, 0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH)
    : key;
}
