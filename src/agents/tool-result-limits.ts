/** Automatic live tool-result caps derived from the effective model context. */

const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

export const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 16_000;
const LARGE_CONTEXT_MAX_LIVE_TOOL_RESULT_CHARS = 32_000;
const XL_CONTEXT_MAX_LIVE_TOOL_RESULT_CHARS = 64_000;
const LARGE_CONTEXT_TOOL_RESULT_TOKENS = 100_000;
const XL_CONTEXT_TOOL_RESULT_TOKENS = 200_000;

export function resolveAutoLiveToolResultMaxChars(contextWindowTokens: number): number {
  if (!Number.isFinite(contextWindowTokens)) {
    return DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
  }
  const tokens = Math.floor(contextWindowTokens);
  if (tokens >= XL_CONTEXT_TOOL_RESULT_TOKENS) {
    return XL_CONTEXT_MAX_LIVE_TOOL_RESULT_CHARS;
  }
  if (tokens >= LARGE_CONTEXT_TOOL_RESULT_TOKENS) {
    return LARGE_CONTEXT_MAX_LIVE_TOOL_RESULT_CHARS;
  }
  return DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
}

export function calculateMaxToolResultCharsWithCap(
  contextWindowTokens: number,
  hardCapChars: number,
): number {
  const maxTokens = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE);
  const maxChars = maxTokens * 4;
  return Math.min(maxChars, Math.max(1, hardCapChars));
}

export function resolveLiveToolResultMaxChars(params: { contextWindowTokens: number }): number {
  return calculateMaxToolResultCharsWithCap(
    params.contextWindowTokens,
    resolveAutoLiveToolResultMaxChars(params.contextWindowTokens),
  );
}
