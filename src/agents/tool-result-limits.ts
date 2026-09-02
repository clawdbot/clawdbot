/** Automatic live tool-result caps derived from the effective model context. */
import { estimateToolResultTextChars } from "./embedded-agent-runner/tool-result-text-budget.js";

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

/** Fresh producer text must fit persistence/dispatch and the raw-weight context guard. */
export type ToolResultBudget = { maxChars: number; maxContextChars: number };

export function resolveToolResultContextMaxChars(contextWindowTokens: number): number {
  return Math.max(1_024, Math.floor(Math.max(1, Math.floor(contextWindowTokens)) * 2 * 0.5));
}

export function resolveToolResultBudget(
  contextWindowTokens?: number,
): ToolResultBudget | undefined {
  if (
    contextWindowTokens === undefined ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return undefined;
  }
  return {
    maxChars: resolveLiveToolResultMaxChars({ contextWindowTokens }),
    maxContextChars: resolveToolResultContextMaxChars(contextWindowTokens),
  };
}

export function toolResultFitsBudget(text: string, budget?: ToolResultBudget): boolean {
  return (
    budget === undefined ||
    (estimateToolResultTextChars(text) <= budget.maxChars &&
      estimateToolResultTextChars(text, { minimumRawWeight: 2 }) <= budget.maxContextChars)
  );
}
