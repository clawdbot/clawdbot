import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  embeddedAgentLog,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  interruptCodexTurnBestEffort,
  retireCodexAppServerClientAfterTimedOutTurn,
} from "./attempt-client-cleanup.js";
import { isTerminalTurnStatus } from "./attempt-notifications.js";
import { createCodexSteeringQueue, type CodexSteeringQueueOptions } from "./attempt-steering.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import type { CodexTurnStartResponse, JsonObject } from "./protocol.js";
import { readRecentCodexRateLimits } from "./rate-limit-cache.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import {
  createCodexAppServerUserMessagePersistenceNotifier,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";

export async function activateCodexAttemptTurn(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
  notifications: CodexAttemptNotificationController,
  turn: CodexTurnStartResponse,
) {
  const {
    prompt,
    state: resourceState,
    projectorRef,
    trajectoryRecorder,
    pendingNativePreToolUseFailures,
  } = resources;
  const { context, turnState } = prompt;
  const { runtime, attemptTools } = context;
  const { connection } = runtime;
  const {
    params,
    runAbortController,
    terminalState,
    abortExplicitly,
    abortFromUpstream,
    bindingStore,
    bindingIdentity,
    sessionAgentId,
    sandboxSessionKey,
    effectiveCwd,
  } = connection;
  const { dynamicToolParams, computerContextEpoch } = attemptTools;
  const { state, userInputBridgeRef, steeringQueueRef, turnWatches } = turnRuntime;
  const { emitExecutionPhaseOnce, emitLifecycleStart, maybeAnnounceFastModeAutoOff } = lifecycle;
  const { enqueueNotification } = notifications;
  const activeTurnId = turn.turn.id;
  const streamState = { eventEmitted: false, needsTerminalSnapshot: false };
  emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
  userInputBridgeRef.current = createCodexUserInputBridge({
    paramsForRun: params,
    threadId: resourceState.thread.threadId,
    turnId: activeTurnId,
    signal: runAbortController.signal,
  });
  trajectoryRecorder?.recordEvent("prompt.submitted", {
    threadId: resourceState.thread.threadId,
    turnId: activeTurnId,
    prompt: turnState.codexTurnPromptText,
    imagesCount: params.images?.length ?? 0,
  });
  projectorRef.current = new CodexAppServerEventProjector(
    {
      ...dynamicToolParams,
      onAgentEvent: (event) => {
        if (event.stream === "assistant" && typeof event.data.delta === "string") {
          streamState.eventEmitted = true;
          streamState.needsTerminalSnapshot ||= event.data.replaceable === true;
        }
        return dynamicToolParams.onAgentEvent?.(event);
      },
    },
    resourceState.thread.threadId,
    activeTurnId,
    {
      nativePostToolUseRelayEnabled:
        resourceState.nativeHookRelay?.allowedEvents.includes("post_tool_use") === true &&
        resourceState.nativeHookRelay.shouldRelayEvent("post_tool_use"),
      readRecentRateLimits: () => readRecentCodexRateLimits(resourceState.client),
      runAbortSignal: runAbortController.signal,
      trajectoryRecorder,
      onNativeToolResultRecorded: maybeAnnounceFastModeAutoOff,
      upstreamUserText: turnState.codexTurnPromptText,
      onContextCompacted: () => {
        computerContextEpoch.value += 1;
        delete computerContextEpoch.frameToolCallId;
        delete computerContextEpoch.frameImageIdentity;
      },
    },
  );
  if (isTerminalTurnStatus(turn.turn.status)) {
    state.terminalTurnNotificationQueued = true;
  }
  emitLifecycleStart();
  const activeProjector = projectorRef.current;
  turnWatches.armTerminalIdleWatch();
  turnWatches.touchActivity("turn:start", { arm: true });
  turnWatches.armAttemptIdleWatch();
  turnWatches.touchActivity("turn:start", { attemptProgress: true });
  for (const failure of pendingNativePreToolUseFailures.splice(0)) {
    activeProjector.recordNativeToolPreToolUseFailure(failure);
  }
  // The route buffers early events. Publish full turn context, then release in wire order.
  if (resourceState.turnRoute) {
    try {
      await resourceState.turnRoute.bindTurn(activeTurnId);
    } catch (error) {
      if (!state.terminalTurnNotificationQueued) {
        throw error;
      }
      await resourceState.turnRoute.drain();
      if (!state.completed) {
        turnWatches.clearAllTimers();
        throw error;
      }
    }
  }
  if (!state.completed && isTerminalTurnStatus(turn.turn.status)) {
    await enqueueNotification(
      {
        method: "turn/completed",
        params: {
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          turn: turn.turn as unknown as JsonObject,
        },
      },
      { threadId: resourceState.thread.threadId, turnId: activeTurnId },
    );
  }
  const activeSteeringQueue = createCodexSteeringQueue({
    client: resourceState.client,
    threadId: resourceState.thread.threadId,
    turnId: activeTurnId,
    claimPendingUserInput: () => userInputBridgeRef.current?.claimPendingRequest(),
    signal: runAbortController.signal,
  });
  steeringQueueRef.current = activeSteeringQueue;
  const handle = {
    kind: "embedded" as const,
    runId: params.runId,
    queueMessage: async (text: string, optionsLocal?: CodexSteeringQueueOptions) => {
      const isInboundUserMessage = optionsLocal?.isInboundUserMessage === true;
      if (isInboundUserMessage && !optionsLocal?.images?.length) {
        const claimed = await claimPendingAgentQuestionAnswer({
          sessionKey: params.sessionKey ?? params.sessionId,
          text,
        });
        if (claimed) {
          return;
        }
      } else if (isInboundUserMessage) {
        try {
          await cancelPendingAgentQuestionForSession({
            sessionKey: params.sessionKey ?? params.sessionId,
            resolvedBy: "image-reply",
          });
        } catch (error) {
          // Cleanup failure must not drop the user's image turn.
          embeddedAgentLog.warn("failed to cancel codex gateway question before image steering", {
            error,
          });
        }
      }
      await activeSteeringQueue.queue(text, optionsLocal);
    },
    isStreaming: () => !state.completed && !runAbortController.signal.aborted,
    isStopped: () => state.completed || state.timedOut || runAbortController.signal.aborted,
    isAbortable: () =>
      !terminalState.terminalOutcomeFrozen || terminalState.sharedAbortAllowedAfterTerminalOutcome,
    isCompacting: () => projectorRef.current?.isCompacting() ?? false,
    supportsQueueMessageImages: true,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    cancel: () => abortExplicitly("cancelled"),
    abort: () => abortExplicitly("aborted"),
  };
  params.replyOperation?.attachBackend(handle);
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
  const freezeRunTerminalOutcome = () => {
    if (terminalState.terminalOutcomeFrozen) {
      return;
    }
    terminalState.terminalOutcomeFrozen = true;
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
  };
  const notifyUserMessagePersisted = createCodexAppServerUserMessagePersistenceNotifier(params);
  void mirrorPromptAtTurnStartBestEffort({
    params,
    agentId: sessionAgentId,
    notifyUserMessagePersisted,
    sessionKey: sandboxSessionKey,
    cwd: effectiveCwd,
    threadId: resourceState.thread.threadId,
    turnId: activeTurnId,
    upstreamUserText: turnState.codexTurnPromptText,
  });
  const abortListener = () => {
    if (state.timedOut) {
      void (async () => {
        // Supervised sessions stay native; clearing scope would silently move the next attempt.
        if (resourceState.thread.connectionScope !== "supervision") {
          await bindingStore.mutate(bindingIdentity, {
            kind: "clear",
            threadId: resourceState.thread.threadId,
          });
        }
        await retireCodexAppServerClientAfterTimedOutTurn(resourceState.client, {
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          reason: String(runAbortController.signal.reason ?? "timeout"),
          suspectPhysicalClient: state.turnWatchTimeoutKind === "terminal",
        });
      })().finally(() => state.resolveCompletion?.());
      return;
    }
    interruptCodexTurnBestEffort(resourceState.client, {
      threadId: resourceState.thread.threadId,
      turnId: activeTurnId,
    });
    state.resolveCompletion?.();
  };
  runAbortController.signal.addEventListener("abort", abortListener, { once: true });
  if (runAbortController.signal.aborted) {
    abortListener();
  }
  return {
    activeTurnId,
    activeProjector,
    streamState,
    handle,
    freezeRunTerminalOutcome,
    notifyUserMessagePersisted,
    abortListener,
  };
}

export type CodexAttemptActiveTurn = Awaited<ReturnType<typeof activateCodexAttemptTurn>>;
