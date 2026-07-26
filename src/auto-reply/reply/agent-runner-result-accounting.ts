import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { consolidateLiveModelSwitchAfterRun } from "../../agents/live-model-switch.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import {
  formatActiveContinuationTraceparent,
  resolveContinuationTraceparent,
} from "../../infra/continuation-tracer.js";
import { defaultRuntime } from "../../runtime.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import { resolveLiveContinuationRuntimeConfig } from "../continuation/config.js";
import { failQueuedDelegatesCreatedAtOrAfter } from "../continuation/delegate-store.js";
import { extractContinuationSignal } from "../continuation/signal.js";
import { resolveFallbackTransition } from "../fallback-state.js";
import { resolveConfiguredFallbackModel } from "./agent-runner-core.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { recordNoOpRearmOutcome, summarizeEmbeddedRunOutcome } from "./no-op-rearm-guard.js";
import { drainPendingToolTasks } from "./pending-tool-task-drain.js";
import { buildReplyUsageState, recordReplyUsageState } from "./reply-usage-state.js";
import { persistRunSessionUsage } from "./session-run-accounting.js";

export async function accountReplyAgentRun(context: FinalizeReplyAgentRunInput) {
  const {
    activeSessionStore,
    agentCfgContextTokens,
    blockReplyPipeline,
    cfg,
    continuation,
    defaultModel,
    followupRun,
    getActiveSessionEntry,
    isHeartbeat,
    noOpRearmWakeClass,
    opts,
    pendingToolTasks,
    preflightCompactionApplied,
    replySessionKey,
    resolvedVerboseLevel,
    runOutcome,
    runStartedAt,
    sessionKey,
    sessionCtx,
    shouldInjectGroupIntro,
    storePath,
  } = context;
  let { activeSessionEntry } = context;

  const {
    runId,
    runResult,
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    fallbackAttempts,
    directlySentBlockKeys,
    directlySentBlockPayloads,
    terminalFailurePayload,
  } = runOutcome;
  const { autoCompactionCount } = runOutcome;
  const { didLogHeartbeatStrip } = runOutcome;

  if (
    shouldInjectGroupIntro &&
    activeSessionEntry &&
    activeSessionStore &&
    sessionKey &&
    activeSessionEntry.groupActivationNeedsSystemIntro
  ) {
    const updatedAt = Date.now();
    activeSessionEntry.groupActivationNeedsSystemIntro = false;
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
    if (storePath) {
      await updateSessionEntry(
        { storePath, sessionKey },
        () => ({
          groupActivationNeedsSystemIntro: false,
          updatedAt,
        }),
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
        },
      );
    }
  }

  const payloadArray = runResult.payloads ?? [];

  if (blockReplyPipeline) {
    await blockReplyPipeline.flush({ force: true });
    blockReplyPipeline.stop();
  }
  if (pendingToolTasks.size > 0) {
    await drainPendingToolTasks({
      tasks: pendingToolTasks,
      onTimeout: logVerbose,
    });
  }

  // Post-turn no-op replay outcome recording. Record before the
  // continuation/followup scheduling below so a no-op self-rearm turn increments
  // the streak before it can schedule the next same-family wake. This is also the
  // recording site for continuation turns driven through getReplyFromConfig.
  if (noOpRearmWakeClass && replySessionKey) {
    const facts = summarizeEmbeddedRunOutcome(runResult);
    const messageToolOnlyWithoutDelivery =
      opts?.sourceReplyDeliveryMode === "message_tool_only" &&
      runResult.didSendViaMessagingTool !== true &&
      runResult.didDeliverSourceReplyViaMessageTool !== true;
    recordNoOpRearmOutcome({
      sessionKey: replySessionKey,
      wakeClass: noOpRearmWakeClass,
      runId,
      ...(messageToolOnlyWithoutDelivery
        ? { facts: { ...facts, hasVisibleReply: false } }
        : { facts }),
    });
  }

  // --- Continuation signal extraction (docs/design/continue-work-signal-v2.md §3.1) ---
  // Tool-based `continue_work` flows via the closure `requestContinuation`
  // callback in agent-runner-execution.ts and is surfaced on the run outcome
  // as `runOutcome.continueWorkRequests` (one entry per tool call this turn).
  // Bracket signals (CONTINUE_WORK, CONTINUE_DELEGATE) live in the payload
  // text and are parsed here. The merged signal only needs the first request
  // to decide kind/delay; the full array fans out at the work-schedule site.
  const continueWorkRequests = runOutcome.continueWorkRequests ?? [];
  const suppressToolContinuationAfterIncompleteTurn =
    runResult.meta?.error?.kind === "incomplete_turn" && runResult.meta?.replayInvalid === true;
  if (suppressToolContinuationAfterIncompleteTurn) {
    if (continueWorkRequests.length > 0) {
      defaultRuntime.log(
        `[continuation] Ignoring ${continueWorkRequests.length} continue_work election(s) because the enclosing turn was incomplete and replay-unsafe for session ${sessionKey ?? "unknown"}`,
      );
    }
    if (sessionKey) {
      const failedDelegateRows = failQueuedDelegatesCreatedAtOrAfter(
        sessionKey,
        runStartedAt,
        "Continuation delegate election ignored because the enclosing turn was incomplete and replay-unsafe.",
      );
      if (failedDelegateRows > 0) {
        defaultRuntime.log(
          `[continuation] Failed ${failedDelegateRows} queued continue_delegate election(s) because the enclosing turn was incomplete and replay-unsafe for session ${sessionKey}`,
        );
      }
    }
  }
  const effectiveContinueWorkRequests = suppressToolContinuationAfterIncompleteTurn
    ? []
    : continueWorkRequests;
  const firstWorkRequest = effectiveContinueWorkRequests[0];
  // Recheck after inference so a disabled -> enabled hot reload cannot revive
  // stale depth, cost, or chain identity at the next enforcement point.
  await continuation.resetContinuationChainForFreshTurn();
  activeSessionEntry = getActiveSessionEntry() ?? activeSessionEntry;
  const continuationExtraction = extractContinuationSignal({
    payloads: payloadArray,
    continueWorkRequest: firstWorkRequest
      ? {
          reason: firstWorkRequest.reason,
          delaySeconds: firstWorkRequest.delaySeconds,
        }
      : undefined,
    enabled: resolveLiveContinuationRuntimeConfig(cfg).enabled,
    sessionKey,
  });
  const effectiveContinuationSignal = continuationExtraction.signal;
  const continuationWorkReason = continuationExtraction.workReason;
  const internalBracketTraceparent = continuationExtraction.fromBracket
    ? (resolveContinuationTraceparent(followupRun.run.traceparent) ??
      formatActiveContinuationTraceparent())
    : undefined;

  const usage = runResult.meta?.agentMeta?.usage;
  const hasBillableUsageBuckets =
    usage &&
    (usage.input !== undefined ||
      usage.output !== undefined ||
      usage.cacheRead !== undefined ||
      usage.cacheWrite !== undefined);
  const promptTokens = runResult.meta?.agentMeta?.promptTokens;
  const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
  const providerUsed =
    runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? followupRun.run.provider;

  const winnerProvider = fallbackExhausted
    ? undefined
    : (runResult.meta?.executionTrace?.winnerProvider ?? providerUsed);
  const winnerModel = fallbackExhausted
    ? undefined
    : (runResult.meta?.executionTrace?.winnerModel ?? modelUsed);
  const ctxTokens = runResult.meta?.agentMeta?.contextTokens;
  const compactions = runResult.meta?.agentMeta?.compactionCount;
  const lastCallUsage = runResult.meta?.agentMeta?.lastCallUsage;
  const replyUsageState = buildReplyUsageState({
    config: cfg,
    provider: providerUsed,
    model: modelUsed,
    fallbackExhausted,
    winnerProvider,
    winnerModel,
    reasoningEffort:
      typeof followupRun.run.thinkLevel === "string" ? followupRun.run.thinkLevel : undefined,
    fastMode: resolveFastModeState({
      cfg,
      provider: providerUsed ?? "",
      model: modelUsed ?? "",
      agentId: followupRun.run.agentId,
      sessionEntry: activeSessionEntry,
    }).enabled,
    fallbackUsed: runResult.meta?.executionTrace?.fallbackUsed === true,
    agentId: followupRun.run.agentId,
    sessionId: followupRun.run.sessionId,
    chatType: typeof sessionCtx.ChatType === "string" ? sessionCtx.ChatType : undefined,
    authMode: runResult.meta?.requestShaping?.authMode ?? undefined,
    overrideSource: activeSessionEntry?.modelOverrideSource ?? undefined,
    requestedProvider: followupRun.run.provider,
    requestedModel: followupRun.run.model,
    durationMs: Date.now() - runStartedAt,
    compactionCount: typeof compactions === "number" ? compactions : undefined,
    contextTokenBudget:
      typeof ctxTokens === "number" && Number.isFinite(ctxTokens) ? ctxTokens : undefined,
    contextUsedTokens:
      typeof promptTokens === "number" && Number.isFinite(promptTokens) ? promptTokens : undefined,
    promptTokens,
    usage,
    lastCallUsage,
  });
  recordReplyUsageState(runId, replyUsageState);
  const verboseEnabled = resolvedVerboseLevel !== "off";
  const preserveUserFacingSessionState = shouldPreserveUserFacingSessionStateForInputProvenance(
    followupRun.run.inputProvenance,
  );
  const fallbackStateEntry =
    activeSessionEntry ?? (sessionKey ? activeSessionStore?.[sessionKey] : undefined);
  const configuredFallbackModel = resolveConfiguredFallbackModel({
    run: followupRun.run,
    fallbackStateEntry,
  });
  const selectedProvider = configuredFallbackModel.provider;
  const selectedModel = configuredFallbackModel.model;
  const fallbackTransition = resolveFallbackTransition({
    selectedProvider,
    selectedModel,
    activeProvider: providerUsed,
    activeModel: modelUsed,
    attempts: fallbackAttempts,
    state: fallbackStateEntry,
    cfg,
  });
  if (fallbackTransition.stateChanged && !fallbackExhausted && !preserveUserFacingSessionState) {
    if (fallbackStateEntry) {
      fallbackStateEntry.fallbackNoticeSelectedModel = fallbackTransition.nextState.selectedModel;
      fallbackStateEntry.fallbackNoticeActiveModel = fallbackTransition.nextState.activeModel;
      fallbackStateEntry.fallbackNoticeReason = fallbackTransition.nextState.reason;
      fallbackStateEntry.updatedAt = Date.now();
      activeSessionEntry = fallbackStateEntry;
    }
    if (sessionKey && fallbackStateEntry && activeSessionStore) {
      activeSessionStore[sessionKey] = fallbackStateEntry;
    }
    if (sessionKey && storePath) {
      await updateSessionEntry(
        { storePath, sessionKey },
        () => ({
          fallbackNoticeSelectedModel: fallbackTransition.nextState.selectedModel,
          fallbackNoticeActiveModel: fallbackTransition.nextState.activeModel,
          fallbackNoticeReason: fallbackTransition.nextState.reason,
        }),
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
        },
      );
    }
  }
  const usedCliProvider = isCliProvider(providerUsed, cfg);
  const cliSessionId = usedCliProvider
    ? normalizeOptionalString(runResult.meta?.agentMeta?.sessionId)
    : undefined;
  const cliSessionBinding = usedCliProvider
    ? runResult.meta?.agentMeta?.cliSessionBinding
    : undefined;
  const clearCliSessionBinding =
    usedCliProvider && runResult.meta?.agentMeta?.clearCliSessionBinding === true;
  const runtimeContextTokens =
    typeof runResult.meta?.agentMeta?.contextTokens === "number" &&
    Number.isFinite(runResult.meta.agentMeta.contextTokens) &&
    runResult.meta.agentMeta.contextTokens > 0
      ? Math.floor(runResult.meta.agentMeta.contextTokens)
      : undefined;
  const contextTokensUsed =
    runtimeContextTokens ??
    resolveContextTokensForModel({
      cfg,
      provider: providerUsed,
      model: modelUsed,
      contextTokensOverride: agentCfgContextTokens,
      fallbackContextTokens: activeSessionEntry?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
      allowAsyncLoad: false,
    }) ??
    DEFAULT_CONTEXT_TOKENS;

  await persistRunSessionUsage({
    storePath,
    sessionKey,
    cfg,
    usage,
    lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
    compactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
    promptTokens,
    usageIsContextSnapshot: usedCliProvider ? true : undefined,
    isHeartbeat,
    preserveRuntimeModel: fallbackExhausted,
    preserveUserFacingSessionModelState: preserveUserFacingSessionState,
    modelUsed,
    providerUsed,
    contextTokensUsed,
    systemPromptReport: runResult.meta?.systemPromptReport,
    cliSessionId,
    cliSessionBinding,
    clearCliSessionBinding,
    preserveFreshTotalTokensOnStaleUsage: preflightCompactionApplied,
  });
  if (!isHeartbeat && !preserveUserFacingSessionState && !fallbackExhausted) {
    // A completed run that executed the persisted selection consumes the
    // pending live-switch flag; CLI harness runs never hit the embedded
    // attempt-recovery clear, so /status would report the switch forever.
    await consolidateLiveModelSwitchAfterRun({
      cfg,
      sessionKey,
      agentId: followupRun.run.agentId,
      providerUsed,
      modelUsed,
    });
  }

  return {
    activeSessionEntry,
    autoCompactionCount,
    configuredFallbackModel,
    contextTokensUsed,
    continuationExtractionFromBracket: continuationExtraction.fromBracket,
    continuationWorkReason,
    didLogHeartbeatStrip,
    directlySentBlockKeys,
    directlySentBlockPayloads,
    effectiveContinuationSignal,
    effectiveContinueWorkRequests,
    fallbackAttempts,
    fallbackExhausted,
    fallbackTransition,
    hasBillableUsageBuckets,
    internalBracketTraceparent,
    modelUsed,
    payloadArray,
    preserveUserFacingSessionState,
    promptTokens,
    providerUsed,
    replyUsageState,
    runId,
    runResult,
    selectedModel,
    selectedProvider,
    terminalFailurePayload,
    usage,
    verboseEnabled,
  };
}
