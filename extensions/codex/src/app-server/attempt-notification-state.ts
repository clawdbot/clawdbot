/**
 * State machine for Codex app-server turn notifications and idle-watch updates.
 */
import {
  codexExecutionToolName,
  describeNotificationActivity,
  isAssistantCompletionReleaseNotification,
  isCodexTurnAbortMarkerNotification,
  isFileChangePatchUpdatedNotification,
  isAssistantCommentaryCompletionNotification,
  isNativeToolProgressNotification,
  isNativeResponseStreamDeltaNotification,
  isPendingOpenClawDynamicToolCompletionNotification,
  isRawAssistantProgressNotification,
  isRawReasoningCompletionNotification,
  isRawToolOutputCompletionNotification,
  isReasoningProgressNotification,
  isReasoningItemCompletionNotification,
  isRetryableErrorNotification,
  isTurnNotification,
  readCodexNotificationItem,
  readNotificationItemId,
  shouldDisarmAssistantCompletionIdleWatch,
  updateActiveTurnItemIds,
} from "./attempt-notifications.js";
import { CODEX_POST_REASONING_REPLY_IDLE_TIMEOUT_MS } from "./attempt-timeouts.js";
import type { CodexAttemptTurnWatchController } from "./attempt-turn-watches.js";
import type { CodexServerNotification } from "./protocol.js";

type CodexExecutionPhase =
  | { phase: "turn_accepted" }
  | { phase: "assistant_output_started" }
  | { phase: "tool_execution_started"; itemId?: string; tool: string };

/** Emits coarse execution phases exactly once from app-server notifications. */
export function reportCodexExecutionNotification(params: {
  notification: CodexServerNotification;
  emitExecutionPhaseOnce: (key: string, info: CodexExecutionPhase) => void;
}): void {
  const { notification } = params;
  if (notification.method === "turn/started") {
    params.emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
    return;
  }
  if (notification.method === "item/agentMessage/delta") {
    params.emitExecutionPhaseOnce("assistant_output_started", {
      phase: "assistant_output_started",
    });
    return;
  }
  if (notification.method !== "item/started") {
    return;
  }
  const item = readCodexNotificationItem(notification.params);
  const tool = item ? codexExecutionToolName(item) : undefined;
  if (!item || !tool) {
    return;
  }
  params.emitExecutionPhaseOnce(`tool:${item.id}`, {
    phase: "tool_execution_started",
    tool,
    itemId: item.id,
  });
}

/** Returns true when a notification ends the current app-server turn. */
export function isTerminalCodexTurnNotificationForTurn(params: {
  notification: CodexServerNotification;
  threadId: string;
  turnId: string;
  currentPromptTexts: string[];
}): boolean {
  if (!isTurnNotification(params.notification.params, params.threadId, params.turnId)) {
    return false;
  }
  return (
    params.notification.method === "turn/completed" ||
    isCodexTurnAbortMarkerNotification(params.notification, {
      currentPromptTexts: params.currentPromptTexts,
    })
  );
}

/**
 * Applies one notification to active item tracking, idle watches, and terminal
 * turn state.
 */
export function applyCodexTurnNotificationState(params: {
  notification: CodexServerNotification;
  threadId: string;
  turnId: string;
  currentPromptTexts: string[];
  turnWatches: CodexAttemptTurnWatchController;
  activeTurnItemIds: Set<string>;
  activeAppServerTurnRequests: number;
  pendingOpenClawDynamicToolCompletionIds: Set<string>;
  turnCrossedToolHandoff: boolean;
  postToolRawAssistantCompletionIdleTimeoutMs: number;
  onScheduleTerminalDynamicToolReleaseCheck: () => void;
  onReportExecutionNotification: (notification: CodexServerNotification) => void;
}): {
  isCurrentTurnNotification: boolean;
  isTurnAbortMarker: boolean;
  isTurnTerminal: boolean;
  turnCrossedToolHandoff: boolean;
} {
  const { notification, turnWatches } = params;
  const isCurrentTurnNotification = isTurnNotification(
    notification.params,
    params.threadId,
    params.turnId,
  );
  const isTurnCompletion = notification.method === "turn/completed" && isCurrentTurnNotification;
  const isNativeResponseStreamDelta = isNativeResponseStreamDeltaNotification(notification);
  let turnCrossedToolHandoff = params.turnCrossedToolHandoff;

  if (isCurrentTurnNotification && !isNativeResponseStreamDelta) {
    turnWatches.touchActivity(`notification:${notification.method}`, {
      details: describeNotificationActivity(notification),
      attemptProgress: true,
    });
    params.onReportExecutionNotification(notification);
    updateActiveTurnItemIds(notification, params.activeTurnItemIds);
    if (notification.method === "item/completed" && params.activeTurnItemIds.size === 0) {
      params.onScheduleTerminalDynamicToolReleaseCheck();
    }
  }

  const unblockedAssistantCompletionRelease =
    isCurrentTurnNotification &&
    turnWatches.isAssistantCompletionIdleWatchArmed() &&
    notification.method === "item/completed" &&
    params.activeTurnItemIds.size === 0;
  const trackedDynamicToolCompletion = isPendingOpenClawDynamicToolCompletionNotification(
    notification,
    params.pendingOpenClawDynamicToolCompletionIds,
  );
  const rawToolOutputCompletion = isRawToolOutputCompletionNotification(notification);
  if (
    isCurrentTurnNotification &&
    (rawToolOutputCompletion || isNativeToolProgressNotification(notification))
  ) {
    turnCrossedToolHandoff = true;
  }
  const assistantCompletionCanRelease = isAssistantCompletionReleaseNotification(
    notification,
    turnCrossedToolHandoff,
  );
  const postToolProgressNeedsTerminalGuard =
    isCurrentTurnNotification &&
    turnCrossedToolHandoff &&
    (((isRawAssistantProgressNotification(notification) ||
      isRawReasoningCompletionNotification(notification)) &&
      params.activeTurnItemIds.size === 0) ||
      isReasoningProgressNotification(notification));
  const postToolPatchUpdateNeedsTerminalGuard =
    isCurrentTurnNotification &&
    turnCrossedToolHandoff &&
    isFileChangePatchUpdatedNotification(notification);
  const rawResponseItemCompletedWithNoActiveItems =
    isCurrentTurnNotification &&
    notification.method === "rawResponseItem/completed" &&
    params.activeTurnItemIds.size === 0 &&
    params.activeAppServerTurnRequests === 0 &&
    !assistantCompletionCanRelease &&
    !postToolProgressNeedsTerminalGuard &&
    !rawToolOutputCompletion;
  const shouldArmNoToolPostProgressReplyWatch =
    isCurrentTurnNotification &&
    !turnCrossedToolHandoff &&
    params.activeTurnItemIds.size === 0 &&
    (isReasoningItemCompletionNotification(notification) ||
      isAssistantCommentaryCompletionNotification(notification));
  const shouldArmNoToolPostRawProgressReplyWatch =
    !turnCrossedToolHandoff &&
    rawResponseItemCompletedWithNoActiveItems &&
    (isRawReasoningCompletionNotification(notification) ||
      isRawAssistantProgressNotification(notification));
  const shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem =
    isCurrentTurnNotification &&
    notification.method === "item/completed" &&
    params.activeTurnItemIds.size === 0 &&
    !trackedDynamicToolCompletion &&
    !assistantCompletionCanRelease &&
    !shouldArmNoToolPostProgressReplyWatch;
  const shouldUsePostToolContinuationWatch =
    turnCrossedToolHandoff &&
    (postToolProgressNeedsTerminalGuard ||
      postToolPatchUpdateNeedsTerminalGuard ||
      rawToolOutputCompletion ||
      trackedDynamicToolCompletion ||
      shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem);
  const armPostToolContinuationWatch = () => {
    turnWatches.armCompletionIdleWatch({
      timeoutMs: params.postToolRawAssistantCompletionIdleTimeoutMs,
    });
    turnWatches.extendAttemptIdleWatch(params.postToolRawAssistantCompletionIdleTimeoutMs);
  };
  const armPostProgressReplyWatch = () => {
    turnWatches.armCompletionIdleWatch({
      timeoutMs: CODEX_POST_REASONING_REPLY_IDLE_TIMEOUT_MS,
    });
    turnWatches.extendAttemptIdleWatch(CODEX_POST_REASONING_REPLY_IDLE_TIMEOUT_MS);
  };

  if (isCurrentTurnNotification && notification.method === "error") {
    if (isRetryableErrorNotification(notification.params)) {
      turnWatches.disarmCompletionIdleWatch();
    } else {
      turnWatches.armCompletionIdleWatch({ pinnedByTerminalError: true });
    }
    turnWatches.disarmAssistantCompletionIdleWatch();
  } else if (isTurnCompletion) {
    turnWatches.disarmAssistantCompletionIdleWatch();
  } else if (isCurrentTurnNotification && assistantCompletionCanRelease) {
    turnWatches.armAssistantCompletionIdleWatch(describeNotificationActivity(notification));
  } else if (postToolProgressNeedsTerminalGuard || postToolPatchUpdateNeedsTerminalGuard) {
    // Post-tool assistant/reasoning status and patch snapshots can be followed
    // by more native edit streaming. Keep the short guard alive until Codex
    // reports a terminal turn state instead of falling back to the long
    // terminal watch.
    armPostToolContinuationWatch();
  } else if (shouldArmNoToolPostProgressReplyWatch || shouldArmNoToolPostRawProgressReplyWatch) {
    armPostProgressReplyWatch();
  } else if (trackedDynamicToolCompletion) {
    armPostToolContinuationWatch();
  } else if (unblockedAssistantCompletionRelease) {
    turnWatches.armAssistantCompletionIdleWatch(describeNotificationActivity(notification));
  } else if (shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem) {
    // If a non-assistant current-turn item is the last active item and the
    // bridge then goes quiet, reset the short completion-idle guard from that
    // final completion so the remaining silent-turn gap fails fast.
    if (shouldUsePostToolContinuationWatch) {
      armPostToolContinuationWatch();
    } else {
      turnWatches.armCompletionIdleWatch();
    }
  } else if (rawResponseItemCompletedWithNoActiveItems) {
    turnWatches.armCompletionIdleWatch();
  } else if (isCurrentTurnNotification && rawToolOutputCompletion) {
    // Raw OpenAI response streams can report the tool-output handoff without
    // a matching app-server `item/completed`; keep the post-tool guard alive.
    armPostToolContinuationWatch();
  } else if (isCurrentTurnNotification && shouldDisarmAssistantCompletionIdleWatch(notification)) {
    turnWatches.disarmAssistantCompletionIdleWatch();
  }

  if (
    turnWatches.isCompletionIdleWatchArmed() &&
    !turnWatches.isCompletionIdleWatchPinnedByTerminalError() &&
    notification.method !== "turn/completed" &&
    isCurrentTurnNotification &&
    !isNativeResponseStreamDelta &&
    !trackedDynamicToolCompletion &&
    !rawToolOutputCompletion &&
    !postToolProgressNeedsTerminalGuard &&
    !postToolPatchUpdateNeedsTerminalGuard &&
    !rawResponseItemCompletedWithNoActiveItems &&
    !shouldArmNoToolPostProgressReplyWatch &&
    !shouldArmNoToolPostRawProgressReplyWatch &&
    !shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem
  ) {
    // The short completion-idle watchdog guards blind gaps after Codex
    // accepts a turn or after OpenClaw hands a turn-scoped request result
    // back to Codex. Bookkeeping that closes the just-served OpenClaw
    // dynamic tool item is still part of that handoff, so keep the short
    // watchdog armed for that notification.
    turnWatches.disarmCompletionIdleWatch();
  }

  if (trackedDynamicToolCompletion) {
    const itemId = readNotificationItemId(notification);
    if (itemId) {
      params.pendingOpenClawDynamicToolCompletionIds.delete(itemId);
      params.onScheduleTerminalDynamicToolReleaseCheck();
    }
  }

  const isTurnAbortMarker =
    isCurrentTurnNotification &&
    isCodexTurnAbortMarkerNotification(notification, {
      currentPromptTexts: params.currentPromptTexts,
    });
  const isTurnTerminal = isTerminalCodexTurnNotificationForTurn({
    notification,
    threadId: params.threadId,
    turnId: params.turnId,
    currentPromptTexts: params.currentPromptTexts,
  });

  return {
    isCurrentTurnNotification,
    isTurnAbortMarker,
    isTurnTerminal,
    turnCrossedToolHandoff,
  };
}
