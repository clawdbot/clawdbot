import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const MANTLE_EXPLICIT_PROMPT_CACHE_MODEL_RE = /^openai\.gpt-5\.6(?:[-.]|$)/u;

/** Return whether a Mantle model uses the GPT-5.6 explicit cache contract. */
export function supportsMantleExplicitPromptCaching(modelId: string): boolean {
  return MANTLE_EXPLICIT_PROMPT_CACHE_MODEL_RE.test(normalizeLowercaseStringOrEmpty(modelId));
}
