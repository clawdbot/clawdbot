import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isTerminalCodexTurnNotificationForTurn } from "./attempt-notification-state.js";
import {
  isCodexTurnAbortMarkerNotification,
  isPendingOpenClawDynamicToolCompletionNotification,
  isRawFunctionToolOutputCompletionNotification,
  readCodexNotificationItem,
  readNotificationItemId,
  readRawResponseToolCallId,
  updateActiveTurnItemIds,
} from "./attempt-notifications.js";
import { isCodexNotificationForTurn } from "./notification-correlation.js";
import { readCodexTurnCompletedNotification } from "./protocol-validators.js";
import type { CodexServerNotification } from "./protocol.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS } from "./turn-router.js";
import type { CodexThreadRouteScope } from "./turn-router.js";

export function createCodexAttemptNotificationController(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
) {
  const { prompt, state: resourceState, projectorRef, registerNativeSubagentMonitor } = resources;
  const { context, turnState } = prompt;
  const { attemptTools, runtime } = context;
  const { appServer, runAbortController } = runtime.connection;
  const { allocateCodexToolOutcomeOrdinal } = attemptTools;
  const {
    state,
    turnIdRef,
    userInputBridgeRef,
    steeringQueueRef,
    activeTurnItemIds,
    pendingOpenClawDynamicToolCompletionIds,
    completeTurn,
    noteProgress,
    deadlines,
  } = turnRuntime;
  const {
    scheduleTerminalDynamicToolReleaseCheck,
    reportExecutionNotification,
    maybeAnnounceFastModeAutoOff,
  } = lifecycle;
  const isTerminalTurnNotificationForTurn = (
    notification: CodexServerNotification,
    notificationTurnId: string,
  ) =>
    isTerminalCodexTurnNotificationForTurn({
      notification,
      threadId: resourceState.thread.threadId,
      turnId: notificationTurnId,
    });
  const handleNotification = async (notification: CodexServerNotification) => {
    if (state.projectionClosed) {
      return;
    }
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    userInputBridgeRef.current?.handleNotification(notification);
    if (!projector || !turnId) {
      if (notification.method === "error") {
        state.latestStartupErrorNotification = notification;
      }
      return;
    }
    const isCurrentTurn = isCodexNotificationForTurn(
      notification.params,
      resourceState.thread.threadId,
      turnId,
    );
    const isTerminal = isTerminalTurnNotificationForTurn(notification, turnId);
    if (
      (state.timeout || state.localCompletionRequested) &&
      isTerminal &&
      readCodexTurnCompletedNotification(notification.params)?.turn.status === "interrupted"
    ) {
      // Cleanup's interrupt confirms stop; it cannot replace the result or
      // usage already owned by an execution deadline or terminal tool.
      completeTurn();
      return;
    }
    state.activeLocalProjections += 1;
    try {
      if (isCurrentTurn) {
        updateActiveTurnItemIds(notification, activeTurnItemIds);
        noteProgress(`notification:${notification.method}`);
        reportExecutionNotification(notification);
        if (
          isPendingOpenClawDynamicToolCompletionNotification(
            notification,
            pendingOpenClawDynamicToolCompletionIds,
          )
        ) {
          const itemId = readNotificationItemId(notification);
          if (itemId) {
            pendingOpenClawDynamicToolCompletionIds.delete(itemId);
          }
        }
        if (notification.method === "item/completed") {
          if (activeTurnItemIds.size === 0) {
            scheduleTerminalDynamicToolReleaseCheck();
          }
          const item = readCodexNotificationItem(notification.params);
          if (item?.type === "userMessage" && typeof item.clientId === "string") {
            await steeringQueueRef.current?.confirmConsumed(item.clientId);
          }
        }
        if (
          isCodexTurnAbortMarkerNotification(notification, {
            currentPromptTexts: [turnState.codexTurnPromptText],
          })
        ) {
          state.sawCodexInterruptMarker = true;
        }
      }
      await projector.handleNotification(notification);
      if (
        isCurrentTurn &&
        activeTurnItemIds.size === 0 &&
        isRawFunctionToolOutputCompletionNotification(notification)
      ) {
        await maybeAnnounceFastModeAutoOff();
      }
    } catch (error) {
      embeddedAgentLog.debug("codex app-server projector notification threw", {
        method: notification.method,
        error,
      });
    } finally {
      state.activeLocalProjections -= 1;
      if (isTerminal) {
        const completedTurn = readCodexTurnCompletedNotification(notification.params)?.turn;
        // App-server collapses abort reasons; the marker preserves explicit
        // native user interruption without treating marker text as terminal.
        if (completedTurn?.status === "interrupted" && state.sawCodexInterruptMarker) {
          projector.markAborted();
        }
        completeTurn();
      }
    }
  };
  const waitForActiveNativeTurnCompletion = async () => {
    const route = resourceState.turnRoute;
    const activeNativeTurnId =
      resourceState.thread.lifecycle.activeTurnIds?.at(-1) ?? route?.observedNativeTurnId;
    if (!route || !activeNativeTurnId) {
      return false;
    }
    const watch = resourceState.turnRouter.watchNativeTurnCompletion({
      threadId: route.threadId,
      turnId: activeNativeTurnId,
      timeoutMs: Math.min(appServer.requestTimeoutMs, CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS),
      signal: runAbortController.signal,
    });
    try {
      return await watch.completion;
    } finally {
      watch.cancel();
    }
  };
  const noteNotificationReceived = (
    notification: CodexServerNotification,
    scope: CodexThreadRouteScope,
    receivedAtMs: number,
  ) => {
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    if (!projector || !turnId || state.projectionClosed) {
      return;
    }
    if (isTerminalTurnNotificationForTurn(notification, turnId)) {
      state.terminalTurnNotificationQueued = true;
      steeringQueueRef.current?.sealAdmission();
      deadlines.beginSettlement(receivedAtMs);
    }
    if (scope.turnId === turnId) {
      const modelToolCallId = readRawResponseToolCallId(notification);
      if (modelToolCallId) {
        allocateCodexToolOutcomeOrdinal?.(modelToolCallId);
      }
      const nativeItem = readCodexNotificationItem(notification.params);
      if (nativeItem?.type === "webSearch") {
        projector.recordNativeToolOutcome(nativeItem);
      }
    }
  };
  const enqueueNotification = async (
    notification: CodexServerNotification,
    scope: CodexThreadRouteScope,
  ) => {
    embeddedAgentLog.trace("codex app-server raw notification received", {
      method: notification.method,
      ...scope,
    });
    await handleNotification(notification);
  };
  const drainNotificationQueue = async () => {
    await resourceState.turnRoute?.drain();
  };
  registerNativeSubagentMonitor(resourceState.thread.threadId);
  return {
    waitForActiveNativeTurnCompletion,
    noteNotificationReceived,
    enqueueNotification,
    drainNotificationQueue,
  };
}

export type CodexAttemptNotificationController = ReturnType<
  typeof createCodexAttemptNotificationController
>;
