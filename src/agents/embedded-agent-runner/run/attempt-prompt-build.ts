/**
 * Builds the prompt after session preparation and before provider submission.
 * It may assume session, hook, cache, and context-engine inputs are ready.
 */
import { ensureSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { getRuntimeConfig } from "../../../config/config.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import {
  type DiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import {
  resolveHeartbeatSummaryForAgent,
  type HeartbeatSummary,
} from "../../../infra/heartbeat-summary.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { annotateInterSessionPromptText } from "../../../sessions/input-provenance.js";
import type { createCacheTrace } from "../../cache-trace.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { describeProviderRequestRoutingSummary } from "../../provider-attribution.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import {
  leasePendingAgentSteeringItems,
  prependAgentSteeringPrompt,
} from "../../subagents/registry/subagent-registry.js";
import {
  appendModelIdentitySystemPrompt,
  buildModelIdentityPromptLine,
} from "../../system-prompt.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";
import { log } from "../logger.js";
import {
  beginPromptCacheObservation,
  type PromptCacheChange,
  type PromptCacheToolSnapshot,
} from "../prompt-cache-observability.js";
import {
  cloneToolResultPromptProjectionState,
  type ToolResultPromptProjectionState,
} from "../session-prompt-state.js";
import {
  resolveLiveToolResultAggregateMaxChars,
  resolveLiveToolResultMaxChars,
  reconcileToolResultPromptProjectionState,
  toolResultWarningDedupe,
  truncateOversizedToolResultsInMessages,
} from "../tool-result-truncation.js";
import {
  normalizeCurrentPromptTextForLlmBoundary,
  normalizeMessagesForCurrentPromptBoundary,
} from "./attempt-llm-boundary.js";
import type { resolveOrphanRepairPlan } from "./attempt-orphan-repair.js";
import {
  prependSystemPromptAddition,
  resolveAttemptMediaTaskSystemPromptAddition,
  resolvePromptBuildHookResult,
  shouldWarnOnOrphanedUserRepair,
} from "./attempt-prompt-helpers.js";
import { applyResolvedToolPromptFinalizer } from "./attempt-prompt-support.js";
import { composeSystemPromptWithHookContext } from "./attempt-thread-helpers.js";
import { pruneProcessedHistoryImages } from "./history-image-prune.js";
import {
  buildCurrentInboundPrompt,
  buildRuntimeContextCustomMessage,
  resolveRuntimeContextPromptParts,
  type RuntimeContextCustomMessage,
} from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/**
 * Assembles hook, orphan-repair, steering, and cache inputs for one prompt.
 */
type HookRunner = ReturnType<typeof getGlobalHookRunner>;
type CacheTrace = ReturnType<typeof createCacheTrace>;
type OrphanRepairPlan = ReturnType<typeof resolveOrphanRepairPlan>;
type CacheRetention = Parameters<typeof beginPromptCacheObservation>[0]["cacheRetention"];
type PromptBuildHookContext = Parameters<typeof resolvePromptBuildHookResult>[0]["hookCtx"];

type EmbeddedAttemptSteeringLease = {
  leaseId: string;
  runIds: string[];
};

type EmbeddedAttemptPromptAssembly = {
  hookCtx: PromptBuildHookContext;
  effectivePrompt: string;
  promptBeforePromptBuildHooks: string;
  promptBuildPrependContext?: string;
  promptBuildAppendContext?: string;
  hasPromptBuildContext: boolean;
  effectiveTranscriptPrompt?: string;
  transcriptPromptForRuntimeSplit?: string;
  promptForRuntimeContextSplit: string;
  promptForModelBeforeRuntimeContextSplit: string;
  promptForRuntimeContextBeforeAnnotation: string;
  transcriptLeafId: string | null;
  heartbeatSummary?: ReturnType<typeof resolveHeartbeatSummaryForAgent>;
  promptCacheChangesForTurn: PromptCacheChange[] | null;
  leasedSteering?: EmbeddedAttemptSteeringLease;
};

export async function prepareEmbeddedAttemptPromptAssembly(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  hookRunner: HookRunner;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  isRawModelRun: boolean;
  orphanRepair?: OrphanRepairPlan;
  sessionAgentId: string;
  runtimeModel: string;
  systemPromptText: string;
  applyPromptBuildToolsAllow: (toolsAllow: string[] | undefined) => string[];
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
  setLeasedSteering: (lease: EmbeddedAttemptSteeringLease) => void;
  cache: {
    observabilityEnabled: boolean;
    retention: CacheRetention;
    streamStrategy: string;
    transport: AgentSession["agent"]["transport"];
    tools: readonly PromptCacheToolSnapshot[];
    trace: CacheTrace;
  };
}): Promise<EmbeddedAttemptPromptAssembly> {
  const { attempt } = input;
  const isSettledTurnFinalization = attempt.operation === "settled-tool-finalization";
  let systemPromptText = input.systemPromptText;
  const setSystemPrompt = (next: string) => {
    systemPromptText = next;
    input.setActiveSessionSystemPrompt(next);
  };
  let effectivePrompt = attempt.prompt;
  const hookCtx = {
    runId: attempt.runId,
    trace: freezeDiagnosticTraceContext(input.diagnosticTrace),
    agentId: input.hookAgentId,
    sessionKey: attempt.sessionKey,
    sessionId: attempt.sessionId,
    workspaceDir: attempt.workspaceDir,
    activeProjectKeys: [...(attempt.preparedModelRuntime?.activeProjectKeys ?? [])],
    modelProviderId: attempt.model.provider,
    modelId: attempt.model.id,
    trigger: attempt.trigger,
    ...buildAgentHookContextChannelFields(attempt),
    ...buildAgentHookContextIdentityFields({
      trigger: attempt.trigger,
      senderId: attempt.senderId,
      messageId: attempt.currentMessageId,
      senderIsOwner: attempt.senderIsOwner,
      chatId: attempt.chatId,
      channelContext: attempt.channelContext,
    }),
  };
  const promptBuildMessages =
    pruneProcessedHistoryImages(input.activeSession.messages) ?? input.activeSession.messages;
  const hookResult =
    input.isRawModelRun || isSettledTurnFinalization
      ? undefined
      : await resolvePromptBuildHookResult({
          config: attempt.config ?? getRuntimeConfig(),
          prompt: attempt.prompt,
          messages: promptBuildMessages,
          hookCtx,
          hookRunner: input.hookRunner,
          bootstrapContextRunKind: attempt.bootstrapContextRunKind,
        });
  const promptCacheToolNames = input.applyPromptBuildToolsAllow(hookResult?.toolsAllow);
  const promptCacheToolNameSet = new Set(promptCacheToolNames.map(normalizeToolPolicyName));
  const promptBeforeResolvedToolFinalization = effectivePrompt;
  effectivePrompt = applyResolvedToolPromptFinalizer({
    prompt: effectivePrompt,
    activeToolNames: promptCacheToolNames,
    finalize: attempt.finalizePromptForResolvedTools,
  });
  const effectiveTranscriptPrompt =
    attempt.finalizePromptForResolvedTools && attempt.transcriptPrompt === undefined
      ? promptBeforeResolvedToolFinalization
      : attempt.transcriptPrompt;
  const promptCacheTools = input.cache.tools.filter((tool) =>
    promptCacheToolNameSet.has(normalizeToolPolicyName(tool.name)),
  );
  const promptBeforePromptBuildHooks = effectivePrompt;
  const promptBuildPrependContext = hookResult?.prependContext;
  const promptBuildAppendContext = hookResult?.appendContext;
  const hasPromptBuildContext =
    Boolean(promptBuildPrependContext?.trim()) || Boolean(promptBuildAppendContext?.trim());

  if (hookResult?.prependContext) {
    effectivePrompt = `${hookResult.prependContext}\n\n${effectivePrompt}`;
    log.debug(`hooks: prepended context to prompt (${hookResult.prependContext.length} chars)`);
  }
  if (hookResult?.appendContext) {
    effectivePrompt = `${effectivePrompt}\n\n${hookResult.appendContext}`;
    log.debug(`hooks: appended context to prompt (${hookResult.appendContext.length} chars)`);
  }
  const legacySystemPrompt = normalizeOptionalString(hookResult?.systemPrompt) ?? "";
  if (legacySystemPrompt) {
    setSystemPrompt(legacySystemPrompt);
    log.debug(`hooks: applied systemPrompt (${legacySystemPrompt.length} chars)`);
  }
  const composedSystemPrompt = composeSystemPromptWithHookContext({
    baseSystemPrompt: systemPromptText,
    prependSystemContext: hookResult?.prependSystemContext,
    appendSystemContext: hookResult?.appendSystemContext,
  });
  if (composedSystemPrompt) {
    setSystemPrompt(composedSystemPrompt);
    log.debug(
      `hooks: applied prependSystemContext/appendSystemContext ` +
        `(${hookResult?.prependSystemContext?.trim().length ?? 0}+${hookResult?.appendSystemContext?.trim().length ?? 0} chars)`,
    );
  }
  const mediaTaskSystemPromptAddition = isSettledTurnFinalization
    ? undefined
    : resolveAttemptMediaTaskSystemPromptAddition({
        sessionKey: attempt.sessionKey,
        agentId: input.sessionAgentId,
        trigger: attempt.trigger,
      });
  if (mediaTaskSystemPromptAddition) {
    setSystemPrompt(
      prependSystemPromptAddition({
        systemPrompt: ensureSystemPromptCacheBoundary(systemPromptText),
        systemPromptAddition: mediaTaskSystemPromptAddition,
      }),
    );
  }

  // Keep model identity after the stable cache boundary so media-only dynamic
  // context cannot change the cached prefix between adjacent turns.
  const modelAwareSystemPrompt = isSettledTurnFinalization
    ? systemPromptText
    : appendModelIdentitySystemPrompt({
        systemPrompt:
          buildModelIdentityPromptLine(input.runtimeModel) && systemPromptText.trim().length > 0
            ? ensureSystemPromptCacheBoundary(systemPromptText)
            : systemPromptText,
        model: input.runtimeModel,
      });
  if (modelAwareSystemPrompt !== systemPromptText) {
    setSystemPrompt(modelAwareSystemPrompt);
  }

  let promptCacheChangesForTurn: PromptCacheChange[] | null = null;
  if (input.cache.observabilityEnabled) {
    const cacheObservation = beginPromptCacheObservation({
      sessionId: attempt.sessionId,
      promptCacheKey: attempt.promptCacheKey,
      sessionKey: attempt.sessionKey,
      provider: attempt.provider,
      modelId: attempt.modelId,
      modelApi: attempt.model.api,
      cacheRetention: input.cache.retention,
      streamStrategy: input.cache.streamStrategy,
      transport: input.cache.transport,
      systemPrompt: systemPromptText,
      tools: promptCacheTools,
    });
    promptCacheChangesForTurn = cacheObservation.changes;
    input.cache.trace?.recordStage("cache:state", {
      options: {
        snapshot: cacheObservation.snapshot,
        previousCacheRead: cacheObservation.previousCacheRead ?? undefined,
        changes: cacheObservation.changes?.map((change) => ({
          code: change.code,
          detail: change.detail,
        })),
      },
    });
  }

  const routingSummary = describeProviderRequestRoutingSummary({
    provider: attempt.provider,
    api: attempt.model.api,
    baseUrl: attempt.model.baseUrl,
    capability: "llm",
    transport: "stream",
  });
  log.debug(
    `embedded run prompt start: runId=${attempt.runId} sessionId=${attempt.sessionId} ${routingSummary}`,
  );

  let transcriptPromptForRuntimeSplit = effectiveTranscriptPrompt;
  let promptForRuntimeContextSplit = promptBeforePromptBuildHooks;
  const leafEntry = input.orphanRepair?.messageEntry;
  if (leafEntry && input.orphanRepair) {
    const messageMergeStrategy = input.orphanRepair.strategy;
    const orphanPromptMerge = messageMergeStrategy.mergeOrphanedTrailingUserPrompt({
      prompt: effectivePrompt,
      trigger: attempt.trigger,
      leafMessage: leafEntry.message,
    });
    const runtimePromptMerge = messageMergeStrategy.mergeOrphanedTrailingUserPrompt({
      prompt: promptForRuntimeContextSplit,
      trigger: attempt.trigger,
      leafMessage: leafEntry.message,
    });
    const transcriptPromptMerge =
      effectiveTranscriptPrompt === undefined
        ? undefined
        : messageMergeStrategy.mergeOrphanedTrailingUserPrompt({
            prompt: effectiveTranscriptPrompt,
            trigger: attempt.trigger,
            leafMessage: leafEntry.message,
          });
    effectivePrompt = orphanPromptMerge.prompt;
    promptForRuntimeContextSplit = runtimePromptMerge.prompt;
    transcriptPromptForRuntimeSplit =
      transcriptPromptMerge?.prompt ?? transcriptPromptForRuntimeSplit;
    const action = input.orphanRepair.removeLeaf
      ? orphanPromptMerge.merged
        ? "Merged and removed"
        : "Removed already-queued"
      : "Preserved";
    const message =
      `${action} orphaned user message` +
      (input.orphanRepair.removeLeaf
        ? " to prevent consecutive user turns. "
        : " without removing the active session leaf. ") +
      `runId=${attempt.runId} sessionId=${attempt.sessionId} trigger=${attempt.trigger}`;
    if (shouldWarnOnOrphanedUserRepair(attempt.trigger)) {
      log.warn(message);
    } else {
      log.debug(message);
    }
  }

  let leasedSteering: EmbeddedAttemptSteeringLease | undefined;
  if (attempt.sessionKey && !input.isRawModelRun && !isSettledTurnFinalization) {
    const leaseId = `${attempt.runId}:agent-steering`;
    const leased = leasePendingAgentSteeringItems({
      requesterSessionKey: attempt.sessionKey,
      leaseId,
    });
    if (leased) {
      leasedSteering = { leaseId, runIds: leased.runIds };
      // Transfer cleanup ownership before any prompt mutation can throw.
      input.setLeasedSteering(leasedSteering);
      effectivePrompt = prependAgentSteeringPrompt({
        steeringPrompt: leased.prompt,
        prompt: effectivePrompt,
      });
      promptForRuntimeContextSplit = prependAgentSteeringPrompt({
        steeringPrompt: leased.prompt,
        prompt: promptForRuntimeContextSplit,
      });
      if (transcriptPromptForRuntimeSplit !== undefined) {
        transcriptPromptForRuntimeSplit = prependAgentSteeringPrompt({
          steeringPrompt: leased.prompt,
          prompt: transcriptPromptForRuntimeSplit,
        });
      }
      log.debug(
        `agent steering: injected ${leased.runIds.length} queued item(s) into parent turn ` +
          `runId=${attempt.runId} sessionKey=${attempt.sessionKey}`,
      );
    }
  }

  const promptForModelBeforeRuntimeContextSplit = effectivePrompt;
  const promptForRuntimeContextBeforeAnnotation = promptForRuntimeContextSplit;
  if (!input.isRawModelRun && !isSettledTurnFinalization) {
    promptForRuntimeContextSplit = annotateInterSessionPromptText(
      promptForRuntimeContextSplit,
      attempt.inputProvenance,
    );
  }
  const transcriptLeafId =
    (input.sessionManager.getLeafEntry() as { id?: string } | null | undefined)?.id ?? null;
  const heartbeatSummary =
    !isSettledTurnFinalization && attempt.config && input.sessionAgentId
      ? resolveHeartbeatSummaryForAgent(attempt.config, input.sessionAgentId)
      : undefined;

  return {
    hookCtx,
    effectivePrompt,
    promptBeforePromptBuildHooks,
    promptBuildPrependContext,
    promptBuildAppendContext,
    hasPromptBuildContext,
    effectiveTranscriptPrompt,
    transcriptPromptForRuntimeSplit,
    promptForRuntimeContextSplit,
    promptForModelBeforeRuntimeContextSplit,
    promptForRuntimeContextBeforeAnnotation,
    transcriptLeafId,
    heartbeatSummary,
    promptCacheChangesForTurn,
    leasedSteering,
  };
}

/**
 * Compiles current-turn prompt text, hidden runtime context, and hook messages.
 */
type PromptContextAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "contextTokenBudget"
  | "currentInboundContext"
  | "currentInboundEventKind"
  | "sessionId"
  | "sessionKey"
  | "suppressNextUserMessagePersistence"
>;

type PromptAssemblyContext = {
  effectivePrompt: string;
  promptBeforePromptBuildHooks: string;
  promptBuildPrependContext?: string;
  promptBuildAppendContext?: string;
  hasPromptBuildContext: boolean;
  effectiveTranscriptPrompt?: string;
  transcriptPromptForRuntimeSplit?: string;
  promptForRuntimeContextSplit: string;
  promptForModelBeforeRuntimeContextSplit: string;
  promptForRuntimeContextBeforeAnnotation: string;
  heartbeatSummary?: Pick<HeartbeatSummary, "ackMaxChars" | "prompt">;
};

type CurrentUserTimestampOverride = {
  timestamp: number;
  text: string;
  alternateText?: string;
};

type EmbeddedAttemptPromptContext = {
  aggregatePressureEngaged: boolean;
  contextTokenBudget: number;
  currentUserTimestampOverride?: CurrentUserTimestampOverride;
  effectivePrompt: string;
  hookMessagesForCurrentPrompt: AgentMessage[];
  llmBoundaryPromptForPrecheck: string;
  prePromptMessageCount: number;
  promptForModel: string;
  promptForSession: string;
  promptSubmission: ReturnType<typeof resolveRuntimeContextPromptParts>;
  promptToolResultAggregateMaxChars: number;
  promptToolResultMaxChars: number;
  runtimeContextMessageForCurrentTurn?: RuntimeContextCustomMessage;
  systemPromptForHook: string;
};

export function prepareEmbeddedAttemptPromptContext(input: {
  attempt: PromptContextAttempt;
  boundaryTimezone?: string;
  includeBoundaryTimestamp: boolean;
  isRawModelRun: boolean;
  messages: AgentMessage[];
  preparedUserTurnMessage?: AgentMessage;
  heartbeatOutcomeContext?: string;
  prompt: PromptAssemblyContext;
  replaceSessionMessages: (messages: AgentMessage[]) => void;
  sessionAgentId: string;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
  systemPromptReport?: SessionSystemPromptReport;
  systemPromptText: string;
  toolResultPromptProjectionState: ToolResultPromptProjectionState;
}): EmbeddedAttemptPromptContext {
  const { attempt } = input;
  const preparedUserTurnTimestamp = (
    input.preparedUserTurnMessage as { timestamp?: unknown } | undefined
  )?.timestamp;
  let sessionMessages = filterHeartbeatTranscriptArtifacts(
    input.messages,
    input.prompt.heartbeatSummary?.ackMaxChars,
    input.prompt.heartbeatSummary?.prompt,
  );
  if (sessionMessages.length < input.messages.length) {
    input.replaceSessionMessages(sessionMessages);
  }
  // Raw probes temporarily hide durable history; only normal prepared history
  // is authoritative for reclaiming session-owned provider projections.
  if (!input.isRawModelRun) {
    reconcileToolResultPromptProjectionState(
      sessionMessages,
      input.toolResultPromptProjectionState,
    );
  }
  const prePromptMessageCount = sessionMessages.length;
  const contextTokenBudget = attempt.contextTokenBudget ?? DEFAULT_CONTEXT_TOKENS;
  const promptToolResultMaxChars = resolveLiveToolResultMaxChars({
    contextWindowTokens: contextTokenBudget,
  });
  const promptToolResultAggregateMaxChars = resolveLiveToolResultAggregateMaxChars({
    contextWindowTokens: contextTokenBudget,
    perResultMaxChars: promptToolResultMaxChars,
  });
  const promptToolResultTruncation = truncateOversizedToolResultsInMessages(
    sessionMessages,
    contextTokenBudget,
    promptToolResultMaxChars,
    promptToolResultAggregateMaxChars,
    cloneToolResultPromptProjectionState(input.toolResultPromptProjectionState),
  );
  const promptHistoryChanged = promptToolResultTruncation.messages !== sessionMessages;
  const { aggregatePressureEngaged } = promptToolResultTruncation;
  if (promptHistoryChanged) {
    sessionMessages = promptToolResultTruncation.messages;
  }
  if (promptHistoryChanged || aggregatePressureEngaged) {
    const sessionLogKey = attempt.sessionKey ?? attempt.sessionId ?? "unknown";
    const truncationLog =
      `[tool-result-truncation] Truncated ${promptToolResultTruncation.truncatedCount} ` +
      `tool result(s) for prompt history ` +
      `(maxChars=${promptToolResultMaxChars} ` +
      `aggregateBudgetChars=${promptToolResultAggregateMaxChars} ` +
      `aggregate=${promptToolResultTruncation.aggregateTruncatedCount}) ` +
      `sessionKey=${sessionLogKey}`;
    if (aggregatePressureEngaged) {
      if (!toolResultWarningDedupe.promptPressure.check(sessionLogKey)) {
        log.warn(
          `${truncationLog}; aggregate tool-result pressure detected; final provider-bound projection will determine whether recovery is needed`,
        );
      }
    } else {
      log.info(truncationLog);
    }
  }

  const hasNonEmptyTranscriptPrompt = Boolean(input.prompt.effectiveTranscriptPrompt?.trim());
  // A non-empty transcript prompt is a persistence substitution. Keep the
  // assembled model prompt authoritative even when no hook added context.
  const shouldUseExplicitModelPrompt =
    input.prompt.hasPromptBuildContext || hasNonEmptyTranscriptPrompt;
  const promptSubmission = resolveRuntimeContextPromptParts({
    effectivePrompt: input.prompt.promptForRuntimeContextSplit,
    transcriptPrompt: input.prompt.transcriptPromptForRuntimeSplit,
    modelPrompt: shouldUseExplicitModelPrompt
      ? input.prompt.promptForModelBeforeRuntimeContextSplit
      : undefined,
    modelPromptBuildContext:
      shouldUseExplicitModelPrompt && input.prompt.effectiveTranscriptPrompt !== undefined
        ? {
            promptBeforeHooks: input.prompt.promptBeforePromptBuildHooks,
            transcriptPromptBeforeTransforms: input.prompt.effectiveTranscriptPrompt,
            promptBeforeAnnotation: input.prompt.promptForRuntimeContextBeforeAnnotation,
            prependContext: input.prompt.promptBuildPrependContext ?? "",
            appendContext: input.prompt.promptBuildAppendContext ?? "",
          }
        : undefined,
    emptyTranscriptMode: attempt.suppressNextUserMessagePersistence
      ? "model-prompt"
      : "runtime-event",
  });
  const isRuntimeOnlyTurn = promptSubmission.runtimeOnly === true;
  const currentInboundContextText = isRuntimeOnlyTurn
    ? undefined
    : attempt.currentInboundContext?.text?.trim() || undefined;
  // Normal user turns persist the bare prompt and carry current inbound metadata
  // in a hidden runtime-context message. Runtime-only turns have no bare user turn,
  // so their inbound context remains inline and byte-stable across replay.
  const promptForSession = isRuntimeOnlyTurn
    ? buildCurrentInboundPrompt({
        context: attempt.currentInboundContext,
        prompt: promptSubmission.prompt,
      })
    : promptSubmission.prompt;
  const promptForModel = isRuntimeOnlyTurn
    ? buildCurrentInboundPrompt({
        context: attempt.currentInboundContext,
        prompt: promptSubmission.modelPrompt ?? promptSubmission.prompt,
      })
    : (promptSubmission.modelPrompt ?? promptSubmission.prompt);
  const currentUserTimestampOverride =
    !input.isRawModelRun && typeof preparedUserTurnTimestamp === "number"
      ? {
          timestamp: preparedUserTurnTimestamp,
          text: promptForSession,
          ...(promptForModel !== promptForSession ? { alternateText: promptForModel } : {}),
        }
      : undefined;
  const runtimeSystemContext = promptSubmission.runtimeSystemContext?.trim();
  let systemPromptForHook = input.systemPromptText;
  if (promptSubmission.runtimeOnly && runtimeSystemContext) {
    const runtimeSystemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt: input.systemPromptText,
      appendSystemContext: runtimeSystemContext,
    });
    if (runtimeSystemPrompt) {
      systemPromptForHook = runtimeSystemPrompt;
      input.setActiveSessionSystemPrompt(runtimeSystemPrompt);
    }
  }
  const runtimeContextForHook = isRuntimeOnlyTurn
    ? undefined
    : [
        currentInboundContextText,
        promptSubmission.runtimeContext?.trim(),
        input.heartbeatOutcomeContext?.trim(),
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n") || undefined;
  const runtimeContextMessageForCurrentTurn =
    buildRuntimeContextCustomMessage(runtimeContextForHook);
  const messagesForCurrentPrompt = runtimeContextMessageForCurrentTurn
    ? [...sessionMessages, runtimeContextMessageForCurrentTurn]
    : sessionMessages;
  const hookMessagesForCurrentPrompt = normalizeMessagesForCurrentPromptBoundary({
    messages: messagesForCurrentPrompt,
    prompt: promptForModel,
    ...(input.boundaryTimezone ? { timezone: input.boundaryTimezone } : {}),
    ...(input.includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
    ...(typeof preparedUserTurnTimestamp === "number"
      ? { currentUserTimestamp: preparedUserTurnTimestamp }
      : {}),
  });
  if (input.systemPromptReport) {
    input.systemPromptReport.currentTurn = {
      ...(attempt.currentInboundEventKind ? { kind: attempt.currentInboundEventKind } : {}),
      promptChars: promptForModel.length,
      runtimeContextChars: promptSubmission.runtimeOnly
        ? (runtimeSystemContext?.length ?? 0)
        : (runtimeContextForHook?.length ?? 0),
      // Hook context reaches only the model, so count the delta beyond the
      // transcript prompt or downstream context accounting undercounts it.
      modelOnlyPromptChars: Math.max(0, promptForModel.length - promptForSession.length),
    };
  }
  const llmBoundaryPromptForPrecheck = normalizeCurrentPromptTextForLlmBoundary({
    prompt: promptForModel,
    ...(input.boundaryTimezone ? { timezone: input.boundaryTimezone } : {}),
    ...(input.includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
    ...(typeof preparedUserTurnTimestamp === "number"
      ? { currentUserTimestamp: preparedUserTurnTimestamp }
      : {}),
    // Admission must count the same persisted sender block that provider
    // conversion projects after the active user turn is written.
    ...(!input.isRawModelRun && input.preparedUserTurnMessage
      ? { currentUserTranscriptMessage: input.preparedUserTurnMessage }
      : {}),
  });

  return {
    aggregatePressureEngaged,
    contextTokenBudget,
    ...(currentUserTimestampOverride ? { currentUserTimestampOverride } : {}),
    effectivePrompt: input.prompt.effectivePrompt,
    hookMessagesForCurrentPrompt,
    llmBoundaryPromptForPrecheck,
    prePromptMessageCount,
    promptForModel,
    promptForSession,
    promptSubmission,
    promptToolResultAggregateMaxChars,
    promptToolResultMaxChars,
    ...(runtimeContextMessageForCurrentTurn ? { runtimeContextMessageForCurrentTurn } : {}),
    systemPromptForHook,
  };
}
