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
  return usesOpenAIPromptCacheKey ? `${params.sessionId}:${params.boundaryCount}` : undefined;
}
