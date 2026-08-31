/** Lazy built-in protocol adapter registration. */
export {
  BUILT_IN_API_PROVIDER_SOURCE_ID,
  registerBuiltInApiProviders,
  resetApiProviders,
} from "./providers/register-builtins.js";
export {
  clampOpenAIPromptCacheKey,
  OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
} from "./providers/openai-prompt-cache.js";
