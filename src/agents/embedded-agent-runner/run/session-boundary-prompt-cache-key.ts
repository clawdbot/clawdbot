import { clampOpenAIPromptCacheKey } from "@openclaw/ai/providers";

export function resolveSessionBoundaryPromptCacheKey(params: {
  api: string;
  boundaryCount: number;
  promptCacheKey?: string;
  sessionId: string;
}): string | undefined {
  const explicit = params.promptCacheKey?.trim();
  if (explicit) {
    return explicit;
  }
  const usesOpenAIPromptCacheKey =
    params.api === "openai-completions" ||
    params.api === "openai-responses" ||
    params.api.includes("openai");
  if (!usesOpenAIPromptCacheKey) {
    return undefined;
  }
  // Clamp at derivation, not only in provider param builders: proxy runtimes
  // serialize this key verbatim, and long internal-effects session ids
  // (companion/btw) otherwise exceed OpenAI's 64-char prompt_cache_key limit.
  return clampOpenAIPromptCacheKey(`${params.sessionId}:${params.boundaryCount}`);
}
