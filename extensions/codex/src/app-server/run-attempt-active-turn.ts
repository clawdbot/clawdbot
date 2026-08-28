import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  detectAndLoadAgentHarnessPromptImages,
  embeddedAgentLog,
  formatErrorMessage,
  resolveAttemptFsWorkspaceOnly,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-local-roots";
import { hasPromptImageInput } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  retireCodexAppServerClientAfterTimedOutTurn,
  terminateCodexBackgroundTerminals,
} from "./attempt-client-cleanup.js";
import { isTerminalTurnStatus } from "./attempt-notifications.js";
import {
  CodexSteeringAcceptedUnconfirmedError,
  createCodexSteeringQueue,
  type CodexSteeringQueueOptions,
} from "./attempt-steering.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { createCodexNativeMcpAppResultDetailsPreparer } from "./native-mcp-app.js";
import { canonicalizeNativeProgressCardInput } from "./plan-compaction-state.js";
import { isJsonObject, type CodexTurnStartResponse } from "./protocol.js";
import { readRecentCodexRateLimits } from "./rate-limit-cache.js";
import { readBoundedCodexRemoteWorkspaceFile } from "./remote-workspace-media.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import {
  codexTranscriptMirrorRuntime,
  createCodexAppServerUserMessagePersistenceNotifier,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { buildCodexUserInput } from "./user-input.js";

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
    bindingStore,
    bindingIdentity,
    sessionAgentId,
    sandboxSessionKey,
    contextSessionKey,
    effectiveCwd,
  } = connection;
  const { dynamicToolParams, compactionPlanState, computerContextEpoch, toolBridge } = attemptTools;
  const { state, userInputBridgeRef, steeringQueueRef, turnWatches, completeTurn, interruptTurn } =
    turnRuntime;
  const { turnIdRef } = turnRuntime;
  const { emitExecutionPhaseOnce, emitLifecycleStart, maybeAnnounceFastModeAutoOff } = lifecycle;
  const { enqueueNotification } = notifications;
  const activeTurnId = turn.turn.id;
  const authoritySourceRef = attemptTools.scheduledAppAuthoritySourceRef;
  if (resourceState.thread.pluginAppPolicyContext) {
    authoritySourceRef.current = {
      client: resourceState.client,
      threadId: resourceState.thread.threadId,
      policyContext: resourceState.thread.pluginAppPolicyContext,
      configCwd: effectiveCwd,
    };
  }
  turnIdRef.current = activeTurnId;
  resourceState.nativeSubagentMonitor?.bindTurn(activeTurnId);
  const progressCardTool = toolBridge.availableTools.find((tool) => tool.name === "progress_card");
  let nativePlanUpdateOrdinal = 0;
  const prepareNativeMcpAppResultDetails = createCodexNativeMcpAppResultDetailsPreparer({
    client: resourceState.client,
    threadId: resourceState.thread.threadId,
    attempt: dynamicToolParams,
  });
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
      initialContextTokens: connection.mutable.startupContextTokens,
      nativePostToolUseRelayEnabled:
        resourceState.nativeHookRelay?.allowedEvents.includes("post_tool_use") === true &&
        resourceState.nativeHookRelay.shouldRelayEvent("post_tool_use"),
      asyncUserMessageAllowed:
        params.disableTools !== true &&
        (params.toolsAllow === undefined ||
          toolBridge.availableTools.some((tool) => tool.name === "message")),
      onAsyncDelivery: async (delivery) => {
        return await codexTranscriptMirrorRuntime.deliverAsyncMessageBestEffort({
          params: dynamicToolParams,
          cwd: effectiveCwd,
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          ...delivery,
        });
      },
      readRecentRateLimits: () => readRecentCodexRateLimits(resourceState.client),
      runAbortSignal: runAbortController.signal,
      remoteWorkspaceRoot: connection.appServer.remoteWorkspaceRoot,
      remoteWorkspaceRequestTimeoutMs: connection.appServer.requestTimeoutMs,
      readRemoteWorkspaceFile: ({ path, maxBytes, signal, timeoutMs }) =>
        readBoundedCodexRemoteWorkspaceFile({
          client: resourceState.client,
          path,
          maxBytes,
          signal,
          timeoutMs,
        }),
      trajectoryRecorder,
      resolveDynamicToolResultContentSource: toolBridge.resultContentSourceForTool,
      onNativeToolResultRecorded: maybeAnnounceFastModeAutoOff,
      ...(progressCardTool
        ? {
            onNativePlanUpdate: async (update: {
              markdown?: string;
              steps: Array<{
                step: string;
                status: "pending" | "in_progress" | "completed";
              }>;
            }) => {
              nativePlanUpdateOrdinal += 1;
              try {
                const input = canonicalizeNativeProgressCardInput(update);
                await progressCardTool.execute(
                  `codex-native-plan:${activeTurnId}:${nativePlanUpdateOrdinal}`,
                  input,
                  runAbortController.signal,
                );
              } catch (error) {
                embeddedAgentLog.warn("failed to persist native Codex plan to progress card", {
                  runId: params.runId,
                  threadId: resourceState.thread.threadId,
                  error: formatErrorMessage(error),
                });
              }
            },
          }
        : {}),
      ...(prepareNativeMcpAppResultDetails ? { prepareNativeMcpAppResultDetails } : {}),
      upstreamUserText: turnState.codexTurnPromptText,
      onContextCompacted: async () => {
        computerContextEpoch.value += 1;
        delete computerContextEpoch.frameToolCallId;
        delete computerContextEpoch.frameImageIdentity;
        try {
          await compactionPlanState.restore({
            client: resourceState.client,
            threadId: resourceState.thread.threadId,
            timeoutMs: connection.appServer.requestTimeoutMs,
            signal: runAbortController.signal,
          });
        } catch (error) {
          embeddedAgentLog.warn("failed to restore Codex plan state after compaction", {
            runId: params.runId,
            threadId: resourceState.thread.threadId,
            error: formatErrorMessage(error),
          });
        }
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
  const notifyUserMessagePersisted = createCodexAppServerUserMessagePersistenceNotifier(params);
  // Buffered async items can persist immediately when the route opens. Commit
  // their owning user admission first so durable history stays chronological.
  const promptMirrorPromise = mirrorPromptAtTurnStartBestEffort({
    params,
    agentId: sessionAgentId,
    notifyUserMessagePersisted,
    sessionKey: sandboxSessionKey,
    cwd: effectiveCwd,
    threadId: resourceState.thread.threadId,
    turnId: activeTurnId,
    upstreamUserText: turnState.codexTurnPromptText,
  });
  await promptMirrorPromise;
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
    if (!isJsonObject(turn.turn)) {
      throw new Error("Codex turn completion payload is not a JSON object");
    }
    await enqueueNotification(
      {
        method: "turn/completed",
        params: {
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          turn: turn.turn,
        },
      },
      { threadId: resourceState.thread.threadId, turnId: activeTurnId },
    );
  }
  const assertSteeringActive = () => {
    params.hostCapabilities.assertActive();
    runAbortController.signal.throwIfAborted();
    if (state.completed || state.terminalTurnNotificationQueued || state.timedOut) {
      throw new Error("codex app-server turn is no longer accepting steering");
    }
  };
  const workspaceOnly = resolveAttemptFsWorkspaceOnly({ config: params.config, sessionAgentId });
  const imageContext = {
    workspaceDir: connection.effectiveWorkspace,
    model: params.model,
    config: params.config,
    workspaceOnly,
    localRoots: workspaceOnly
      ? undefined
      : getAgentScopedMediaLocalRoots(params.config ?? {}, sessionAgentId),
    sandbox:
      connection.sandbox?.enabled && connection.sandbox.fsBridge
        ? { root: connection.sandbox.workspaceDir, bridge: connection.sandbox.fsBridge }
        : undefined,
  };
  const activeSteeringQueue = createCodexSteeringQueue({
    client: resourceState.client,
    threadId: resourceState.thread.threadId,
    turnId: activeTurnId,
    requestTimeoutMs: connection.appServer.requestTimeoutMs,
    signal: runAbortController.signal,
    assertActive: assertSteeringActive,
    prepareMessage: async (text, options) => {
      const result = await detectAndLoadAgentHarnessPromptImages({
        ...imageContext,
        prompt: text,
        existingImages: options.images,
        imageOrder: options.imageOrder,
        media: options.media,
        userTurnTranscriptRecorder: options.userTurnTranscriptRecorder,
      });
      if (result.failedMediaCount) {
        throw new Error(
          `failed to hydrate ${result.failedMediaCount} structured image attachment(s) for Codex steering`,
        );
      }
      return buildCodexUserInput(text, result.images);
    },
    beforeConfirmConsumed: async (items) => {
      const inboundItems = items.filter((item) => item.isInboundUserMessage === true);
      if (inboundItems.length === 0) {
        return;
      }
      await promptMirrorPromise;
      const messages = activeProjector.buildSteeringTranscriptPrefix();
      if (params.sessionTarget && messages.length > 0) {
        await codexTranscriptMirrorRuntime.mirror({
          agentId: sessionAgentId,
          sessionKey: contextSessionKey,
          sessionId: params.sessionId,
          storePath: params.sessionTarget.storePath,
          cwd: effectiveCwd,
          messages,
          idempotencyScope: `codex-app-server:${resourceState.thread.threadId}`,
          runId: params.runId,
          runMirrorIdentityPrefix: `${activeTurnId}:`,
          config: params.config,
        });
        activeProjector.markSteeringTranscriptPersisted();
      }
      for (const item of inboundItems) {
        const recorder = item.userTurnTranscriptRecorder;
        if (!recorder) {
          continue;
        }
        await recorder.persistApproved();
        if (!recorder.hasPersisted()) {
          throw new Error("Codex consumed steering before its user turn was persisted");
        }
      }
    },
  });
  steeringQueueRef.current = activeSteeringQueue;
  const claimPendingUserInputAnswer = async (
    text: string,
    optionsLocal?: CodexSteeringQueueOptions,
  ) => {
    if (optionsLocal?.isInboundUserMessage !== true || hasPromptImageInput(optionsLocal)) {
      return false;
    }
    assertSteeringActive();
    return await claimPendingAgentQuestionAnswer({
      sessionKey: params.sessionKey ?? params.sessionId,
      text,
      persist: optionsLocal.userTurnTranscriptRecorder
        ? async () => {
            await optionsLocal.userTurnTranscriptRecorder?.persistApproved();
          }
        : undefined,
    });
  };
  const cancelPendingUserInput = (resolvedBy: string) =>
    cancelPendingAgentQuestionForSession({
      sessionKey: params.sessionKey ?? params.sessionId,
      resolvedBy,
    });
  const queueMessage = async (text: string, optionsLocal?: CodexSteeringQueueOptions) => {
    if (await claimPendingUserInputAnswer(text, optionsLocal)) {
      // A question claim is already consumption. Closing the run during its
      // response must not turn that answer into a rejected, replayable steer.
      optionsLocal?.onQueueAccepted?.(true);
      return undefined;
    }
    if (optionsLocal?.isInboundUserMessage === true && hasPromptImageInput(optionsLocal)) {
      assertSteeringActive();
      try {
        await cancelPendingUserInput("image-reply");
      } catch (error) {
        // Cleanup failure must not drop the user's image turn.
        embeddedAgentLog.warn("failed to cancel codex gateway question before image steering", {
          error,
        });
      }
    }
    try {
      await activeSteeringQueue.queue(text, optionsLocal);
    } catch (error) {
      if (error instanceof CodexSteeringAcceptedUnconfirmedError) {
        return {
          transcriptCommit: "unconfirmed" as const,
          errorMessage: formatErrorMessage(error),
        };
      }
      throw error;
    }
    return undefined;
  };
  const handle = {
    kind: "embedded" as const,
    runId: params.runId,
    startedAtMs: params.startedAtMs,
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    claimPendingUserInputAnswer,
    cancelPendingUserInput,
    queueMessage,
    messageInjection: {
      isAvailable: () =>
        !state.completed &&
        !state.terminalTurnNotificationQueued &&
        !state.timedOut &&
        !runAbortController.signal.aborted,
      queueMessage,
    },
    isStreaming: () => !state.completed && !runAbortController.signal.aborted,
    isAborted: () => runAbortController.signal.aborted,
    isStopped: () => state.completed || state.timedOut || runAbortController.signal.aborted,
    isAbortable: () =>
      !terminalState.terminalOutcomeFrozen || terminalState.sharedAbortAllowedAfterTerminalOutcome,
    isCompacting: () => projectorRef.current?.isCompacting() ?? false,
    // queueMessage resolves only after Codex echoes the steered userMessage completion.
    // Gateway-owned turns rely on that boundary before finalizing adoption.
    supportsTranscriptCommitWait: true,
    supportsQueueMessageImages: params.model.input.includes("image"),
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    cancel: () => abortExplicitly("cancelled"),
    abort: () => abortExplicitly("aborted"),
  };
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
      })().finally(completeTurn);
      return;
    }
    const interrupted = interruptTurn(activeTurnId);
    if (terminalState.explicitCancellationObserved) {
      // turn/completed ends the turn, not its native background terminals.
      // Keep this attempt's route and lease until thread-scoped cleanup settles.
      state.abortCleanup = interrupted.then(async (confirmed) => {
        if (!confirmed) {
          throw new Error(
            "Codex cancellation could not confirm the turn stopped; background terminals may still be running.",
          );
        }
        await terminateCodexBackgroundTerminals(
          resourceState.client,
          resourceState.thread.threadId,
        );
      });
    }
    const cancellation = terminalState.explicitCancellationObserved
      ? state.abortCleanup
      : interrupted;
    void cancellation.then(completeTurn, (error: unknown) => {
      embeddedAgentLog.warn("codex app-server cancellation cleanup failed", { error });
      completeTurn();
    });
  };
  return {
    activeTurnId,
    activeProjector,
    streamState,
    handle,
    notifyUserMessagePersisted,
    abortListener,
    publishActiveOwnership: () => {
      params.replyOperation?.attachBackend(handle);
      setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
      runAbortController.signal.addEventListener("abort", abortListener, { once: true });
      if (runAbortController.signal.aborted) {
        abortListener();
      }
    },
  };
}

export type CodexAttemptActiveTurn = Awaited<ReturnType<typeof activateCodexAttemptTurn>>;
