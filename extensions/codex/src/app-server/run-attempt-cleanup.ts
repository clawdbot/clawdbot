import {
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  runAgentCleanupStep,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
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
  } = resources;
  const { connection } = prompt.context.runtime;
  const { params, options, runAbortController } = connection;
  const { state, steeringQueueRef, userInputBridgeRef, turnWatches } = turnRuntime;
  const {
    maybeEmitFastModeAutoResetBestEffort,
    emitLifecycleTerminal,
    buildLifecycleTerminalMeta,
  } = lifecycle;
  const { codexModelCallDiagnostics } = requestRuntime;
  const { activeTurnId, abortListener, handle, freezeRunTerminalOutcome } = activeTurn;
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
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-trajectory-flush",
    log: embeddedAgentLog,
    cleanup: async () => trajectoryRecorder?.flush(),
  });
  if (!state.timedOut && !runAbortController.signal.aborted) {
    await steeringQueueRef.current?.flushPending();
  }
  if (!state.timedOut) {
    await unsubscribeCodexThreadBestEffort(resourceState.client, {
      threadId: resourceState.thread.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
  }
  userInputBridgeRef.current?.cancelPending();
  turnWatches.clearAllTimers();
  releaseCurrentRoute();
  await releaseSharedClientLeaseAndRetireOneShotClient();
  if (resourceState.nativeHookRelay) {
    if (state.shouldDelayNativeHookRelayUnregister) {
      // Native hook subprocesses can finish shortly after turn completion.
      scheduleCodexNativeHookRelayUnregister({
        relay: resourceState.nativeHookRelay,
        hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
      });
    } else {
      resourceState.nativeHookRelay.unregister();
    }
  }
  await releaseSandboxExecEnvironment();
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-scoped-mcp-dispose",
    log: embeddedAgentLog,
    cleanup: async () => {
      await prompt.context.attemptTools.scopedMcpTools?.dispose();
    },
  });
  runAbortController.signal.removeEventListener("abort", abortListener);
  steeringQueueRef.current?.cancel();
  freezeRunTerminalOutcome();
  params.replyOperation?.detachBackend(handle);
  clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
}
