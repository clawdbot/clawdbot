import type {
  AgentHarnessAttemptParamsV2,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  closeCodexStartupClientBestEffort,
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import type { CodexSystemPromptReport } from "./attempt-context.js";
import { attemptTerminal } from "./attempt-terminal.js";
import { createCodexAppServerRealtimeVoiceBridge } from "./realtime-voice-session.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { prepareCodexAttemptContext } from "./run-attempt-context.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { prepareCodexAttemptPrompt } from "./run-attempt-prompt.js";
import { prepareCodexAttemptResources } from "./run-attempt-resources.js";
import { prepareCodexAttemptRuntime } from "./run-attempt-runtime.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import { startCodexAttemptRuntime } from "./run-attempt-start.js";
import { prepareCodexAttemptTools } from "./run-attempt-tool-setup.js";
import { createCodexAttemptTurnState } from "./run-attempt-turn-state.js";
import type { CodexRunAttemptOptions } from "./run-attempt-types.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";

function buildRealtimeAttemptResult(params: {
  attempt: AgentHarnessAttemptParamsV2;
  systemPromptReport?: CodexSystemPromptReport;
  failure?: Error;
}): AgentHarnessAttemptResult {
  const lastAssistant = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "NO_REPLY" }],
    api: "openai-chatgpt-responses" as const,
    provider: "openai",
    model:
      normalizeOptionalString(params.attempt.realtimeVoice?.request.providerConfig.model) ??
      "codex-realtime",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  return {
    terminal: attemptTerminal.normalize({
      promptError: params.failure,
      promptErrorSource: params.failure ? "prompt" : null,
    }),
    sessionIdUsed: params.attempt.sessionId,
    messagesSnapshot: [],
    assistantTexts: ["NO_REPLY"],
    toolMetas: [],
    lastAssistant,
    currentAttemptAssistant: lastAssistant,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    cloudCodeAssistFormatError: false,
    // A live native session may have completed tool calls before its transport failed.
    // Never let the outer retry path replay the whole voice session.
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...(params.systemPromptReport ? { systemPromptReport: params.systemPromptReport } : {}),
  } as AgentHarnessAttemptResult;
}

export async function runCodexAppServerRealtimeVoiceSession(
  params: AgentHarnessAttemptParamsV2,
  options: CodexRunAttemptOptions,
): Promise<AgentHarnessAttemptResult> {
  const realtimeVoice = params.realtimeVoice;
  if (!realtimeVoice) {
    throw new Error("Codex realtime attempt requires bridge context");
  }
  const requestedFormat = realtimeVoice.request.audioFormat;
  if (
    requestedFormat &&
    (requestedFormat.encoding !== "pcm16" ||
      requestedFormat.sampleRateHz !== 24_000 ||
      requestedFormat.channels !== 1)
  ) {
    throw new Error("Codex realtime requires mono PCM16 audio at 24 kHz");
  }

  let connection: Awaited<ReturnType<typeof prepareCodexAttemptConnection>> | undefined;
  let attemptTools: Awaited<ReturnType<typeof prepareCodexAttemptTools>> | undefined;
  let resources: ReturnType<typeof prepareCodexAttemptResources> | undefined;
  let turnRuntime: ReturnType<typeof createCodexAttemptTurnState> | undefined;
  let bridge: ReturnType<typeof createCodexAppServerRealtimeVoiceBridge> | undefined;
  let systemPromptReport: CodexSystemPromptReport | undefined;
  const onAbort = () => bridge?.close();
  let detachRouteAbort: () => void = () => {};
  try {
    connection = await prepareCodexAttemptConnection({ params, options });
    const activeConnection = connection;
    const runtime = await prepareCodexAttemptRuntime(activeConnection);
    attemptTools = await prepareCodexAttemptTools(runtime);
    const attemptContext = await prepareCodexAttemptContext(runtime, attemptTools);
    const attemptPrompt = await prepareCodexAttemptPrompt(attemptContext);
    systemPromptReport = attemptPrompt.systemPromptReport;
    resources = prepareCodexAttemptResources(attemptPrompt);
    await startCodexAttemptRuntime(resources);
    const activeTurnRuntime = createCodexAttemptTurnState(resources);
    turnRuntime = activeTurnRuntime;
    const lifecycle = createCodexAttemptLifecycleController(resources, activeTurnRuntime);
    const serverRequests = createCodexAttemptServerRequestController(
      resources,
      activeTurnRuntime,
      lifecycle,
      { trackTurnActivity: false },
    );
    const { state } = resources;
    const activeBridge = createCodexAppServerRealtimeVoiceBridge(
      state.client,
      state.thread.threadId,
      realtimeVoice.request,
      activeConnection.runAbortController.signal,
    );
    bridge = activeBridge;
    activeConnection.runAbortController.signal.addEventListener("abort", onAbort, { once: true });
    resources.registerNativeSubagentMonitor(state.thread.threadId);
    const route = state.turnRoute;
    if (!route) {
      throw new Error("Codex realtime thread route was not reserved");
    }
    const onRouteAbort = () => activeBridge.handleRouteFailure(route.signal.reason);
    route.signal.addEventListener("abort", onRouteAbort, { once: true });
    detachRouteAbort = () => route.signal.removeEventListener("abort", onRouteAbort);
    let activeRequestTurnId: string | undefined;
    await route.activate({
      onNotification: (notification) => activeBridge.handleNotification(notification),
      onRequest: (request, scope, signal) => {
        if (scope.turnId && scope.turnId !== activeRequestTurnId) {
          activeTurnRuntime.userInputBridgeRef.current?.cancelPending();
          activeRequestTurnId = scope.turnId;
          activeTurnRuntime.turnIdRef.current = scope.turnId;
          activeTurnRuntime.userInputBridgeRef.current = createCodexUserInputBridge({
            paramsForRun: params,
            threadId: state.thread.threadId,
            turnId: scope.turnId,
            signal: activeConnection.runAbortController.signal,
          });
        }
        return serverRequests.handleServerRequest(request, scope, signal);
      },
    });
    state.routeActivated = true;
    realtimeVoice.onBridgeReady(activeBridge);
    const closeReason = await activeBridge.completion.promise;
    return buildRealtimeAttemptResult({
      attempt: params,
      systemPromptReport,
      ...(closeReason === "error"
        ? { failure: activeBridge.getFailure() ?? new Error("Codex realtime session failed") }
        : {}),
    });
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return buildRealtimeAttemptResult({ attempt: params, systemPromptReport });
    }
    throw error;
  } finally {
    detachRouteAbort();
    if (connection) {
      connection.runAbortController.signal.removeEventListener("abort", onAbort);
      params.abortSignal?.removeEventListener("abort", connection.abortFromUpstream);
    }
    if (resources) {
      const { state } = resources;
      await resources.runCleanupStep("codex-realtime-bridge-close", () => bridge?.close());
      await resources.runCleanupStep("codex-realtime-user-input-cancel", () =>
        turnRuntime?.userInputBridgeRef.current?.cancelPending(),
      );
      await resources.runCleanupStep("codex-realtime-turn-watch-clear", () =>
        turnRuntime?.turnWatches.clearAllTimers(),
      );
      await resources.runCleanupStep("codex-realtime-route-release", resources.releaseCurrentRoute);
      const nativeHookRelay = state.nativeHookRelay;
      state.nativeHookRelay = undefined;
      await resources.runCleanupStep("codex-realtime-native-hook-relay", () =>
        nativeHookRelay?.unregister(),
      );
      await resources.runCleanupStep("codex-realtime-thread-unsubscribe", async () => {
        if (!state.client || !state.thread) {
          return;
        }
        const released = await unsubscribeCodexThreadBestEffort(state.client, {
          threadId: state.thread.threadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        });
        if (!released) {
          await closeCodexStartupClientBestEffort(state.client);
        }
      });
      await resources.runCleanupStep("codex-realtime-scoped-mcp-dispose", () =>
        attemptTools?.scopedMcpTools?.dispose(),
      );
      await resources.runCleanupStep("codex-realtime-scheduled-mcp-dispose", () =>
        attemptTools?.scheduledConfiguredMcp?.dispose(),
      );
      await resources.runCleanupStep(
        "codex-realtime-sandbox-release",
        resources.releaseSandboxExecEnvironment,
      );
      await resources.runCleanupStep(
        "codex-realtime-shared-client-release",
        resources.releaseSharedClientLeaseOnce,
      );
    } else {
      try {
        await attemptTools?.scopedMcpTools?.dispose();
      } finally {
        await attemptTools?.scheduledConfiguredMcp?.dispose();
      }
    }
  }
}
