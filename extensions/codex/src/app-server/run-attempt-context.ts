import {
  bootstrapHarnessContextEngine,
  buildAgentHookContextChannelFields,
  buildHarnessContextEngineRuntimeContext,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  embeddedAgentLog,
  getAgentHarnessHookRunner,
  isHostScopedAgentToolActive,
  resolveContextEngineOwnerPluginId,
  runHarnessContextEngineMaintenance,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildCodexOpenClawPromptContext,
  buildCodexWatchedSessionsContext,
  buildCodexWorkspaceBootstrapContext,
  getCodexWorkspaceMemoryToolNames,
  readMirroredSessionHistoryMessages,
  renderCodexSkillsCollaborationInstructions,
} from "./attempt-context.js";
import {
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContextEngineProjectionReserveTokens,
  resolveCodexContinuityProjectionMaxChars,
  type CodexProjectedContextRange,
} from "./context-engine-projection.js";
import { isSystemAgentOnlyCodexDynamicToolAllowlist } from "./dynamic-tool-profile.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import { joinPresentSections } from "./run-attempt-state.js";
import type { CodexAttemptTools } from "./run-attempt-tool-setup.js";
import {
  CODEX_FROZEN_EMPTY_PROJECT_DOCS_AUTHORITY,
  CODEX_UNAVAILABLE_PROJECT_DOCS_AUTHORITY,
} from "./session-binding.js";
import {
  buildDeveloperInstructions,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";

export async function prepareCodexAttemptContext(
  runtime: CodexAttemptRuntime,
  attemptTools: CodexAttemptTools,
) {
  const {
    connection,
    runtimeParams,
    activeSessionId,
    activeSessionFile,
    buildActiveRunAttemptParams,
    effectiveContextWindowInfo,
    effectiveContextTokenBudget,
    effectiveRuntimeProviderId,
    effectiveRuntimeModelId,
    hookChannelId,
    sandboxExecServerEnabled,
  } = runtime;
  const {
    params,
    sessionAgentId,
    contextSessionKey,
    activeContextEngine,
    initialStartupBindingHadInactiveThreadBootstrap,
    effectiveWorkspace,
    effectiveCwd,
    agentDir,
    usesSupervisionConnection,
    resolvedWorkspace,
    initialInactiveThreadBootstrapBindingForcedFreshStart,
    sandbox,
  } = connection;
  const { toolBridge } = attemptTools;
  const activeTranscriptTarget = {
    agentId: sessionAgentId,
    sessionFile: activeSessionFile,
    sessionId: activeSessionId,
    sessionKey: contextSessionKey,
    sessionTarget: params.sessionTarget,
  };
  const readFencedHistory = async () => {
    const transcriptReadFence = params.userTurnTranscriptRecorder?.getAdmissionReceipt();
    const messages = await readMirroredSessionHistoryMessages({
      ...activeTranscriptTarget,
      signal: connection.runAbortController.signal,
      ...(transcriptReadFence ? { admission: transcriptReadFence } : {}),
    });
    connection.runAbortController.signal.throwIfAborted();
    connection.assertCurrent();
    return messages;
  };
  const historyState = {
    messages:
      !activeContextEngine && initialStartupBindingHadInactiveThreadBootstrap
        ? []
        : ((await readFencedHistory()) ?? []),
  };
  const hadSessionTranscriptState = historyState.messages.length > 0;
  const hookContextWindowFields = {
    ...(effectiveContextWindowInfo?.tokens
      ? { contextTokenBudget: effectiveContextWindowInfo.tokens }
      : effectiveContextTokenBudget
        ? { contextTokenBudget: effectiveContextTokenBudget }
        : {}),
    ...(effectiveContextWindowInfo?.source
      ? { contextWindowSource: effectiveContextWindowInfo.source }
      : {}),
    ...(effectiveContextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: effectiveContextWindowInfo.referenceTokens }
      : {}),
  };
  const hookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: contextSessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    trigger: params.trigger,
    ...buildAgentHookContextChannelFields({
      sessionKey: contextSessionKey,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      currentChannelId: hookChannelId,
      messageTo: params.messageTo,
      senderId: params.senderId,
      agentAccountId: params.agentAccountId,
    }),
    channelContext: params.channelContext,
    ...hookContextWindowFields,
  };
  const hookRunner = getAgentHarnessHookRunner();
  const buildActiveContextEngineRuntimeContext = () =>
    buildHarnessContextEngineRuntimeContext({
      attempt: buildActiveRunAttemptParams(),
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd,
      agentDir,
      activeAgentId: sessionAgentId,
      contextEnginePluginId: resolveContextEngineOwnerPluginId(activeContextEngine),
      tokenBudget: effectiveContextTokenBudget,
    });
  if (activeContextEngine) {
    await bootstrapHarnessContextEngine({
      hadSessionFile: hadSessionTranscriptState,
      contextEngine: activeContextEngine,
      sessionId: activeSessionId,
      sessionKey: contextSessionKey,
      sessionFile: activeSessionFile,
      sessionTarget: params.sessionTarget,
      runtimeContext: buildActiveContextEngineRuntimeContext(),
      transcriptReadFence: params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
      providerId: effectiveRuntimeProviderId,
      requestedModelId: usesSupervisionConnection ? undefined : params.requestedModelId,
      modelId: effectiveRuntimeModelId,
      fallbackReason: usesSupervisionConnection ? undefined : params.fallbackReason,
      degradedReason: usesSupervisionConnection ? undefined : params.degradedReason,
      runMaintenance: runHarnessContextEngineMaintenance,
      config: params.config,
      warn: (message) => embeddedAgentLog.warn(message),
    });
    historyState.messages = (await readFencedHistory()) ?? historyState.messages;
  }
  const memoryToolNames = getCodexWorkspaceMemoryToolNames(toolBridge.availableSpecs);
  const ringZeroActive =
    isHostScopedAgentToolActive("openclaw") &&
    isSystemAgentOnlyCodexDynamicToolAllowlist(runtimeParams.toolsAllow);
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params: runtimeParams,
    resolvedWorkspace: runtimeParams.bootstrapWorkspaceDir ?? resolvedWorkspace,
    executionWorkspace: effectiveWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sessionKey: contextSessionKey,
    sessionAgentId,
    memoryToolNames,
    ringZeroActive,
    sandboxed: sandbox?.enabled === true,
    // Only a process spawned by this Gateway attests native paths as host-local.
    // Loopback WebSockets and remoteWorkspaceRoot may still terminate elsewhere.
    nativeProjectInstructionSourcesHostLocal:
      connection.appServer.start.transport === "stdio" &&
      !connection.appServer.remoteWorkspaceRoot &&
      !(sandbox?.enabled === true && sandboxExecServerEnabled),
  });
  // Once Codex reports the exact sources that established a same-workspace thread,
  // replay that frozen binding with rediscovery disabled on every cold load.
  const startupBinding = connection.mutable.startupBinding;
  const nativeProjectInstructionSnapshotAllowed =
    workspaceBootstrapContext.agentWorkspaceDeveloperInstructionsAllowed &&
    !workspaceBootstrapContext.nativeProjectDocNeedsOpenClawCarrier &&
    workspaceBootstrapContext.nativeProjectInstructionSnapshotAllowed;
  const storedBindingInstructions = startupBinding?.agentWorkspaceDeveloperInstructions;
  const storedReplayableNativeProjectInstructions =
    !workspaceBootstrapContext.nativeProjectDocNeedsOpenClawCarrier &&
    storedBindingInstructions !== undefined &&
    storedBindingInstructions !== CODEX_UNAVAILABLE_PROJECT_DOCS_AUTHORITY
      ? storedBindingInstructions
      : undefined;
  const storedAgentWorkspaceDeveloperInstructions =
    workspaceBootstrapContext.nativeProjectDocNeedsOpenClawCarrier
      ? storedBindingInstructions
      : storedReplayableNativeProjectInstructions;
  const captureNativeProjectInstructions =
    nativeProjectInstructionSnapshotAllowed &&
    storedAgentWorkspaceDeveloperInstructions === undefined;
  // Environment-owned sources may be unavailable to the Gateway, but only the
  // native lifecycle response can distinguish that from an empty selection.
  const projectInstructionsUnavailableToGateway =
    workspaceBootstrapContext.agentWorkspaceDeveloperInstructionsAllowed &&
    !workspaceBootstrapContext.nativeProjectDocNeedsOpenClawCarrier &&
    !workspaceBootstrapContext.nativeProjectInstructionSnapshotAllowed &&
    storedReplayableNativeProjectInstructions === undefined;
  const nativeProjectDocsDisabledOnResume =
    !workspaceBootstrapContext.nativeProjectDocNeedsOpenClawCarrier &&
    storedAgentWorkspaceDeveloperInstructions !== undefined;
  const agentWorkspaceDeveloperInstructions =
    workspaceBootstrapContext.agentWorkspaceDeveloperInstructionsAllowed
      ? storedAgentWorkspaceDeveloperInstructions !== undefined
        ? (storedAgentWorkspaceDeveloperInstructions ?? undefined)
        : workspaceBootstrapContext.agentWorkspaceDeveloperInstructions
      : undefined;
  const frozenNativeProjectInstructions = nativeProjectDocsDisabledOnResume
    ? (agentWorkspaceDeveloperInstructions ?? CODEX_FROZEN_EMPTY_PROJECT_DOCS_AUTHORITY)
    : undefined;
  const currentAgentWorkspaceDeveloperInstructions =
    workspaceBootstrapContext.agentWorkspaceDeveloperInstructionsAllowed
      ? nativeProjectDocsDisabledOnResume
        ? undefined
        : workspaceBootstrapContext.nativeProjectDocNeedsOpenClawCarrier ||
            workspaceBootstrapContext.threadDeveloperInstructions === undefined
          ? agentWorkspaceDeveloperInstructions
          : workspaceBootstrapContext.threadDeveloperInstructions
      : undefined;
  const baseDeveloperInstructions = joinPresentSections(
    buildDeveloperInstructions(runtimeParams, {
      dynamicTools: toolBridge.availableSpecs,
    }),
    currentAgentWorkspaceDeveloperInstructions,
  );
  const openClawPromptContext = buildCodexOpenClawPromptContext({
    params: runtimeParams,
    workspacePromptContext: workspaceBootstrapContext.promptContext,
    watchedSessionsContext: buildCodexWatchedSessionsContext({
      attempt: runtimeParams,
      dynamicTools: toolBridge.availableSpecs,
      sessionKey: contextSessionKey,
      sandboxed: sandbox?.enabled === true,
    }),
  });
  const skillsCollaborationInstructions = renderCodexSkillsCollaborationInstructions({
    attempt: runtimeParams,
    skillsPrompt: params.skillsSnapshot?.prompt,
  });
  const promptState = {
    promptText: params.prompt,
    promptContextRange: undefined as CodexProjectedContextRange | undefined,
    developerInstructions: baseDeveloperInstructions,
    prePromptMessageCount: historyState.messages.length,
    contextEngineProjection: undefined as CodexContextEngineThreadBootstrapProjection | undefined,
    precomputedStaleBindingContinuityProjectionApplied: false,
    staleBindingContinuityForcedFreshStart: false,
    // Set by the no-engine continuity appliers; gates calibration recording so a
    // dense direct or active-engine prompt can never persist a density sample
    // that later shrinks continuity history it did not measure.
    noEngineContinuityProjectionApplied: false,
    inactiveThreadBootstrapBindingForcedFreshStart:
      initialInactiveThreadBootstrapBindingForcedFreshStart,
  };
  const codexContextProjectionMaxChars = resolveCodexContextEngineProjectionMaxChars({
    contextTokenBudget: effectiveContextTokenBudget,
    reserveTokens: resolveCodexContextEngineProjectionReserveTokens(),
  });
  const codexContinuityProjectionMaxChars = resolveCodexContinuityProjectionMaxChars({
    contextTokenBudget: effectiveContextTokenBudget,
    calibration: connection.mutable.continuityCalibration,
  });
  return {
    runtime,
    attemptTools,
    activeTranscriptTarget,
    historyState,
    hookContext,
    hookContextWindowFields,
    hookRunner,
    buildActiveContextEngineRuntimeContext,
    workspaceBootstrapContext,
    agentWorkspaceDeveloperInstructions,
    captureNativeProjectInstructions,
    projectInstructionsUnavailableToGateway,
    nativeProjectDocsDisabledOnResume,
    frozenNativeProjectInstructions,
    baseDeveloperInstructions,
    openClawPromptContext,
    skillsCollaborationInstructions,
    promptState,
    codexContextProjectionMaxChars,
    codexContinuityProjectionMaxChars,
  };
}

export type CodexAttemptContext = Awaited<ReturnType<typeof prepareCodexAttemptContext>>;
