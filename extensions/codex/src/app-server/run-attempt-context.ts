import {
  bootstrapHarnessContextEngine,
  buildHarnessContextEngineRuntimeContext,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  embeddedAgentLog,
  getAgentHarnessHookRunner,
  resolveContextEngineOwnerPluginId,
  runHarnessContextEngineMaintenance,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildCodexOpenClawPromptContext,
  buildCodexWorkspaceBootstrapContext,
  getCodexWorkspaceMemoryToolNames,
  readMirroredSessionHistoryMessages,
  renderCodexSkillsCollaborationInstructions,
} from "./attempt-context.js";
import {
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContextEngineProjectionReserveTokens,
  type CodexProjectedContextRange,
} from "./context-engine-projection.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import { joinPresentSections } from "./run-attempt-state.js";
import type { CodexAttemptTools } from "./run-attempt-tool-setup.js";
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
  } = runtime;
  const {
    params,
    sessionAgentId,
    contextSessionKey,
    activeContextEngine,
    initialStartupBindingHadInactiveThreadBootstrap,
    sandboxSessionKey,
    effectiveWorkspace,
    effectiveCwd,
    agentDir,
    usesSupervisionConnection,
    resolvedWorkspace,
    initialInactiveThreadBootstrapBindingForcedFreshStart,
  } = connection;
  const { toolBridge } = attemptTools;
  const activeTranscriptTarget = {
    agentId: sessionAgentId,
    sessionFile: activeSessionFile,
    sessionId: activeSessionId,
    sessionKey: contextSessionKey,
  };
  const historyState = {
    messages:
      !activeContextEngine && initialStartupBindingHadInactiveThreadBootstrap
        ? []
        : ((await readMirroredSessionHistoryMessages(activeTranscriptTarget)) ?? []),
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
    sessionKey: sandboxSessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider ?? undefined,
    trigger: params.trigger,
    channelId: hookChannelId,
    ...hookContextWindowFields,
  };
  const hookRunner = getAgentHarnessHookRunner();
  const activeContextEnginePluginId = activeContextEngine
    ? resolveContextEngineOwnerPluginId(activeContextEngine)
    : undefined;
  const buildActiveContextEngineRuntimeContext = () =>
    buildHarnessContextEngineRuntimeContext({
      attempt: buildActiveRunAttemptParams(),
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd,
      agentDir,
      activeAgentId: sessionAgentId,
      contextEnginePluginId: activeContextEnginePluginId,
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
    historyState.messages =
      (await readMirroredSessionHistoryMessages(activeTranscriptTarget)) ?? historyState.messages;
  }
  const memoryToolNames = getCodexWorkspaceMemoryToolNames(toolBridge.availableSpecs);
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params: runtimeParams,
    resolvedWorkspace,
    effectiveWorkspace,
    sessionKey: contextSessionKey,
    sessionAgentId,
    memoryToolNames,
  });
  const baseDeveloperInstructions = joinPresentSections(
    buildDeveloperInstructions(runtimeParams, { dynamicTools: toolBridge.availableSpecs }),
    workspaceBootstrapContext.developerInstructions,
  );
  const openClawPromptContext = buildCodexOpenClawPromptContext({
    params: runtimeParams,
    workspacePromptContext: workspaceBootstrapContext.promptContext,
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
    inactiveThreadBootstrapBindingForcedFreshStart:
      initialInactiveThreadBootstrapBindingForcedFreshStart,
  };
  const codexContextProjectionMaxChars = resolveCodexContextEngineProjectionMaxChars({
    contextTokenBudget: effectiveContextTokenBudget,
    reserveTokens: resolveCodexContextEngineProjectionReserveTokens({ config: params.config }),
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
    baseDeveloperInstructions,
    openClawPromptContext,
    skillsCollaborationInstructions,
    promptState,
    codexContextProjectionMaxChars,
  };
}

export type CodexAttemptContext = Awaited<ReturnType<typeof prepareCodexAttemptContext>>;
