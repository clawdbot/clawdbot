import { formatErrorMessage } from "../../../infra/errors.js";
import { getDiagnosticSessionState } from "../../../logging/diagnostic-session-state.js";
import { buildTrajectoryArtifacts } from "../../../trajectory/metadata.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { recordVisibleReply } from "../../visible-loop-detection.js";
import {
  resolveAttemptTrajectoryTerminal,
  resolveTerminalAssistantTexts,
} from "./attempt-trajectory-status.js";
import { resolveFinalAssistantVisibleText } from "./helpers.js";
import type { EmbeddedRunAttemptResult, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

type FinalizeEmbeddedAttemptParams = {
  result: EmbeddedRunAttemptResult;
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder | null;
  synthesizedPayloadCount: number;
  emptyAssistantReplyIsSilent: boolean;
  hasTerminalOutput: boolean;
  silentExpected?: boolean;
  /** Session key for visible-reply loop detection. Optional — when
   * provided, the final assistant visible text + plan are recorded
   * onto the diagnostic session state so the before-tool-call hook
   * can detect same_visible_reply / same_plan_rewrite patterns. */
  sessionKey?: string;
};

/** Classifies the completed attempt and records its terminal trajectory artifacts. */
export function finalizeEmbeddedAttempt(
  params: FinalizeEmbeddedAttemptParams,
): EmbeddedRunAttemptResult {
  const { result, trajectoryRecorder, sessionKey } = params;
  const terminalVisibleText = resolveFinalAssistantVisibleText(result.lastAssistant);
  // Visible-reply loop detection: record the final assistant visible
  // text onto the diagnostic session state so the next
  // before-tool-call hook can detect same_visible_reply /
  // same_plan_rewrite patterns. The plan isn't available here yet
  // (the assistant's plan update is delivered via tool calls in the
  // same turn); we record undefined for plan and let the next
  // before-tool-call invocation populate it from a later phase if
  // needed. See src/agents/visible-loop-detection.ts.
  if (sessionKey && terminalVisibleText) {
    const sessionState = getDiagnosticSessionState({ sessionKey });
    if (!sessionState.visibleReplyHistory) {
      sessionState.visibleReplyHistory = [];
    }
    recordVisibleReply(sessionState.visibleReplyHistory, terminalVisibleText, undefined);
  }
  const terminalState = projectAgentRunAttemptTerminal(result.terminal);
  const terminalAssistantTexts = resolveTerminalAssistantTexts({
    assistantTexts: result.assistantTexts,
    lastAssistantStopReason: result.lastAssistant?.stopReason,
    lastAssistantVisibleText: resolveFinalAssistantVisibleText(result.lastAssistant),
  });
  const terminal = resolveAttemptTrajectoryTerminal({
    failed: terminalState.failed,
    interrupted: terminalState.interrupted,
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
    lastAssistantStopReason: result.lastAssistant?.stopReason,
    hasTerminalOutput: params.hasTerminalOutput,
  });
  const promptError = terminalState.promptError
    ? formatErrorMessage(terminalState.promptError)
    : undefined;

  trajectoryRecorder?.recordEvent("model.completed", {
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
    finalPromptText: result.finalPromptText,
    messagesSnapshot: result.messagesSnapshot,
  });
  trajectoryRecorder?.recordEvent(
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
  trajectoryRecorder?.recordEvent("session.ended", {
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
