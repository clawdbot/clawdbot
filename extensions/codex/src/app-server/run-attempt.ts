// Codex plugin module implements run attempt behavior.
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { activateCodexAttemptTurn } from "./run-attempt-active-turn.js";
import { cleanupCodexAttempt } from "./run-attempt-cleanup.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { prepareCodexAttemptContext } from "./run-attempt-context.js";
import { finalizeCodexAttempt } from "./run-attempt-finalize.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { createCodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import { prepareCodexAttemptPrompt } from "./run-attempt-prompt.js";
import { prepareCodexAttemptResources } from "./run-attempt-resources.js";
import { prepareCodexAttemptRoute } from "./run-attempt-route.js";
import { prepareCodexAttemptRuntime } from "./run-attempt-runtime.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import { startCodexAttemptRuntime } from "./run-attempt-start.js";
import { prepareCodexAttemptTools } from "./run-attempt-tool-setup.js";
import { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import { startCodexAttemptTurn } from "./run-attempt-turn-start.js";
import { createCodexAttemptTurnState } from "./run-attempt-turn-state.js";
import type { CodexRunAttemptOptions } from "./run-attempt-types.js";

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: CodexRunAttemptOptions,
): Promise<EmbeddedRunAttemptResult> {
  const connection = await prepareCodexAttemptConnection({ params, options });
  const runtime = await prepareCodexAttemptRuntime(connection);
  const attemptTools = await prepareCodexAttemptTools(runtime);
  const attemptContext = await prepareCodexAttemptContext(runtime, attemptTools);
  const attemptPrompt = await prepareCodexAttemptPrompt(attemptContext);
  const resources = prepareCodexAttemptResources(attemptPrompt);
  await startCodexAttemptRuntime(resources);

  const turnRuntime = createCodexAttemptTurnState(resources);
  const lifecycle = createCodexAttemptLifecycleController(resources, turnRuntime);
  const notifications = createCodexAttemptNotificationController(resources, turnRuntime, lifecycle);
  const serverRequests = createCodexAttemptServerRequestController(
    resources,
    turnRuntime,
    lifecycle,
  );
  const { ensureCurrentThreadRoute } = await prepareCodexAttemptRoute(
    resources,
    turnRuntime,
    notifications,
    serverRequests.handleServerRequest,
  );
  const turnRequest = await prepareCodexAttemptTurnRequest(
    resources,
    turnRuntime,
    ensureCurrentThreadRoute,
    notifications.waitForActiveNativeTurnCompletion,
  );
  const turnStart = await startCodexAttemptTurn(resources, turnRuntime, notifications, turnRequest);
  if ("result" in turnStart) {
    return turnStart.result;
  }
  const activeTurn = await activateCodexAttemptTurn(
    resources,
    turnRuntime,
    lifecycle,
    notifications,
    turnStart.turn,
  );

  try {
    return await finalizeCodexAttempt(
      resources,
      turnRuntime,
      lifecycle,
      notifications,
      turnRequest,
      activeTurn,
    );
  } finally {
    await cleanupCodexAttempt(resources, turnRuntime, lifecycle, turnRequest, activeTurn);
  }
}
