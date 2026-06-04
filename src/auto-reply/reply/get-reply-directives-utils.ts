// Utility helpers for applying parsed directives to get-reply execution state.
import type { InlineDirectives } from "./directive-handling.js";

const CLEARED_EXEC_FIELDS = {
  hasExecDirective: false,
  execHost: undefined,
  execSecurity: undefined,
  execAsk: undefined,
  execNode: undefined,
  rawExecHost: undefined,
  rawExecSecurity: undefined,
  rawExecAsk: undefined,
  rawExecNode: undefined,
  hasExecOptions: false,
  invalidExecHost: false,
  invalidExecSecurity: false,
  invalidExecAsk: false,
  invalidExecNode: false,
} satisfies Partial<InlineDirectives>;

/** Clears all inline directive state while preserving cleaned text. */
export function clearInlineDirectives(cleaned: string): InlineDirectives {
  return {
    cleaned,
    hasThinkDirective: false,
    thinkLevel: undefined,
    rawThinkLevel: undefined,
    clearThinkLevel: false,
    hasVerboseDirective: false,
    verboseLevel: undefined,
    rawVerboseLevel: undefined,
    hasTraceDirective: false,
    traceLevel: undefined,
    rawTraceLevel: undefined,
    hasFastDirective: false,
    fastMode: undefined,
    rawFastMode: undefined,
    clearFastMode: false,
    hasReasoningDirective: false,
    reasoningLevel: undefined,
    rawReasoningLevel: undefined,
    hasElevatedDirective: false,
    elevatedLevel: undefined,
    rawElevatedLevel: undefined,
    ...CLEARED_EXEC_FIELDS,
    hasStatusDirective: false,
    hasModelDirective: false,
    rawModelDirective: undefined,
    hasQueueDirective: false,
    queueMode: undefined,
    queueReset: false,
    rawQueueMode: undefined,
    debounceMs: undefined,
    cap: undefined,
    dropPolicy: undefined,
    rawDebounce: undefined,
    rawCap: undefined,
    rawDrop: undefined,
    hasQueueOptions: false,
  };
}

/** Clears only exec-related directive state after execution policy is consumed. */
export function clearExecInlineDirectives(directives: InlineDirectives): InlineDirectives {
  return {
    ...directives,
    ...CLEARED_EXEC_FIELDS,
  };
}
