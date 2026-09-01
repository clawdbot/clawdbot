import type { CacheRetention, Model } from "../types.js";
import { isOpenAIGpt56Model } from "./openai-reasoning-effort.js";

export type OpenAIResponsesPromptCachePlan = {
  options: { mode: "explicit" };
  useBreakpoint: boolean;
};

const EXPLICIT_PROMPT_CACHE_APIS = new Set([
  "openai-responses",
  "openclaw-openai-responses-transport",
]);

function isNativeOpenAIResponsesEndpoint(model: Model): boolean {
  if (model.provider !== "openai") {
    return false;
  }
  try {
    return new URL(model.baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

/** Resolve GPT-5.6 explicit caching for native OpenAI or a verified compatible endpoint. */
export function resolveOpenAIResponsesPromptCachePlan(
  model: Model,
  cacheRetention: CacheRetention,
): OpenAIResponsesPromptCachePlan | undefined {
  if (!EXPLICIT_PROMPT_CACHE_APIS.has(model.api)) {
    return undefined;
  }
  // SAFETY: the API discriminator above narrows this runtime branch to Responses compat.
  const configured = (model.compat as { supportsExplicitPromptCaching?: boolean } | undefined)
    ?.supportsExplicitPromptCaching;
  // Provider-owned capability is authoritative because compatible model IDs need not use
  // OpenAI's native naming scheme.
  if (!(configured ?? (isNativeOpenAIResponsesEndpoint(model) && isOpenAIGpt56Model(model)))) {
    return undefined;
  }
  return {
    options: { mode: "explicit" },
    useBreakpoint: cacheRetention !== "none",
  };
}
