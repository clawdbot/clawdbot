/**
 * Resolves terminal attempt trajectory status and assistant-visible text.
 */
import {
  hasAcceptedSessionSpawn,
  type AcceptedSessionSpawn,
} from "../../accepted-session-spawn.js";

type AttemptTrajectoryTerminalStatus = "success" | "error" | "interrupted";

/** Terminal error marker for runs that produced no user-visible delivery or durable progress. */
const NON_DELIVERABLE_TERMINAL_TURN_REASON = "non_deliverable_terminal_turn";

/** Normalized terminal status recorded for an embedded run attempt trajectory. */
type AttemptTrajectoryTerminal = {
  status: AttemptTrajectoryTerminalStatus;
  terminalError?: typeof NON_DELIVERABLE_TERMINAL_TURN_REASON;
};

/** Signals that decide whether a completed run attempt has deliverable output. */
type ResolveAttemptTrajectoryTerminalParams = {
  promptError?: unknown;
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  assistantTexts: string[];
  toolMetas: Array<{
    toolName: string;
    meta?: string;
    asyncStarted?: boolean;
    asyncTaskRunId?: string;
    asyncTaskId?: string;
  }>;
  didSendViaMessagingTool: boolean;
  didSendDeterministicApprovalPrompt: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: unknown[];
  successfulCronAdds: number;
  synthesizedPayloadCount: number;
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  heartbeatToolResponse?: unknown;
  clientToolCalls?: Array<unknown>;
  yieldDetected?: boolean;
  lastToolError?: unknown;
  silentExpected?: boolean;
  emptyAssistantReplyIsSilent?: boolean;
  lastAssistantStopReason?: string;
  hasTerminalOutput?: boolean;
};

/**
 * Chooses assistant text that can safely count as terminal output. Provider error
 * and abort stop reasons cannot fall back to the raw last visible text because
 * that text may describe an interrupted generation rather than a completed reply.
 */
export function resolveTerminalAssistantTexts(params: {
  assistantTexts: string[];
  lastAssistantStopReason?: string;
  lastAssistantVisibleText?: string;
}): string[] {
  if (hasNonEmptyAssistantText(params.assistantTexts)) {
    return params.assistantTexts;
  }
  if (params.lastAssistantStopReason === "error" || params.lastAssistantStopReason === "aborted") {
    return params.assistantTexts;
  }
  const fallbackText = params.lastAssistantVisibleText?.trim();
  return fallbackText ? [fallbackText] : params.assistantTexts;
}

function hasNonEmptyAssistantText(texts: string[]): boolean {
  return texts.some((text) => text.trim().length > 0);
}

function hasNonEmptyString(values: string[]): boolean {
  return values.some((value) => value.trim().length > 0);
}

function hasCommittedMessagingDeliveryEvidence(
  params: Pick<
    ResolveAttemptTrajectoryTerminalParams,
    "messagingToolSentTexts" | "messagingToolSentMediaUrls" | "messagingToolSentTargets"
  >,
): boolean {
  return (
    hasNonEmptyString(params.messagingToolSentTexts) ||
    hasNonEmptyString(params.messagingToolSentMediaUrls) ||
    params.messagingToolSentTargets.length > 0
  );
}

function hasAsyncStartedToolActivity(toolMetas?: readonly { asyncStarted?: boolean }[]): boolean {
  return (toolMetas ?? []).some((entry) => entry.asyncStarted === true);
}

/**
 * Classifies the final attempt trajectory from visible output, durable side
 * effects, and interruption state. Empty terminal turns are errors unless a
 * caller proves a silent success, message delivery, spawned session, async task,
 * or other durable progress.
 */
export function resolveAttemptTrajectoryTerminal(
  params: ResolveAttemptTrajectoryTerminalParams,
): AttemptTrajectoryTerminal {
  if (params.promptError) {
    return { status: "error" };
  }
  if ((params.aborted && params.externalAbort) || params.timedOut) {
    return { status: "interrupted" };
  }

  // Messaging/tool-use attempts may not have assistant text; only committed
  // delivery evidence or durable side effects can make those terminal turns
  // successful.
  const hasExplicitTerminalDelivery =
    params.silentExpected === true ||
    params.emptyAssistantReplyIsSilent === true ||
    params.didSendDeterministicApprovalPrompt ||
    hasCommittedMessagingDeliveryEvidence(params) ||
    hasAcceptedSessionSpawn(params.acceptedSessionSpawns) ||
    params.heartbeatToolResponse !== undefined ||
    (params.clientToolCalls?.length ?? 0) > 0 ||
    params.yieldDetected === true ||
    params.lastToolError !== undefined ||
    hasAsyncStartedToolActivity(params.toolMetas);

  if (params.lastAssistantStopReason === "toolUse" && !hasExplicitTerminalDelivery) {
    return {
      status: "error",
      terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
    };
  }
  if (
    params.lastAssistantStopReason === "length" &&
    !params.hasTerminalOutput &&
    !hasExplicitTerminalDelivery
  ) {
    return {
      status: "error",
      terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
    };
  }

  const hasDeliverableOrProgress =
    hasExplicitTerminalDelivery ||
    params.hasTerminalOutput ||
    params.synthesizedPayloadCount > 0 ||
    hasNonEmptyAssistantText(params.assistantTexts) ||
    params.successfulCronAdds > 0;

  if (hasDeliverableOrProgress) {
    return { status: "success" };
  }

  return {
    status: "error",
    terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
  };
}
