import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { consolidateLiveModelSwitchAfterRun } from "../../agents/live-model-switch.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import { resolveFallbackTransition } from "../fallback-state.js";
import { normalizeVerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { resolveFallbackOriginModel } from "./agent-runner-core.js";
import type { AgentTurnCompaction } from "./agent-runner-execution.types.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import { drainPendingToolTasks } from "./pending-tool-task-drain.js";
import { refreshQueuedFollowupSession } from "./queue.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { buildReplyUsageState, recordReplyUsageState } from "./reply-usage-state.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

type AgentTurnAccountingContext = Pick<
  FinalizeReplyAgentRunInput,
  | "activeSessionEntry"
  | "activeSessionStore"
  | "blockReplyPipeline"
  | "cfg"
  | "defaultModel"
  | "followupRun"
  | "isHeartbeat"
  | "pendingToolTasks"
  | "preflightCompactionApplied"
  | "resolvedVerboseLevel"
  | "execution"
  | "runId"
  | "runStartedAt"
  | "sessionCtx"
  | "sessionKey"
  | "shouldInjectGroupIntro"
  | "storePath"
> & { replyOperation?: FinalizeReplyAgentRunInput["replyOperation"] };

/** Persists only host-bound facts while the exact logical turn still owns accounting. */
export async function accountAgentTurnCompaction(params: {
  compaction?: AgentTurnCompaction;
  sessionStore: FinalizeReplyAgentRunInput["activeSessionStore"];
  replyOperation?: FinalizeReplyAgentRunInput["replyOperation"];
}): Promise<number | undefined> {
  const operation = params.replyOperation;
  if (!operation) {
    return undefined;
  }
  const authorize = () => replyRunRegistry.get(operation.key) === operation;
  let count: number | undefined;
  for (const fact of params.compaction?.durable ?? []) {
    const persistedCount = await incrementCompactionCount({
      agentId: fact.target.agentId,
      sessionStore: params.sessionStore,
      sessionKey: fact.target.sessionKey,
      storePath: fact.target.storePath,
      expectedSession: fact.target,
      amount: fact.count,
      tokensAfter: fact.currentContextTokens,
      authorize,
    });
    if (persistedCount !== undefined) {
      count = persistedCount;
    }
  }
  return count;
}

export async function accountAgentTurn(context: AgentTurnAccountingContext) {
  const {
    activeSessionStore,
    blockReplyPipeline,
    cfg,
    defaultModel,
    followupRun,
    isHeartbeat,
    pendingToolTasks,
    preflightCompactionApplied,
    resolvedVerboseLevel,
    execution,
    runId,
    runStartedAt,
    sessionKey,
    sessionCtx,
    shouldInjectGroupIntro,
    storePath,
  } = context;
  let { activeSessionEntry } = context;
  const latestCompaction = execution.compaction?.durable.at(-1);
  const currentContextSnapshot = execution.compaction
    ? { tokens: latestCompaction?.currentContextTokens }
    : undefined;
  const expectedSession = latestCompaction?.target ?? {
    sessionId: activeSessionEntry?.sessionId ?? followupRun.run.sessionId,
    lifecycleRevision: activeSessionEntry?.lifecycleRevision,
  };
  const operation = context.replyOperation;
  const authorize = latestCompaction
    ? () => operation !== undefined && replyRunRegistry.get(operation.key) === operation
    : undefined;

  const runResult = execution.result;
  const fallbackProvider = execution.resolved.provider;
  const fallbackModel = execution.resolved.model;
  const fallbackExhausted = execution.fallback.exhausted;
  const fallbackAttempts = execution.fallback.attempts;
  const directlySentBlockKeys = execution.directlySentBlockKeys;
  const directlySentBlockPayloads = execution.directlySentBlockPayloads;
  const terminalFailurePayload = execution.terminalFailurePayload;
  const { autoCompactionCount, didLogHeartbeatStrip } = execution;

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
    agentDir: followupRun.run.agentDir,
    workspaceDir: followupRun.run.workspaceDir,
    costUsd: runResult.meta?.agentMeta?.costUsd,
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
  const configuredFallbackModel = resolveFallbackOriginModel({
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
    const fallbackNotice = fallbackTransition.nextState.selectedModel
      ? {
          kind: "active" as const,
          selectedModel: fallbackTransition.nextState.selectedModel,
          activeModel: fallbackTransition.nextState.activeModel!,
          ...(fallbackTransition.nextState.reason
            ? { reason: fallbackTransition.nextState.reason }
            : {}),
        }
      : undefined;
    if (fallbackStateEntry) {
      fallbackStateEntry.fallbackNotice = fallbackNotice;
      fallbackStateEntry.updatedAt = Date.now();
      activeSessionEntry = fallbackStateEntry;
    }
    if (sessionKey && fallbackStateEntry && activeSessionStore) {
      activeSessionStore[sessionKey] = fallbackStateEntry;
    }
    if (sessionKey && storePath) {
      await updateSessionEntry({ storePath, sessionKey }, () => ({ fallbackNotice }), {
        skipMaintenance: true,
        takeCacheOwnership: true,
      });
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
  const resolvedContextTokens =
    runtimeContextTokens === undefined
      ? resolveContextTokensForModel({
          cfg,
          provider: providerUsed,
          model: modelUsed,
          allowAsyncLoad: false,
        })
      : undefined;
  const contextTokensUsed =
    runtimeContextTokens ??
    resolvedContextTokens ??
    activeSessionEntry?.contextTokens ??
    DEFAULT_CONTEXT_TOKENS;
  const contextTokensSource =
    runResult.meta?.agentMeta?.contextTokensSource ??
    (runtimeContextTokens !== undefined
      ? "runtime"
      : resolvedContextTokens !== undefined
        ? "resolved-v1"
        : undefined);

  // Count first: terminal usage restores billing buckets without guessing context chronology.
  const compactionCount = await accountAgentTurnCompaction({
    compaction: execution.compaction,
    sessionStore: activeSessionStore,
    replyOperation: operation,
  });
  await persistSessionUsageUpdate({
    agentId: latestCompaction?.target.agentId ?? followupRun.run.agentId,
    sessionStore: activeSessionStore,
    storePath: latestCompaction?.target.storePath ?? storePath,
    sessionKey: latestCompaction?.target.sessionKey ?? sessionKey,
    expectedSession,
    authorize,
    cfg,
    agentDir: followupRun.run.agentDir,
    workspaceDir: followupRun.run.workspaceDir,
    usage,
    costUsd: runResult.meta?.agentMeta?.costUsd,
    lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
    currentContextSnapshot,
    promptTokens,
    isHeartbeat,
    preserveRuntimeModel:
      fallbackExhausted || fallbackTransition.nextState.selectedModel !== undefined,
    preserveUserFacingSessionModelState: preserveUserFacingSessionState,
    modelUsed,
    providerUsed,
    contextTokensUsed,
    contextTokensSource,
    contextBudgetStatus:
      compactionCount === undefined ? runResult.meta?.agentMeta?.contextBudgetStatus : undefined,
    systemPromptReport: runResult.meta?.systemPromptReport,
    cliSessionId,
    cliSessionBinding,
    clearCliSessionBinding,
    preserveFreshTotalTokensOnStaleUsage: preflightCompactionApplied,
    agentHarnessId: runResult.meta?.agentMeta?.agentHarnessId,
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

  if (compactionCount !== undefined && sessionKey) {
    activeSessionEntry = activeSessionStore?.[sessionKey] ?? activeSessionEntry;
  }

  return {
    activeSessionEntry,
    autoCompactionCount,
    compactionCount,
    expectedSession,
    configuredFallbackModel,
    contextTokensUsed,
    didLogHeartbeatStrip,
    directlySentBlockKeys,
    directlySentBlockPayloads,
    fallbackAttempts,
    fallbackExhausted,
    fallbackTransition,
    hasBillableUsageBuckets,
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

export type AccountedAgentTurn = Awaited<ReturnType<typeof accountAgentTurn>>;

/** Applies common accounting plus the queue/session projection owned by follow-up turns. */
export async function accountFollowupTurn(params: {
  turn: AdmittedFollowupTurn;
  defaults: FollowupRunnerParams;
  execution: FollowupExecutionResult;
}) {
  const { turn, defaults, execution } = params;
  const settled = execution.execution.outcome;
  const sessionKey = turn.session.kind === "session" ? turn.session.key : undefined;
  if (settled.kind !== "settled") {
    // Cancellation is not rollback. The captured target permits bookkeeping, never recovery.
    await accountAgentTurnCompaction({
      compaction: settled.compaction,
      sessionStore: turn.sessionStore,
      replyOperation: turn.operation,
    });
    return undefined;
  }
  const accounting = await accountAgentTurn({
    activeSessionEntry: turn.session.current(),
    activeSessionStore: turn.sessionStore,
    blockReplyPipeline: null,
    cfg: turn.config,
    defaultModel: defaults.defaultModel,
    followupRun: turn.queued,
    isHeartbeat: defaults.opts?.isHeartbeat === true,
    pendingToolTasks: execution.pendingToolTasks,
    replyOperation: turn.operation,
    preflightCompactionApplied: turn.preflightCompactionApplied,
    resolvedVerboseLevel:
      normalizeVerboseLevel(turn.session.current()?.verboseLevel ?? turn.queued.run.verboseLevel) ??
      "off",
    execution: settled,
    runId: execution.execution.runId,
    runStartedAt: execution.runStartedAt,
    sessionCtx: execution.sessionCtx,
    sessionKey,
    shouldInjectGroupIntro: false,
    storePath: turn.session.kind === "session" ? turn.session.storePath : undefined,
  });
  turn.session.publish(accounting.activeSessionEntry);
  const queueKey = turn.queued.run.sessionKey ?? defaults.sessionKey ?? sessionKey;
  if (
    queueKey &&
    accounting.fallbackTransition.stateChanged &&
    !accounting.fallbackExhausted &&
    !accounting.preserveUserFacingSessionState
  ) {
    const entry = turn.session.current();
    refreshQueuedFollowupSession({
      key: queueKey,
      previousSessionId: turn.queued.run.sessionId,
      nextSessionId: entry?.sessionId ?? turn.queued.run.sessionId,
      nextSessionFile: queueKey,
      nextProvider: accounting.providerUsed,
      nextModel: accounting.modelUsed,
      nextModelOverrideSource: entry?.modelOverrideSource,
      nextAuthProfileId: entry?.authProfileOverride,
      nextAuthProfileIdSource: resolveSessionAuthProfileOverrideSource(entry),
    });
  }
  let compactionNotice: ReplyPayload | undefined;
  if (accounting.autoCompactionCount > 0) {
    const previousSessionId = turn.queued.run.sessionId;
    const count = accounting.compactionCount;
    const refreshed = turn.session.current();
    if (refreshed) {
      turn.session.publish(refreshed);
      refreshQueuedFollowupSession({
        key: queueKey ?? "",
        previousSessionId,
        nextSessionId: refreshed.sessionId,
        nextSessionFile: queueKey ?? sessionKey,
      });
    }
    if (accounting.verboseEnabled) {
      const suffix = typeof count === "number" ? ` (count ${count})` : "";
      compactionNotice = { text: `🧹 Auto-compaction complete${suffix}.` };
    }
  }
  return { ...accounting, compactionNotice };
}
