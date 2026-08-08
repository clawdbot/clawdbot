import { formatErrorMessage } from "../../../infra/errors.js";
import { buildTrajectoryArtifacts } from "../../../trajectory/metadata.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import {
  resolveAttemptTrajectoryTerminal,
  resolveTerminalAssistantTexts,
} from "./attempt-trajectory-status.js";
import { resolveFinalAssistantVisibleText } from "./helpers.js";
import {
  isEmbeddedRunTerminalInterrupted,
  resolveEmbeddedRunAttemptTerminalOutcome,
} from "./terminal-outcome.js";
import type { EmbeddedRunAttemptResult, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

type FinalizeEmbeddedAttemptParams = {
  result: EmbeddedRunAttemptResult;
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder | null;
  synthesizedPayloadCount: number;
  emptyAssistantReplyIsSilent: boolean;
  hasTerminalOutput: boolean;
  silentExpected?: boolean;
};

/** Classifies the completed attempt and records its terminal trajectory artifacts. */
export function finalizeEmbeddedAttempt(
  params: FinalizeEmbeddedAttemptParams,
): EmbeddedRunAttemptResult {
  const { result, trajectoryRecorder } = params;
  if (!trajectoryRecorder) {
    return result;
  }
  const terminalState = projectAgentRunAttemptTerminal(result.terminal);
  // Yield ends before message_end, so lastAssistant owns completion; the
  // completed attempt snapshot may belong to an earlier model cycle.
  const completionAssistant =
    result.yieldDetected === true
      ? result.lastAssistant
      : (result.currentAttemptCompletedAssistant ?? result.currentAttemptAssistant);
  const completionOutcome = resolveEmbeddedRunAttemptTerminalOutcome({
    attempt: result,
    assistant: completionAssistant,
  });
  const terminalAssistantTexts = resolveTerminalAssistantTexts({
    assistantTexts: result.assistantTexts,
    lastAssistantStopReason: completionOutcome.stopReason,
    lastAssistantVisibleText: resolveFinalAssistantVisibleText(completionAssistant),
  });
  const terminal = resolveAttemptTrajectoryTerminal({
    failed: completionOutcome.status === "error",
    interrupted: isEmbeddedRunTerminalInterrupted(completionOutcome),
    assistantTexts: terminalAssistantTexts,
    toolMetas: result.toolMetas,
    didSendViaMessagingTool: result.didSendViaMessagingTool,
    didSendDeterministicApprovalPrompt: result.didSendDeterministicApprovalPrompt === true,
    messagingToolSentTexts: result.messagingToolSentTexts,
    messagingToolSentMediaUrls: result.messagingToolSentMediaUrls,
    messagingToolSentTargets: result.messagingToolSentTargets,
    successfulCronAdds: result.successfulCronAdds ?? 0,
    synthesizedPayloadCount: params.synthesizedPayloadCount,
    acceptedSessionSpawns: result.acceptedSessionSpawns,
    heartbeatToolResponse: result.heartbeatToolResponse,
    clientToolCalls: result.clientToolCalls,
    yieldDetected: result.yieldDetected,
    lastToolError: result.lastToolError,
    silentExpected: params.silentExpected,
    emptyAssistantReplyIsSilent: params.emptyAssistantReplyIsSilent,
    lastAssistantStopReason: completionOutcome.stopReason,
    hasTerminalOutput: params.hasTerminalOutput,
  });
  const promptError = terminalState.promptError
    ? formatErrorMessage(terminalState.promptError)
    : undefined;

  trajectoryRecorder.recordEvent("model.completed", {
    aborted: terminalState.aborted,
    externalAbort: terminalState.externalAbort,
    timedOut: terminalState.timedOut,
    idleTimedOut: terminalState.idleTimedOut,
    timedOutDuringCompaction: terminalState.timedOutDuringCompaction,
    timedOutDuringToolExecution: terminalState.timedOutDuringToolExecution,
    timedOutByRunBudget: terminalState.timedOutByRunBudget,
    promptError,
    promptErrorSource: terminalState.promptErrorSource,
    terminalError: terminal.terminalError,
    usage: result.attemptUsage,
    promptCache: result.promptCache,
    compactionCount: result.compactionCount,
    assistantTexts: result.assistantTexts,
    stopReason: completionOutcome.stopReason,
    finalPromptText: result.finalPromptText,
    messagesSnapshot: result.messagesSnapshot,
  });
  trajectoryRecorder.recordEvent(
    "trace.artifacts",
    buildTrajectoryArtifacts({
      status: terminal.status,
      aborted: terminalState.aborted,
      externalAbort: terminalState.externalAbort,
      timedOut: terminalState.timedOut,
      idleTimedOut: terminalState.idleTimedOut,
      timedOutDuringCompaction: terminalState.timedOutDuringCompaction,
      timedOutDuringToolExecution: terminalState.timedOutDuringToolExecution,
      timedOutByRunBudget: terminalState.timedOutByRunBudget,
      promptError,
      promptErrorSource: terminalState.promptErrorSource,
      terminalError: terminal.terminalError,
      usage: result.attemptUsage,
      promptCache: result.promptCache,
      compactionCount: result.compactionCount ?? 0,
      assistantTexts: result.assistantTexts,
      stopReason: completionOutcome.stopReason,
      finalPromptText: result.finalPromptText,
      itemLifecycle: result.itemLifecycle,
      toolMetas: result.toolMetas,
      didSendViaMessagingTool: result.didSendViaMessagingTool,
      successfulCronAdds: result.successfulCronAdds ?? 0,
      messagingToolSentTexts: result.messagingToolSentTexts,
      messagingToolSentMediaUrls: result.messagingToolSentMediaUrls,
      messagingToolSentTargets: result.messagingToolSentTargets,
      lastToolError: result.lastToolError,
    }),
  );
  trajectoryRecorder.recordEvent("session.ended", {
    status: terminal.status,
    aborted: terminalState.aborted,
    externalAbort: terminalState.externalAbort,
    timedOut: terminalState.timedOut,
    idleTimedOut: terminalState.idleTimedOut,
    timedOutDuringCompaction: terminalState.timedOutDuringCompaction,
    timedOutDuringToolExecution: terminalState.timedOutDuringToolExecution,
    timedOutByRunBudget: terminalState.timedOutByRunBudget,
    promptError,
    terminalError: terminal.terminalError,
  });

  return result;
}
