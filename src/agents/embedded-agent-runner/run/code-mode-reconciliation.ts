import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";
import type { EmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const CODE_MODE_RECONCILIATION_PROMPT =
  "OpenClaw activated this temporary read-only recovery attempt because the previous Code Mode mutation may have partially applied. This is the only recovery attempt. Do not repeat or finish any mutation. Use only the available read-only inspection tools to determine the authoritative current state, then report exactly what applied, what did not, what remains unknown, and what work is still required.";

const RECONCILIATION_TOOL_NAMES = new Set(["read"]);

export function isCodeModeReconciliationTool(tool: { name?: string }): boolean {
  return RECONCILIATION_TOOL_NAMES.has(normalizeToolPolicyName(tool.name ?? ""));
}

function shouldRetryCodeModeReconciliation(params: {
  attempt: EmbeddedRunAttemptResult;
  hostOwnsToolSurface: boolean;
  aborted: boolean;
  timedOut: boolean;
  promptError: unknown;
}): boolean {
  const { attempt } = params;
  return (
    attempt.codeModeReconciliationCandidate === true &&
    params.hostOwnsToolSurface &&
    !params.aborted &&
    !params.timedOut &&
    !params.promptError &&
    attempt.itemLifecycle.activeCount === 0 &&
    attempt.itemLifecycle.startedCount === attempt.itemLifecycle.completedCount &&
    !attempt.clientToolCalls &&
    !attempt.yieldDetected &&
    !attempt.didSendDeterministicApprovalPrompt &&
    !attempt.runtimeContinuationStarted &&
    !attempt.toolMetas.some((entry) => entry.asyncStarted === true) &&
    (attempt.acceptedSessionSpawns?.length ?? 0) === 0 &&
    !attempt.didSendViaMessagingTool &&
    (attempt.successfulCronAdds ?? 0) === 0
  );
}

export function activateCodeModeReconciliation(params: {
  attempt: EmbeddedRunAttemptResult;
  hostOwnsToolSurface: boolean;
  retryState: EmbeddedRunTerminalRetryState;
  activateInternalPrompt: (prompt: string) => void;
}): boolean {
  const terminal = projectAgentRunAttemptTerminal(params.attempt.terminal);
  if (
    params.retryState.codeModeReconciliationAttempts >= 1 ||
    !shouldRetryCodeModeReconciliation({
      attempt: params.attempt,
      hostOwnsToolSurface: params.hostOwnsToolSurface,
      ...terminal,
    })
  ) {
    return false;
  }
  params.retryState.codeModeReconciliationAttempts += 1;
  params.retryState.forceCodeModeReconciliationTools = true;
  params.activateInternalPrompt(CODE_MODE_RECONCILIATION_PROMPT);
  return true;
}
