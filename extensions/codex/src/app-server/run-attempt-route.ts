import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import type { CodexThreadRouteReservation } from "./turn-router.js";

export async function prepareCodexAttemptRoute(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  notifications: CodexAttemptNotificationController,
  handleServerRequest: ReturnType<
    typeof createCodexAttemptServerRequestController
  >["handleServerRequest"],
) {
  const {
    prompt,
    state: resourceState,
    trajectoryRecorder,
    releaseCurrentRoute,
    registerNativeSubagentMonitor,
    activateNativePreToolUseFailureFallback,
    releaseSandboxExecEnvironment,
    releaseSharedClientLeaseOnce,
  } = resources;
  const { connection } = prompt.context.runtime;
  const { params, runAbortController, abortFromUpstream } = connection;
  const { state, turnIdRef, turnWatches } = turnRuntime;
  const { noteNotificationReceived, enqueueNotification } = notifications;
  const attachRouteAbort = (route: CodexThreadRouteReservation) => {
    const onAbort = () => {
      if (
        state.completed ||
        state.terminalTurnNotificationQueued ||
        runAbortController.signal.aborted
      ) {
        return;
      }
      const reasonText = formatErrorMessage(route.signal.reason);
      const closedClient = reasonText.includes("turn router closed");
      state.clientClosedPromptError = closedClient
        ? "codex app-server client closed before turn completed"
        : `codex app-server turn route closed before turn completed: ${reasonText}`;
      state.clientClosedAbort = closedClient;
      const activeTurnId = turnIdRef.current;
      if (activeTurnId) {
        trajectoryRecorder?.recordEvent("turn.client_closed", {
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
        });
      }
      embeddedAgentLog.warn(state.clientClosedPromptError, {
        threadId: resourceState.thread.threadId,
        turnId: activeTurnId,
      });
      runAbortController.abort(closedClient ? "client_closed" : "turn_route_closed");
      state.completed = true;
      turnWatches.clearAllTimers();
      state.resolveCompletion?.();
    };
    route.signal.addEventListener("abort", onAbort, { once: true });
    if (route.signal.aborted) {
      onAbort();
    }
    return () => route.signal.removeEventListener("abort", onAbort);
  };
  const ensureCurrentThreadRoute = async () => {
    if (resourceState.turnRoute?.threadId !== resourceState.thread.threadId) {
      releaseCurrentRoute();
      resourceState.turnRoute = resourceState.turnRouter.reserveThread({
        threadId: resourceState.thread.threadId,
      });
    }
    if (!resourceState.turnRoute) {
      throw new Error("codex app-server turn route was not reserved");
    }
    if (!resourceState.routeActivated) {
      if (!resourceState.nativeSubagentMonitor) {
        registerNativeSubagentMonitor(resourceState.thread.threadId);
      }
      resourceState.detachRouteAbort = attachRouteAbort(resourceState.turnRoute);
      await resourceState.turnRoute.activate({
        onNotificationReceived: noteNotificationReceived,
        onNotification: enqueueNotification,
        onRequest: handleServerRequest,
      });
      resourceState.routeActivated = true;
    }
    return resourceState.turnRoute;
  };
  try {
    await ensureCurrentThreadRoute();
  } catch (error) {
    activateNativePreToolUseFailureFallback();
    releaseCurrentRoute();
    resourceState.nativeHookRelay?.unregister();
    await releaseSandboxExecEnvironment();
    releaseSharedClientLeaseOnce();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
  return { ensureCurrentThreadRoute };
}
