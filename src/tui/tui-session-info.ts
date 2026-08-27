import type { SessionInfo } from "./tui-types.js";

export type SessionInfoDefaults = {
  model?: string | null;
  modelProvider?: string | null;
  contextTokens?: number | null;
  thinkingLevels?: Array<{ id: string; label: string }>;
};

export type SessionInfoEntry = SessionInfo & {
  key?: string;
  sessionId?: string;
  modelOverride?: string;
  providerOverride?: string;
};

/** Compare only session facts that change visible TUI behavior. */
export function sessionInfoUiEquals(left: SessionInfo, right: SessionInfo): boolean {
  return (
    left.thinkingLevel === right.thinkingLevel &&
    (left.thinkingLevels === right.thinkingLevels ||
      JSON.stringify(left.thinkingLevels ?? null) ===
        JSON.stringify(right.thinkingLevels ?? null)) &&
    left.fastMode === right.fastMode &&
    left.verboseLevel === right.verboseLevel &&
    left.traceLevel === right.traceLevel &&
    left.reasoningLevel === right.reasoningLevel &&
    left.model === right.model &&
    left.modelProvider === right.modelProvider &&
    left.agentRuntime?.id === right.agentRuntime?.id &&
    left.agentRuntime?.source === right.agentRuntime?.source &&
    left.agentRuntime?.fallback === right.agentRuntime?.fallback &&
    left.contextTokens === right.contextTokens &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens &&
    left.responseUsage === right.responseUsage &&
    left.effectiveResponseUsage === right.effectiveResponseUsage &&
    left.displayName === right.displayName &&
    (left.goal === right.goal ||
      JSON.stringify(left.goal ?? null) === JSON.stringify(right.goal ?? null))
  );
}
