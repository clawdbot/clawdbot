import { clearActiveEmbeddedRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { retainCodexAppServerLiveThread } from "./client-runtime.js";
import { resolveCodexAppServerClientInstanceId } from "./client.js";
import { scheduleCodexNativeHookRelayUnregister } from "./native-hook-relay.js";
import type { CodexAttemptActiveTurn } from "./run-attempt-active-turn.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

export async function cleanupCodexAttempt(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
  requestRuntime: Awaited<ReturnType<typeof prepareCodexAttemptTurnRequest>>,
  activeTurn: CodexAttemptActiveTurn,
) {
  const {
    prompt,
    state: resourceState,
    trajectoryRecorder,
    releaseCurrentRoute,
    releaseSharedClientLeaseAndRetireOneShotClient,
    releaseSandboxExecEnvironment,
    runCleanupStep,
  } = resources;
  const { connection } = prompt.context.runtime;
  const { params, options, runAbortController, terminalState, bindingStore, bindingIdentity } =
    connection;
  const { state, steeringQueueRef, userInputBridgeRef, turnWatches } = turnRuntime;
  const {
    maybeEmitFastModeAutoResetBestEffort,
    emitLifecycleTerminal,
    buildLifecycleTerminalMeta,
  } = lifecycle;
  const { codexModelCallDiagnostics } = requestRuntime;
  const { activeTurnId, abortListener, handle, freezeRunTerminalOutcome } = activeTurn;
  // Exact-thread cron authority exists only while this creator turn owns the
  // live client/thread. Retained model callbacks must fail after cleanup begins.
  prompt.context.attemptTools.scheduledAppAuthoritySourceRef.current = undefined;
  // Finalization can throw before freezing. Close cancellation admission before
  // any teardown await so it cannot replace the cleanup promise being joined.
  freezeRunTerminalOutcome();
  // Join late cancellation before releasing the subscription, but do not let a
  // failed terminal RPC skip resource cleanup. Surface that failure below.
  await state.abortCleanup.catch(() => undefined);
  try {
    steeringQueueRef.current?.cancel();
    if (params.isFinalFallbackAttempt !== false) {
      await maybeEmitFastModeAutoResetBestEffort();
    }
    codexModelCallDiagnostics.emitError(
      "codex app-server run completed without model-call terminal event",
    );
    emitLifecycleTerminal({
      phase: "error",
      error: "codex app-server run completed without lifecycle terminal event",
      ...buildLifecycleTerminalMeta({
        aborted: runAbortController.signal.aborted && !state.clientClosedAbort,
        timedOut: state.timedOut,
      }),
    });
    if (trajectoryRecorder && !resourceState.trajectoryEndRecorded) {
      trajectoryRecorder.recordEvent("session.ended", {
        status:
          state.timedOut || (runAbortController.signal.aborted && !state.clientClosedAbort)
            ? "interrupted"
            : "cleanup",
        threadId: resourceState.thread.threadId,
        turnId: activeTurnId,
        timedOut: state.timedOut,
        aborted: runAbortController.signal.aborted && !state.clientClosedAbort,
      });
    }
    await runCleanupStep("codex-trajectory-flush", () => trajectoryRecorder?.flush());
    const retainLiveIncognitoThread =
      terminalState.turnSucceeded && isIncognitoSessionKey(params.sessionKey);
    // Native-preserved and supervision threads have separate ownership and can
    // never enter the ordinary persistent warm-thread cache.
    const retainedPersistentThread =
      terminalState.turnSucceeded &&
      !isIncognitoSessionKey(params.sessionKey) &&
      params.cleanupBundleMcpOnRunEnd !== true &&
      resourceState.thread.liveThreadConfigFingerprint !== undefined &&
      resourceState.thread.clientId ===
        resolveCodexAppServerClientInstanceId(resourceState.client) &&
      resourceState.thread.preserveNativeModel !== true &&
      resourceState.thread.connectionScope !== "supervision" &&
      !resourceState.thread.ringZeroConfigFingerprint
        ? (await bindingStore.read(bindingIdentity))?.threadId === resourceState.thread.threadId &&
          (await bindingStore.withLease(bindingIdentity, async () => {
            // Reset/end uses this same generation lease. Never publish an old
            // active turn after its session binding has already been retired.
            if (
              (await bindingStore.read(bindingIdentity))?.threadId !== resourceState.thread.threadId
            ) {
              return false;
            }
            return await retainCodexAppServerLiveThread(
              resourceState.client,
              resourceState.thread.threadId,
              resourceState.thread.liveThreadOwnership?.release ??
                (async (threadId, assertCurrent) => {
                  const released = await unsubscribeCodexThreadBestEffort(resourceState.client, {
                    threadId,
                    timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
                    assertCurrent,
                  });
                  if (!released) {
                    assertCurrent?.();
                    await closeCodexStartupClientBestEffort(resourceState.client);
                    throw new CodexAppServerUnsafeSubscriptionError(
                      `Codex retained thread subscription could not be released: ${threadId}`,
                    );
                  }
                }),
              resourceState.thread.liveThreadConfigFingerprint,
              connection.mutable.pluginAppServer.serviceTier,
            );
          }))
        : false;
    // Codex keeps approvals in its native session; independent conversations
    // must retain their own subscriptions instead of evicting one another.
    const retainLiveThread = retainLiveIncognitoThread || retainedPersistentThread;
    const bindingReleased =
      isIncognitoSessionKey(params.sessionKey) && !retainLiveIncognitoThread
        ? await bindingStore.mutate(bindingIdentity, {
            kind: "clear",
            threadId: resourceState.thread.threadId,
          })
        : true;
    // Only explicitly retained live threads may skip the next thread/resume.
    if (!state.timedOut && !retainLiveThread) {
      // Clear first: if a newer owner won the binding, its live subscription must remain intact.
      if (bindingReleased) {
        const released = await unsubscribeCodexThreadBestEffort(resourceState.client, {
          threadId: resourceState.thread.threadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        });
        if (!released) {
          // Never reuse a client whose previous thread may still publish notifications.
          await closeCodexStartupClientBestEffort(resourceState.client);
        }
      }
    }
  } finally {
    await runCleanupStep("codex-user-input-cancel", () =>
      userInputBridgeRef.current?.cancelPending(),
    );
    await runCleanupStep("codex-turn-watch-clear", () => turnWatches.clearAllTimers());
    await runCleanupStep("codex-dynamic-tool-cleanup", async () => {
      const cleanupReason = terminalState.turnSucceeded
        ? "completion"
        : state.timedOut
          ? "timeout"
          : runAbortController.signal.aborted
            ? "cancel"
            : "error";
      const cleanups = prompt.context.attemptTools.runCleanups.splice(0);
      await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup(cleanupReason)));
    });
    await runCleanupStep("codex-route-release", releaseCurrentRoute);
    await runCleanupStep("codex-transcript-checkpoint", () =>
      activeTurn.activeProjector.transcriptCheckpoint.flush(true),
    );
    await runCleanupStep(
      "codex-shared-client-release",
      releaseSharedClientLeaseAndRetireOneShotClient,
    );
    const nativeHookRelay = resourceState.nativeHookRelay;
    resourceState.nativeHookRelay = undefined;
    await runCleanupStep("codex-native-hook-relay-release", () => {
      if (!nativeHookRelay) {
        return;
      }
      if (state.shouldDelayNativeHookRelayUnregister) {
        // Native hook subprocesses can finish shortly after turn completion.
        scheduleCodexNativeHookRelayUnregister({
          relay: nativeHookRelay,
          hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
        });
      } else {
        nativeHookRelay.unregister();
      }
    });
    await runCleanupStep("codex-sandbox-release", releaseSandboxExecEnvironment);
    await runCleanupStep("codex-scoped-mcp-dispose", () =>
      prompt.context.attemptTools.scopedMcpTools?.dispose(),
    );
    await runCleanupStep("codex-scheduled-mcp-dispose", () =>
      prompt.context.attemptTools.scheduledConfiguredMcp?.dispose(),
    );
    await runCleanupStep("codex-abort-listener-remove", () => {
      runAbortController.signal.removeEventListener("abort", abortListener);
    });
    await runCleanupStep("codex-steering-cancel", () => steeringQueueRef.current?.cancel());
    await runCleanupStep("codex-reply-backend-detach", () =>
      params.replyOperation?.detachBackend(handle),
    );
    await runCleanupStep("codex-active-run-clear", () => {
      clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
    });
  }
  await state.abortCleanup;
}
