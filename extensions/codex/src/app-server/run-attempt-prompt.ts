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
  fitCodexProjectedContextForTurnStart,
  projectContextEngineAssemblyForCodex,
  type CodexProjectedContextRange,
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

export async function prepareCodexAttemptPrompt(context: CodexAttemptContext) {
  const {
    runtime,
    attemptTools,
    historyState,
    hookContext,
    workspaceBootstrapContext,
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
    promptState.promptContextRange = projection.promptContextRange;
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
      projectedPromptChars: projection.promptText.length,
      developerInstructionAdditionChars: projection.developerInstructionAddition?.length ?? 0,
    });
    // Projection metadata and rendered prompt must advance together or retries can skip context.
    promptState.contextEngineProjection = contextEngineProjection;
    promptState.promptText = projectionDecision.project ? projection.promptText : params.prompt;
    promptState.promptContextRange = projectionDecision.project
      ? projection.promptContextRange
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
  const buildPromptFromCurrentInputs = () =>
    resolveAgentHarnessBeforePromptBuildResult({
      prompt: prependCurrentInboundContext(promptState.promptText, params.currentInboundContext),
      developerInstructions: promptState.developerInstructions,
      messages: structuredClone(historyState.messages),
      ctx: hookContext,
      bootstrapContextRunKind: params.bootstrapContextRunKind,
      ...("beforeAgentStartResult" in params
        ? { beforeAgentStartResult: params.beforeAgentStartResult }
        : {}),
    });
  const resolveShiftedPromptInputRange = (
    prompt: string,
    promptInputRange: { start: number; end: number } | undefined,
    turnPromptText: string,
  ): CodexProjectedContextRange | undefined => {
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
  const resolveShiftedPromptContextRange = (
    prompt: string,
    promptInputRange: { start: number; end: number } | undefined,
    turnPromptText: string,
  ) => {
    const promptTextInputOffset = promptInputRange
      ? promptInputRange.end - promptState.promptText.length
      : undefined;
    if (
      !promptState.promptContextRange ||
      !promptInputRange ||
      promptTextInputOffset === undefined ||
      promptInputRange.start < 0 ||
      promptInputRange.end < promptInputRange.start ||
      promptInputRange.end > prompt.length ||
      promptTextInputOffset < promptInputRange.start ||
      prompt.slice(promptTextInputOffset, promptInputRange.end) !== promptState.promptText ||
      !turnPromptText.endsWith(prompt)
    ) {
      return undefined;
    }
    const promptTextOffset = prompt.endsWith(promptState.promptText)
      ? prompt.length - promptState.promptText.length
      : promptTextInputOffset;
    if (promptTextOffset < 0) {
      return undefined;
    }
    const turnPromptOffset = turnPromptText.length - prompt.length + promptTextOffset;
    const contextRange = {
      start: turnPromptOffset + promptState.promptContextRange.start,
      end: turnPromptOffset + promptState.promptContextRange.end,
    };
    return {
      contextRange,
      requestRange: {
        start: contextRange.end,
        end: turnPromptOffset + promptState.promptText.length,
      },
    };
  };
  const decorateCodexTurnPromptText = (promptBuildResult: {
    prompt: string;
    promptInputRange?: { start: number; end: number };
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
    const projectedRanges = resolveShiftedPromptContextRange(
      promptBuildResult.prompt,
      promptBuildResult.promptInputRange,
      turnPromptText,
    );
    const preservedRange =
      resolveShiftedPromptInputRange(
        promptBuildResult.prompt,
        promptBuildResult.promptInputRange,
        turnPromptText,
      ) ??
      resolveCodexDeliveryHintPreservedInputRange({
        prompt: promptBuildResult.prompt,
        promptInputRange: promptBuildResult.promptInputRange,
        decoratedPrompt: turnPromptText,
      });
    return fitCodexProjectedContextForTurnStart({
      promptText: turnPromptText,
      contextRange: projectedRanges?.contextRange,
      requestRange: projectedRanges?.requestRange,
      preservedRange,
    });
  };
  const firstPromptBuild = await buildPromptFromCurrentInputs();
  const turnState = {
    promptBuild: firstPromptBuild,
    codexTurnPromptText: decorateCodexTurnPromptText(firstPromptBuild),
  };
  const buildRenderedCodexDeveloperInstructions = () =>
    joinPresentSections(
      turnState.promptBuild.developerInstructions,
      buildTurnCollaborationMode(params, {
        turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
        skillsCollaborationInstructions,
        memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
        heartbeatCollaborationInstructions:
          workspaceBootstrapContext.heartbeatCollaborationInstructions,
      }).settings.developer_instructions ?? undefined,
    );
  const rebuildCodexPromptBuildFromCurrentProjection = async () => {
    turnState.promptBuild = await buildPromptFromCurrentInputs();
    turnState.codexTurnPromptText = decorateCodexTurnPromptText(turnState.promptBuild);
  };
  const rebuildCodexTurnPromptTextFromCurrentProjection = async () => {
    const nextPromptBuild = await buildPromptFromCurrentInputs();
    turnState.promptBuild = {
      ...turnState.promptBuild,
      prompt: nextPromptBuild.prompt,
      promptInputRange: nextPromptBuild.promptInputRange,
    };
    turnState.codexTurnPromptText = decorateCodexTurnPromptText(nextPromptBuild);
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
    promptState.promptContextRange = projection.promptContextRange;
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
    mutable.startupBinding = await rotateOversizedCodexAppServerStartupBinding({
      binding,
      bindingStore,
      identity: bindingIdentity,
      sessionFile: params.sessionFile,
      agentDir,
      codexHome: appServer.start.env?.CODEX_HOME,
      config: params.config,
      contextEngineActive: Boolean(activeContextEngine),
      projectedTurnTokens: estimateCodexAppServerProjectedTurnTokens({
        prompt: turnState.codexTurnPromptText,
        developerInstructions: buildRenderedCodexDeveloperInstructions(),
      }),
    });
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
