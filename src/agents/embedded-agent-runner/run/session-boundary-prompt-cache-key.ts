import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "@openclaw/ai/providers";
import { truncateCodePoints } from "@openclaw/normalization-core/code-points";

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
  // Reserve the lifecycle suffix inside OpenAI's 64-code-point limit for proxy runtimes.
  const suffix = `:${params.boundaryCount}`;
  const maxSessionIdLength = OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - suffix.length;
  return `${truncateCodePoints(params.sessionId, maxSessionIdLength)}${suffix}`;
}
