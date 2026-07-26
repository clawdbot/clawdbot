import {
  embeddedAgentLog,
  type AgentHarnessRuntimeArtifactBinding,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexStartupTimeoutMs } from "./attempt-timeouts.js";
import type { CodexAppServerClient } from "./client.js";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  buildCodexNativeHookRelayDisabledConfig,
  buildCodexNativeHookRelayConfig,
  CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS,
  createCodexNativeHookRelay,
  emitCodexNativePreToolUseFailureDiagnostic,
  type CodexNativePreToolUseFailure,
} from "./native-hook-relay.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type { CodexSandboxPolicy, CodexTurnEnvironmentParams } from "./protocol.js";
import type { CodexAttemptPrompt } from "./run-attempt-prompt.js";
import { releaseCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import {
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  retainSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle.js";
import { createCodexTrajectoryRecorder, type CodexHostTrajectoryRecorder } from "./trajectory.js";
import type { CodexAppServerTurnRouter, CodexThreadRouteReservation } from "./turn-router.js";

export function prepareCodexAttemptResources(prompt: CodexAttemptPrompt) {
  const { context, turnState, buildRenderedCodexDeveloperInstructions } = prompt;
  const { runtime, attemptTools } = context;
  const { connection, hookChannelId } = runtime;
  const {
    appServer,
    params,
    effectiveCwd,
    sessionAgentId,
    sandboxSessionKey,
    runAbortController,
    sandbox,
    options,
    nativeHookRelayEvents,
  } = connection;
  const { toolBridge } = attemptTools;
  const hostTrajectoryRecorder = (
    params as typeof params & { trajectoryRecorder?: CodexHostTrajectoryRecorder | null }
  ).trajectoryRecorder;
  const trajectoryRecorder = createCodexTrajectoryRecorder({
    attempt: params,
    cwd: effectiveCwd,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    prompt: turnState.codexTurnPromptText,
    trajectoryRecorder: hostTrajectoryRecorder,
    trajectorySessionFile: params.trajectorySessionFile,
    tools: toolBridge.availableSpecs,
    warn: (message, fields) => embeddedAgentLog.warn(message, fields),
  });
  const state = {
    client: undefined as unknown as CodexAppServerClient,
    thread: undefined as unknown as CodexAppServerThreadLifecycleBinding,
    runtimeArtifact: undefined as AgentHarnessRuntimeArtifactBinding | undefined,
    turnRouter: undefined as unknown as CodexAppServerTurnRouter,
    turnRoute: undefined as CodexThreadRouteReservation | undefined,
    routeActivated: false,
    detachRouteAbort: (() => undefined) as () => void,
    trajectoryEndRecorded: false,
    nativeHookRelay: undefined as NativeHookRelayRegistrationHandle | undefined,
    nativeSubagentMonitor: undefined as
      | ReturnType<typeof codexNativeSubagentMonitorRuntime.register>
      | undefined,
    nativePreToolUseFailureFallbackActive: false,
    nativePreToolUseFailureFallbackTerminalReason: undefined as
      | CodexNativePreToolUseFailure["disposition"]
      | undefined,
    releaseSharedClientLease: undefined as (() => void) | undefined,
    sharedCodexClientRetiredForOneShotCleanup: false,
    sandboxExecEnvironmentAcquired: false,
    codexEnvironmentSelection: undefined as CodexTurnEnvironmentParams[] | undefined,
    codexExecutionCwd: effectiveCwd,
    codexSandboxPolicy: undefined as CodexSandboxPolicy | undefined,
    restartContextEngineCodexThread: undefined as
      | (() => Promise<CodexAppServerThreadLifecycleBinding>)
      | undefined,
  };
  const pendingNativePreToolUseFailures: CodexNativePreToolUseFailure[] = [];
  const projectorRef: { current?: CodexAppServerEventProjector } = {};
  const emitNativePreToolUseFailure = (failure: CodexNativePreToolUseFailure) => {
    emitCodexNativePreToolUseFailureDiagnostic({
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      runId: params.runId,
      signal: runAbortController.signal,
      failure,
      ...(state.nativePreToolUseFailureFallbackActive
        ? {
            terminalReason:
              state.nativePreToolUseFailureFallbackTerminalReason ?? failure.disposition,
          }
        : {}),
    });
  };
  const flushPendingNativePreToolUseFailures = () => {
    for (const failure of pendingNativePreToolUseFailures.splice(0)) {
      emitNativePreToolUseFailure(failure);
    }
  };
  const activateNativePreToolUseFailureFallback = () => {
    if (!state.nativePreToolUseFailureFallbackActive) {
      state.nativePreToolUseFailureFallbackTerminalReason = runAbortController.signal.aborted
        ? resolveCodexToolAbortTerminalReason(runAbortController.signal)
        : undefined;
      state.nativePreToolUseFailureFallbackActive = true;
    }
    flushPendingNativePreToolUseFailures();
  };
  const releaseSharedClientLeaseOnce = () => {
    const release = state.releaseSharedClientLease;
    if (!release) {
      return;
    }
    state.releaseSharedClientLease = undefined;
    release();
  };
  const retireSharedCodexClientForOneShotCleanup = async () => {
    if (
      params.cleanupBundleMcpOnRunEnd !== true ||
      state.sharedCodexClientRetiredForOneShotCleanup
    ) {
      return;
    }
    state.sharedCodexClientRetiredForOneShotCleanup = true;
    const retired = clearSharedCodexAppServerClientIfCurrentAndUnclaimed(state.client);
    embeddedAgentLog.info("codex app-server one-shot cleanup checked shared client retirement", {
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      activeLeases: retired.activeLeases,
      pendingAcquires: retired.pendingAcquires,
      closed: retired.closed,
      matchedSharedClient: retired.found,
    });
    if (retired.closed) {
      await state.client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 });
    }
  };
  const releaseSharedClientLeaseAndRetireOneShotClient = async () => {
    releaseSharedClientLeaseOnce();
    await retireSharedCodexClientForOneShotCleanup();
  };
  const releaseSandboxExecEnvironment = async () => {
    if (state.sandboxExecEnvironmentAcquired) {
      state.sandboxExecEnvironmentAcquired = false;
      await releaseCodexSandboxExecServerEnvironment(sandbox);
    }
  };
  const unregisterNativeSubagentMonitor = () => {
    state.nativeSubagentMonitor?.unregister();
    state.nativeSubagentMonitor = undefined;
  };
  const registerNativeSubagentMonitor = (parentThreadId: string) => {
    unregisterNativeSubagentMonitor();
    state.nativeSubagentMonitor = codexNativeSubagentMonitorRuntime.register({
      client: state.client,
      parentThreadId,
      requesterSessionKey: params.sessionKey,
      taskRuntimeScope: params.agentHarnessTaskRuntimeScope,
      agentId: sessionAgentId,
      retainClient: () => retainSharedCodexAppServerClientIfCurrent(state.client),
    });
  };
  const releaseCurrentRoute = () => {
    state.detachRouteAbort();
    state.detachRouteAbort = () => undefined;
    state.turnRoute?.release();
    state.turnRoute = undefined;
    state.routeActivated = false;
    unregisterNativeSubagentMonitor();
  };
  const startupTimeoutMs = resolveCodexStartupTimeoutMs({
    timeoutMs: params.timeoutMs,
    timeoutFloorMs: options.startupTimeoutFloorMs,
  });
  const requesterChannel = params.messageChannel ?? params.messageProvider;
  const requester = {
    ...(requesterChannel ? { channel: requesterChannel } : {}),
    ...(params.agentAccountId ? { accountId: params.agentAccountId } : {}),
    ...(params.senderId ? { senderId: params.senderId } : {}),
    ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
    ...(params.memberRoleIds?.length ? { roleIds: [...params.memberRoleIds] } : {}),
  };
  const hasRequester = Object.keys(requester).length > 0;
  const buildNativeHookRelayFinalConfigPatch = (
    decision: { action: "resume"; binding: CodexAppServerThreadBinding } | { action: "start" },
  ) => {
    state.nativeHookRelay?.unregister();
    state.nativeHookRelay = createCodexNativeHookRelay({
      options: options.nativeHookRelay,
      generation:
        decision.action === "resume" ? decision.binding.nativeHookRelayGeneration : undefined,
      generationMismatchGraceMs:
        decision.action === "resume" && !decision.binding.nativeHookRelayGeneration
          ? CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS
          : undefined,
      events: nativeHookRelayEvents,
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      config: params.config,
      runId: params.runId,
      channelId: hookChannelId,
      ...(hasRequester ? { requester } : {}),
      attemptTimeoutMs: params.timeoutMs,
      startupTimeoutMs,
      turnStartTimeoutMs: params.timeoutMs,
      loopDetectionPreToolUseRelay: appServer.loopDetectionPreToolUseRelay,
      signal: runAbortController.signal,
      onPreToolUseFailure: (failure) => {
        const projector = projectorRef.current;
        if (projector) {
          projector.recordNativeToolPreToolUseFailure(failure);
        } else if (state.nativePreToolUseFailureFallbackActive) {
          emitNativePreToolUseFailure(failure);
        } else {
          pendingNativePreToolUseFailures.push(failure);
        }
      },
    });
    return {
      configPatch: state.nativeHookRelay
        ? buildCodexNativeHookRelayConfig({
            relay: state.nativeHookRelay,
            events: nativeHookRelayEvents,
            hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
            loopDetectionPreToolUseRelay: appServer.loopDetectionPreToolUseRelay,
          })
        : options.nativeHookRelay?.enabled === false
          ? buildCodexNativeHookRelayDisabledConfig()
          : undefined,
      nativeHookRelayGeneration: state.nativeHookRelay?.generation,
    };
  };
  return {
    prompt,
    trajectoryRecorder,
    state,
    projectorRef,
    pendingNativePreToolUseFailures,
    markTrajectoryEndRecorded: () => {
      state.trajectoryEndRecorded = true;
    },
    activateNativePreToolUseFailureFallback,
    releaseSharedClientLeaseOnce,
    releaseSharedClientLeaseAndRetireOneShotClient,
    releaseSandboxExecEnvironment,
    registerNativeSubagentMonitor,
    releaseCurrentRoute,
    startupTimeoutMs,
    buildNativeHookRelayFinalConfigPatch,
  };
}

export type CodexAttemptResources = ReturnType<typeof prepareCodexAttemptResources>;
