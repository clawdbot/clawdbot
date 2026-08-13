import {
  assembleHarnessContextEngine,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  embeddedAgentLog,
  formatErrorMessage,
  resolveAgentHarnessBeforePromptBuildResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildCodexSystemPromptReport,
  prependCodexOpenClawPromptContext,
  readContextEngineThreadBootstrapProjection,
  resolveCodexDeliveryHintPreservedInputRange,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import {
  fitCodexAdditionalContextForTurnStart,
  fitCodexTurnStartText,
  projectContextEngineAssemblyForCodex,
} from "./context-engine-projection.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import type { CodexAttemptContext } from "./run-attempt-context.js";
import { estimateCodexAppServerProjectedTurnTokens } from "./run-attempt-lifecycle.js";
import {
  isNonEmptyString,
  joinPresentSections,
  prependCurrentInboundContext,
} from "./run-attempt-state.js";
import { rotateOversizedCodexAppServerStartupBinding } from "./startup-binding.js";
import {
  buildContextEngineBinding,
  buildTurnCollaborationMode,
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-lifecycle.js";

function isRestrictivePromptToolsAllow(toolsAllow: string[] | undefined): boolean {
  return toolsAllow !== undefined && !toolsAllow.some((name) => name.trim() === "*");
}

export async function prepareCodexAttemptPrompt(context: CodexAttemptContext) {
  const {
    runtime,
    attemptTools,
    historyState,
    hookContext,
    workspaceBootstrapContext,
    buildActiveContextEngineRuntimeContext,
    baseDeveloperInstructions,
    openClawPromptContext,
    skillsCollaborationInstructions,
    promptState,
    codexContextProjectionMaxChars,
  } = context;
  const {
    connection,
    buildActiveRunAttemptParams,
    effectiveContextTokenBudget,
    effectiveRuntimeModelId,
    effectiveRuntimeProviderId,
  } = runtime;
  const {
    params,
    activeContextEngine,
    usesSupervisionConnection,
    mutable,
    isInactiveThreadBootstrapBinding,
    bindingStore,
    bindingIdentity,
    agentDir,
    appServer,
    contextSessionKey,
    effectiveWorkspace,
    sandbox,
  } = connection;
  const { toolBridge } = attemptTools;
  const applyFreshThreadContinuityProjection = () => {
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: historyState.messages,
      originalHistoryMessages: historyState.messages,
      prompt: params.prompt,
      maxRenderedContextChars: codexContextProjectionMaxChars,
    });
    promptState.promptText = projection.promptText;
    promptState.additionalContext = projection.additionalContext;
    promptState.prePromptMessageCount = projection.prePromptMessageCount;
  };
  const applyActiveContextEngineProjection = async (
    decisionStartupBinding: typeof mutable.startupBinding,
  ) => {
    if (!activeContextEngine) {
      return;
    }
    const assembled = await assembleHarnessContextEngine({
      contextEngine: activeContextEngine,
      sessionId: runtime.activeSessionId,
      sessionKey: contextSessionKey,
      messages: historyState.messages,
      tokenBudget: effectiveContextTokenBudget,
      availableTools: new Set(
        flattenCodexDynamicToolFunctions(toolBridge.availableSpecs)
          .map((tool) => tool.name)
          .filter(isNonEmptyString),
      ),
      citationsMode: params.config?.memory?.citations,
      sandboxed: sandbox?.enabled === true,
      modelId: effectiveRuntimeModelId,
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
      providerId: effectiveRuntimeProviderId,
      requestedModelId: usesSupervisionConnection ? undefined : params.requestedModelId,
      fallbackReason: usesSupervisionConnection ? undefined : params.fallbackReason,
      degradedReason: usesSupervisionConnection ? undefined : params.degradedReason,
      runtimeContext: buildActiveContextEngineRuntimeContext(),
      transcriptReadFence: params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
      prompt: params.prompt,
    });
    if (!assembled) {
      throw new Error("context engine assemble returned no result");
    }
    const contextEngineProjection = readContextEngineThreadBootstrapProjection(
      assembled.contextProjection,
    );
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: assembled.messages,
      originalHistoryMessages: historyState.messages,
      prompt: params.prompt,
      systemPromptAddition: assembled.systemPromptAddition,
      maxRenderedContextChars: codexContextProjectionMaxChars,
      toolPayloadMode: contextEngineProjection ? "preserve" : "elide",
    });
    const projectionDecision = contextEngineProjection
      ? resolveContextEngineBootstrapProjectionDecision({
          startupBinding: decisionStartupBinding,
          expectedBinding: buildContextEngineBinding(
            buildActiveRunAttemptParams(),
            contextEngineProjection,
          ),
          projection: contextEngineProjection,
          dynamicToolsFingerprint: codexDynamicToolsFingerprint(toolBridge.specs),
          legacyDynamicToolsFingerprint: codexLegacyDynamicToolsFingerprint(toolBridge.specs),
        })
      : { project: true, reason: "per-turn-projection" };
    const decisionBinding = decisionStartupBinding;
    embeddedAgentLog.info("codex app-server context-engine projection decision", {
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      engineId: activeContextEngine.info.id,
      mode: contextEngineProjection?.mode ?? assembled.contextProjection?.mode ?? "per_turn",
      epoch: contextEngineProjection?.epoch,
      fingerprint: contextEngineProjection?.fingerprint,
      previousThreadId: decisionBinding?.threadId,
      previousEpoch: decisionBinding?.contextEngine?.projection?.epoch,
      previousFingerprint: decisionBinding?.contextEngine?.projection?.fingerprint,
      projected: projectionDecision.project,
      reason: projectionDecision.reason,
      assembledMessages: assembled.messages.length,
      originalHistoryMessages: historyState.messages.length,
      projectedContextChars: projection.additionalContext?.length ?? 0,
      currentPromptChars: projection.promptText.length,
      developerInstructionAdditionChars: projection.developerInstructionAddition?.length ?? 0,
    });
    // Projection metadata and rendered prompt must advance together or retries can skip context.
    promptState.contextEngineProjection = contextEngineProjection;
    promptState.promptText = projectionDecision.project ? projection.promptText : params.prompt;
    promptState.additionalContext = projectionDecision.project
      ? projection.additionalContext
      : undefined;
    promptState.developerInstructions = joinPresentSections(
      baseDeveloperInstructions,
      projection.developerInstructionAddition,
    );
    promptState.prePromptMessageCount = projection.prePromptMessageCount;
  };
  if (activeContextEngine) {
    try {
      await applyActiveContextEngineProjection(
        runtime.nativeToolSurfaceEnabled ? mutable.startupBinding : undefined,
      );
    } catch (assembleErr) {
      embeddedAgentLog.warn("context engine assemble failed; using Codex baseline prompt", {
        error: formatErrorMessage(assembleErr),
      });
    }
  }
  const codexModelInputHistoryMessages: typeof historyState.messages = [];
  const buildPromptFromCurrentInputs = async () => {
    const inputPrompt = prependCurrentInboundContext(
      promptState.promptText,
      params.currentInboundContext,
    );
    const currentRequestText = params.transcriptPrompt?.trim() || params.prompt.trim();
    const currentRequestOffset = inputPrompt.lastIndexOf(currentRequestText);
    if (currentRequestOffset < 0) {
      throw new Error("Codex current request is not present in the prepared prompt");
    }
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: inputPrompt,
      developerInstructions: promptState.developerInstructions,
      messages: structuredClone(historyState.messages),
      ctx: hookContext,
      bootstrapContextRunKind: params.bootstrapContextRunKind,
    });
    if (isRestrictivePromptToolsAllow(result.toolsAllow)) {
      throw new Error(
        "Codex app-server cannot enforce before_prompt_build toolsAllow; use the embedded or Copilot runtime for turn-scoped tool policy.",
      );
    }
    const currentRequestRange = result.promptInputRange
      ? {
          start: result.promptInputRange.start + currentRequestOffset,
          end: result.promptInputRange.start + currentRequestOffset + currentRequestText.length,
        }
      : undefined;
    return { ...result, currentRequestRange };
  };
  const resolveShiftedPromptInputRange = (
    prompt: string,
    promptInputRange: { start: number; end: number } | undefined,
    turnPromptText: string,
  ): { start: number; end: number } | undefined => {
    if (
      !promptInputRange ||
      promptInputRange.start < 0 ||
      promptInputRange.end < promptInputRange.start ||
      promptInputRange.end > prompt.length ||
      !turnPromptText.endsWith(prompt)
    ) {
      return undefined;
    }
    const turnPromptOffset = turnPromptText.length - prompt.length;
    return {
      start: turnPromptOffset + promptInputRange.start,
      end: turnPromptOffset + promptInputRange.end,
    };
  };
  const decorateCodexTurnPromptText = (promptBuildResult: {
    prompt: string;
    promptInputRange?: { start: number; end: number };
    currentRequestRange?: { start: number; end: number };
  }) => {
    const turnPromptText = prependCodexOpenClawPromptContext(
      promptBuildResult.prompt,
      openClawPromptContext,
      {
        preservePromptWithoutContext:
          params.bootstrapContextMode === "lightweight" &&
          params.bootstrapContextRunKind === "cron",
      },
    );
    const currentRequestRange =
      resolveShiftedPromptInputRange(
        promptBuildResult.prompt,
        promptBuildResult.currentRequestRange,
        turnPromptText,
      ) ??
      resolveCodexDeliveryHintPreservedInputRange({
        prompt: promptBuildResult.prompt,
        promptInputRange: promptBuildResult.currentRequestRange,
        decoratedPrompt: turnPromptText,
      });
    if (!currentRequestRange) {
      throw new Error("Codex current request range was lost during prompt decoration");
    }
    const decoratedRequest = turnPromptText.slice(
      currentRequestRange.start,
      currentRequestRange.end,
    );
    const currentRequestHeader = "Current user request:\n";
    const currentRequest = decoratedRequest.startsWith(currentRequestHeader)
      ? decoratedRequest.slice(currentRequestHeader.length)
      : decoratedRequest;
    const surroundingContext = joinPresentSections(
      turnPromptText.slice(0, currentRequestRange.start),
      promptState.additionalContext,
      turnPromptText.slice(currentRequestRange.end),
    );
    const promptText = fitCodexTurnStartText({ promptText: currentRequest });
    return {
      promptText,
      additionalContext: fitCodexAdditionalContextForTurnStart({
        contextText: surroundingContext,
        currentRequestChars: promptText.length,
      }),
    };
  };
  const firstPromptBuild = await buildPromptFromCurrentInputs();
  const firstTurnPrompt = decorateCodexTurnPromptText(firstPromptBuild);
  const turnState = {
    promptBuild: firstPromptBuild,
    codexTurnPromptText: firstTurnPrompt.promptText,
    codexTurnAdditionalContext: firstTurnPrompt.additionalContext,
  };
  const buildRenderedCodexDeveloperInstructions = () =>
    joinPresentSections(
      turnState.promptBuild.developerInstructions,
      buildTurnCollaborationMode(params, {
        turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
        skillsCollaborationInstructions,
        memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
      }).settings.developer_instructions ?? undefined,
    );
  const rebuildCodexPromptBuildFromCurrentProjection = async () => {
    turnState.promptBuild = await buildPromptFromCurrentInputs();
    const turnPrompt = decorateCodexTurnPromptText(turnState.promptBuild);
    turnState.codexTurnPromptText = turnPrompt.promptText;
    turnState.codexTurnAdditionalContext = turnPrompt.additionalContext;
  };
  const rebuildCodexTurnPromptTextFromCurrentProjection = async () => {
    const nextPromptBuild = await buildPromptFromCurrentInputs();
    turnState.promptBuild = {
      ...turnState.promptBuild,
      prompt: nextPromptBuild.prompt,
      promptInputRange: nextPromptBuild.promptInputRange,
    };
    const turnPrompt = decorateCodexTurnPromptText(nextPromptBuild);
    turnState.codexTurnPromptText = turnPrompt.promptText;
    turnState.codexTurnAdditionalContext = turnPrompt.additionalContext;
  };
  const selectNewerVisibleHistoryAfterBinding = (
    binding: NonNullable<typeof mutable.startupBinding>,
  ) => {
    const cutoff = Date.parse(binding.historyCoveredThrough ?? "");
    return historyState.messages.filter((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        return false;
      }
      const record = message as unknown as Record<string, unknown>;
      const meta = record["__openclaw"];
      const mirrorIdentity =
        meta && typeof meta === "object" && !Array.isArray(meta)
          ? (meta as Record<string, unknown>).mirrorIdentity
          : undefined;
      const mirrorOrigin =
        meta && typeof meta === "object" && !Array.isArray(meta)
          ? (meta as Record<string, unknown>).mirrorOrigin
          : undefined;
      const timestamp =
        typeof message.timestamp === "number"
          ? message.timestamp
          : typeof message.timestamp === "string"
            ? Date.parse(message.timestamp)
            : Number.NaN;
      return (
        !(
          typeof record.idempotencyKey === "string" &&
          record.idempotencyKey.startsWith("codex-app-server:")
        ) &&
        mirrorOrigin !== "codex-app-server" &&
        !(typeof mirrorIdentity === "string" && mirrorIdentity.startsWith("codex-app-server:")) &&
        Number.isFinite(timestamp) &&
        timestamp > (Number.isFinite(cutoff) ? cutoff : 0)
      );
    });
  };
  const applyResumeStaleBindingContinuityProjection = (
    binding: NonNullable<typeof mutable.startupBinding>,
  ) => {
    const newerVisibleMessages = selectNewerVisibleHistoryAfterBinding(binding);
    if (newerVisibleMessages.length === 0) {
      return false;
    }
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: newerVisibleMessages,
      originalHistoryMessages: historyState.messages,
      prompt: params.prompt,
      maxRenderedContextChars: codexContextProjectionMaxChars,
    });
    promptState.promptText = projection.promptText;
    promptState.additionalContext = projection.additionalContext;
    promptState.prePromptMessageCount = projection.prePromptMessageCount;
    return true;
  };
  const precomputeNoContextEngineStaleBindingProjection = () => {
    promptState.precomputedStaleBindingContinuityProjectionApplied = false;
    promptState.staleBindingContinuityForcedFreshStart = false;
    const binding = mutable.startupBinding;
    if (activeContextEngine || !binding?.threadId || binding.pendingSupervisionBranch) {
      return false;
    }
    if (isInactiveThreadBootstrapBinding(binding)) {
      promptState.inactiveThreadBootstrapBindingForcedFreshStart = true;
      return false;
    }
    const projected = applyResumeStaleBindingContinuityProjection(binding);
    promptState.precomputedStaleBindingContinuityProjectionApplied = projected;
    return projected;
  };
  const applyNoContextEngineContinuityProjection = (
    action: "started" | "resumed" | "forked",
    binding?: NonNullable<typeof mutable.startupBinding>,
  ) => {
    if (activeContextEngine || !historyState.messages.some((message) => message.role === "user")) {
      return false;
    }
    if (action === "resumed" && promptState.precomputedStaleBindingContinuityProjectionApplied) {
      return true;
    }
    if (action === "started" && promptState.staleBindingContinuityForcedFreshStart) {
      return true;
    }
    if (action === "started" && promptState.inactiveThreadBootstrapBindingForcedFreshStart) {
      return false;
    }
    if (action === "resumed" && binding) {
      return applyResumeStaleBindingContinuityProjection(binding);
    }
    if (action === "started") {
      applyFreshThreadContinuityProjection();
      return true;
    }
    return false;
  };
  if (precomputeNoContextEngineStaleBindingProjection()) {
    await rebuildCodexPromptBuildFromCurrentProjection();
  }
  const rotateStartupBindingForProjectedTurn = async () => {
    const binding = mutable.startupBinding;
    if (!binding?.threadId) {
      return;
    }
    const previousThreadId = binding.threadId;
    const hadInactiveThreadBootstrapBinding = isInactiveThreadBootstrapBinding(binding);
    const startupBindingResolution = await rotateOversizedCodexAppServerStartupBinding({
      binding,
      bindingStore,
      identity: bindingIdentity,
      sessionFile: params.sessionFile,
      agentDir,
      codexHome: appServer.start.env?.CODEX_HOME,
      config: params.config,
      contextEngineActive: Boolean(activeContextEngine),
      projectedTurnTokens: estimateCodexAppServerProjectedTurnTokens({
        prompt: joinPresentSections(
          turnState.codexTurnAdditionalContext,
          turnState.codexTurnPromptText,
        ),
        developerInstructions: buildRenderedCodexDeveloperInstructions(),
      }),
    });
    mutable.startupBinding = startupBindingResolution.binding;
    mutable.startupContextTokens = startupBindingResolution.startupContextTokens;
    if (mutable.startupBinding?.threadId) {
      return;
    }
    promptState.inactiveThreadBootstrapBindingForcedFreshStart = hadInactiveThreadBootstrapBinding;
    promptState.staleBindingContinuityForcedFreshStart =
      promptState.precomputedStaleBindingContinuityProjectionApplied &&
      !promptState.inactiveThreadBootstrapBindingForcedFreshStart;
    if (promptState.staleBindingContinuityForcedFreshStart) {
      applyFreshThreadContinuityProjection();
    }
    if (activeContextEngine) {
      promptState.contextEngineProjection = undefined;
      promptState.promptText = params.prompt;
      promptState.additionalContext = undefined;
      try {
        await applyActiveContextEngineProjection(undefined);
      } catch (assembleErr) {
        embeddedAgentLog.warn("context engine assemble failed; using Codex baseline prompt", {
          error: formatErrorMessage(assembleErr),
        });
      }
    }
    await rebuildCodexPromptBuildFromCurrentProjection();
    embeddedAgentLog.info("codex app-server rebuilt turn prompt after native thread rotation", {
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      previousThreadId,
      promptChars: turnState.codexTurnPromptText.length,
      developerInstructionChars: buildRenderedCodexDeveloperInstructions()?.length ?? 0,
    });
  };
  await rotateStartupBindingForProjectedTurn();
  const systemPromptReport = buildCodexSystemPromptReport({
    attempt: params,
    sessionKey: contextSessionKey,
    workspaceDir: effectiveWorkspace,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    workspaceBootstrapContext,
    skillsPrompt: skillsCollaborationInstructions ? (params.skillsSnapshot?.prompt ?? "") : "",
    tools: toolBridge.availableSpecs,
  });
  return {
    context,
    codexModelInputHistoryMessages,
    turnState,
    buildRenderedCodexDeveloperInstructions,
    rebuildCodexTurnPromptTextFromCurrentProjection,
    applyNoContextEngineContinuityProjection,
    systemPromptReport,
  };
}

export type CodexAttemptPrompt = Awaited<ReturnType<typeof prepareCodexAttemptPrompt>>;
