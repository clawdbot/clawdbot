/** Stateless startup and post-compaction recovery for continuation delegates. */

import { deriveContinuationDelegateChildSessionKeyFromParent } from "../../agents/subagent-continuation-ids.js";
import {
  getSubagentRunByChildSessionKey,
  hasLiveContinuationDelegateChildRun,
  isSubagentRunLive,
} from "../../agents/subagent-registry-read.js";
import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  emitContinuationDisabledSpan,
  resolveContinuationTraceparent,
} from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import {
  loadPendingSessionDeliveries,
  type QueuedSessionDelivery,
} from "../../infra/session-delivery-queue-storage.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sanitizeInboundSystemTags } from "../../security/system-tags.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import {
  DelegateTerminalChainStatePersistError,
  dispatchToolDelegates,
  type DelegateDispatchContext,
} from "./delegate-dispatch.js";
import {
  assertStagedPostCompactionFinalizationComplete,
  clearRecoverableDelegatesChainTokensFold,
  finalizeStagedPostCompactionDelegates,
  listPendingDelegateSessionKeysForRecovery,
  listRecoverableStagedPostCompactionDelegates,
  markPendingDelegateFailed,
  requeueAwaitingNextCompactionDelegates as requeueAwaitingNextCompactionDelegateRows,
} from "./delegate-store.js";
import { checkContinuationBudget, type ChainState } from "./scheduler.js";
import { loadContinuationChainState, persistContinuationChainState } from "./state.js";
import { hasCrossSessionDelegateTargeting } from "./targeting-pure.js";
import type { PendingContinuationDelegate } from "./types.js";

const log = createSubsystemLogger("continuation/delegate-dispatch");

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDelegateTaskForSystemEvent(task: string): string {
  return sanitizeInboundSystemTags(task);
}

function hasActiveSubagentRegistryRun(childSessionKey: string): boolean {
  return isSubagentRunLive(getSubagentRunByChildSessionKey(childSessionKey));
}

function hasAcceptedContinuationChildRun(childSessionKey: string, flowId: string): boolean {
  return hasLiveContinuationDelegateChildRun({ childSessionKey, flowId });
}

export async function recoverPendingContinuationDelegates(
  params: {
    chainState?: ChainState;
    ctx?: Partial<DelegateDispatchContext>;
    maxChainLength?: number;
    /** Override the session-store path used to load persisted chain budgets. */
    storePath?: string;
    /**
     * Startup recovery owns only rows that were already queued when recovery was
     * armed. Rows created later belong to the live post-response drain/hedge.
     */
    queuedCreatedAtOrBefore?: number;
    /** Exclude running rows claimed after recovery was armed. */
    includeRunningUpdatedAtOrBefore?: number;
  } = {},
): Promise<{ sessions: number; dispatched: number; rejected: number }> {
  const runtimeConfig = resolveContinuationRuntimeConfig();
  // Honor the deny-gate across the restart seam: if continuation is disabled,
  // recovery must NOT replay queued/running delegates — re-driving them here
  // would override the user's explicit `continuation.enabled=false`.
  if (!runtimeConfig.enabled) {
    return { sessions: 0, dispatched: 0, rejected: 0 };
  }
  const includeRunningUpdatedAtOrBefore = params.includeRunningUpdatedAtOrBefore ?? Date.now();
  const sessionKeys = listPendingDelegateSessionKeysForRecovery({
    queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore,
    includeRunningUpdatedAtOrBefore,
  });
  const runtimeConfigSnapshot = getRuntimeConfig();
  let dispatched = 0;
  let rejected = 0;
  let recoveredSessions = 0;
  for (const sessionKey of sessionKeys) {
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;
    const storePath =
      params.storePath ?? resolveStorePath(runtimeConfigSnapshot.session?.store, { agentId });
    let recoveredEntry: ReturnType<typeof loadSessionEntry>;
    try {
      recoveredEntry = loadSessionEntry({
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
        sessionKey,
        storePath,
      });
    } catch (err) {
      log.warn(
        `[continuation:delegate-recovery-store-load-failed] path=${storePath} leaving queued/running delegates recoverable: ${formatErrorMessage(err)}`,
      );
      continue;
    }
    let recoveryChainState = params.chainState;
    if (!recoveryChainState) {
      if (!recoveredEntry) {
        log.warn(
          `[continuation:delegate-recovery-session-missing] path=${storePath} session=${sessionKey} leaving queued/running delegates recoverable`,
        );
        continue;
      }
      recoveryChainState = loadContinuationChainState(recoveredEntry);
    }
    recoveredSessions++;
    // Persist the advanced chain state to BOTH the durable store and the
    // in-memory copy this recovery loop reads. The in-memory mirror keeps
    // `loadFreshChainState` fresh so sequential hedge fires for multiple delayed
    // delegates see the advancing basis instead of the stale pre-dispatch entry.
    // When the caller provides their own chainState they own persistence; skip.
    let persistRecoveredChainState: ((nextState: ChainState) => Promise<void>) | undefined;
    if (!params.chainState && recoveredEntry) {
      persistRecoveredChainState = async (nextState: ChainState): Promise<void> => {
        const updated = await updateSessionEntry(
          { sessionKey, storePath },
          (sessionEntry) => {
            persistContinuationChainState({
              sessionEntry,
              count: nextState.currentChainCount,
              startedAt: nextState.chainStartedAt,
              tokens: nextState.accumulatedChainTokens,
              ...(nextState.chainId ? { chainId: nextState.chainId } : {}),
            });
            return sessionEntry;
          },
          { requireWriteSuccess: true },
        );
        if (!updated) {
          throw new Error(`session entry disappeared during recovery: ${sessionKey}`);
        }
        persistContinuationChainState({
          sessionEntry: recoveredEntry,
          count: nextState.currentChainCount,
          startedAt: nextState.chainStartedAt,
          tokens: nextState.accumulatedChainTokens,
          ...(nextState.chainId ? { chainId: nextState.chainId } : {}),
        });
      };
    }
    let result: Awaited<ReturnType<typeof dispatchToolDelegates>>;
    try {
      result = await dispatchToolDelegates({
        sessionKey,
        chainState: recoveryChainState,
        ctx: { ...params.ctx, sessionKey },
        maxChainLength: params.maxChainLength ?? runtimeConfig.maxChainLength,
        recoverRunningDelegates: true,
        queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore,
        includeRunningUpdatedAtOrBefore,
        // Recovery rebuilds chain cost from the persisted child entry, which is
        // stale when the settle-time chain-cost persist failed; apply the
        // delegate's durable fold so the cost cap holds across the restart (#1144).
        applyDelegateChainTokensFold: true,
        // A recovered delayed delegate only arms a hedge here; pass the persist +
        // fresh-load callbacks so the eventual hedge fire durably advances the
        // folded chain state instead of losing it (cost-cap bypass) (#1158).
        ...(persistRecoveredChainState
          ? {
              persistChainState: persistRecoveredChainState,
              persistBeforeTerminalCommit: true,
              loadFreshChainState: () => loadContinuationChainState(recoveredEntry),
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof DelegateTerminalChainStatePersistError) {
        log.warn(
          `[continuation:delegate-recovery-chain-persist-failed] session=${sessionKey} leaving accepted rows recoverable: ${formatErrorMessage(err.originalError)}`,
        );
        continue;
      }
      throw err;
    }
    dispatched += result.dispatched;
    rejected += result.rejected;
    if (persistRecoveredChainState && (result.dispatched > 0 || result.rejected > 0)) {
      if (!result.chainStatePersistedBeforeTerminalCommit) {
        await persistRecoveredChainState(result.chainState);
      }
      if (result.appliedChainTokensFold && result.appliedChainTokensFold > 0) {
        clearRecoverableDelegatesChainTokensFold(sessionKey);
      }
    }
  }
  return { sessions: recoveredSessions, dispatched, rejected };
}

// ---------------------------------------------------------------------------
// Post-compaction delegate dispatch (docs/design/continue-work-signal-v2.md §4.4)
// ---------------------------------------------------------------------------

const postCompactionLog = createSubsystemLogger("continuation/compaction");

function pendingPostCompactionSourceKey(sessionKey: string, sourceFlowId: string): string {
  return `${sessionKey}\0${sourceFlowId}`;
}

function isPendingPostCompactionDeliveryForSourceFlow(
  entry: QueuedSessionDelivery,
): entry is QueuedSessionDelivery & {
  kind: "postCompactionDelegate";
  sourceFlowId: string;
} {
  return entry.kind === "postCompactionDelegate" && typeof entry.sourceFlowId === "string";
}

async function loadPendingPostCompactionDeliverySourceKeys(): Promise<Set<string>> {
  const sourceKeys = new Set<string>();
  for (const entry of await loadPendingSessionDeliveries()) {
    if (!isPendingPostCompactionDeliveryForSourceFlow(entry)) {
      continue;
    }
    sourceKeys.add(pendingPostCompactionSourceKey(entry.sessionKey, entry.sourceFlowId));
  }
  return sourceKeys;
}

export interface PostCompactionSpawnContext {
  agentSessionKey: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
}

/**
 * Dispatch post-compaction delegates with silentAnnounce + wakeOnReturn.
 *
 * This mirrors dispatchToolDelegates but is specifically for post-compaction
 * staged delegates. Errors are logged and surfaced as system events rather
 * than silently swallowed.
 */
export async function dispatchStagedPostCompactionDelegates(
  delegates: Array<{
    task: string;
    targetSessionKey?: string;
    targetSessionKeys?: string[];
    fanoutMode?: "tree" | "all";
    traceparent?: string;
    model?: string;
    /**
     * Optional TaskFlow claim handle. Carried through so a caller (startup
     * recovery) can finalize ONLY the rows whose spawn was accepted, terminalize
     * deterministic rejections, and leave transient failures recoverable (#1158).
     */
    flowId?: string;
    expectedRevision?: number;
  }>,
  sessionKey: string,
  spawnCtx: PostCompactionSpawnContext,
  options?: {
    chainState?: ChainState;
  },
): Promise<{
  dispatched: number;
  failed: number;
  dispatchedFlowIds: string[];
  terminalRejectedFlowIds: string[];
  transientFailedFlowIds: string[];
  chainState: ChainState;
}> {
  let dispatched = 0;
  let failed = 0;
  const dispatchedFlowIds: string[] = [];
  const terminalRejectedFlowIds: string[] = [];
  const transientFailedFlowIds: string[] = [];
  const config = resolveContinuationRuntimeConfig();
  const chainStartedAt = options?.chainState?.chainStartedAt ?? Date.now();
  const accumulatedChainTokens = options?.chainState?.accumulatedChainTokens ?? 0;
  let currentChainCount = options?.chainState?.currentChainCount ?? 0;
  let currentChainId = options?.chainState?.chainId;
  const delegatesWithinLimit = delegates.slice(0, config.maxDelegatesPerTurn);
  const delegatesOverLimit = delegates.slice(config.maxDelegatesPerTurn);

  postCompactionLog.info(
    `[continuation:compaction-delegate] Consuming ${delegates.length} compaction delegate(s) for session ${sessionKey}`,
  );

  const markTerminalRejected = (
    delegate: { flowId?: string; expectedRevision?: number; task: string },
    summary: string,
  ): void => {
    failed++;
    if (markPendingDelegateFailed(delegate, summary, "Post-compaction delegate rejected")) {
      terminalRejectedFlowIds.push(delegate.flowId!);
    }
  };

  const noteTransientFailure = (delegate: { flowId?: string }): void => {
    failed++;
    if (delegate.flowId) {
      transientFailedFlowIds.push(delegate.flowId);
    }
  };

  for (const dropped of delegatesOverLimit) {
    const summary = `Post-compaction delegate rejected: maxDelegatesPerTurn exceeded (${config.maxDelegatesPerTurn}).`;
    postCompactionLog.warn(
      `[continuation:post-compaction-policy-rejected] cap.delegates_per_turn maxDelegatesPerTurn=${config.maxDelegatesPerTurn} session=${sessionKey} task=${dropped.task.slice(0, 80)}`,
    );
    enqueueSystemEvent(
      `[continuation] Post-compaction delegate rejected: maxDelegatesPerTurn exceeded (${config.maxDelegatesPerTurn}). Task: ${formatDelegateTaskForSystemEvent(dropped.task)}`,
      { sessionKey, trusted: true },
    );
    emitContinuationDisabledSpan({
      chainId: undefined,
      chainStepRemaining: Math.max(0, config.maxChainLength - currentChainCount),
      disabledReason: "cap.delegates_per_turn",
      signalKind: "tool-delegate",
      delegateDelivery: "immediate",
      delegateMode: "post-compaction",
      reason: dropped.task,
      log: (message) => postCompactionLog.warn(message),
    });
    markTerminalRejected(dropped, summary);
  }

  for (const delegate of delegatesWithinLimit) {
    if (
      config.crossSessionTargeting === "disabled" &&
      hasCrossSessionDelegateTargeting(delegate, sessionKey)
    ) {
      postCompactionLog.warn(
        `[continuation:post-compaction-policy-rejected] policy.cross_session_targeting session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate rejected: cross-session targeting is disabled by policy. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        { sessionKey, trusted: true },
      );
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: config.maxChainLength,
        disabledReason: "policy.cross_session_targeting",
        signalKind: "tool-delegate",
        delegateDelivery: "immediate",
        delegateMode: "post-compaction",
        reason: delegate.task,
        log: (message) => postCompactionLog.warn(message),
      });
      markTerminalRejected(
        delegate,
        "Post-compaction delegate rejected: cross-session targeting is disabled by policy.",
      );
      continue;
    }

    const budgetCheck = checkContinuationBudget({
      chainState: {
        currentChainCount,
        chainStartedAt,
        accumulatedChainTokens,
      },
      config,
      sessionKey,
    });
    if (budgetCheck) {
      const disabledReason = budgetCheck === "chain-capped" ? "cap.chain" : "cap.cost";
      const summary =
        budgetCheck === "chain-capped"
          ? `chain length ${config.maxChainLength} reached`
          : `cost cap exceeded (${accumulatedChainTokens} > ${config.costCapTokens})`;
      postCompactionLog.warn(
        `[continuation:post-compaction-policy-rejected] ${disabledReason} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate rejected: ${summary}. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        { sessionKey, trusted: true },
      );
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: Math.max(0, config.maxChainLength - currentChainCount),
        disabledReason,
        signalKind: "tool-delegate",
        delegateDelivery: "immediate",
        delegateMode: "post-compaction",
        reason: delegate.task,
        log: (message) => postCompactionLog.warn(message),
      });
      markTerminalRejected(delegate, `Post-compaction delegate rejected: ${summary}.`);
      continue;
    }

    try {
      const spawnTraceparent = resolveContinuationTraceparent(delegate.traceparent);
      const nextHop = currentChainCount + 1;
      const dispatchChainId = currentChainId ?? generateChainId();
      const childSessionKey = delegate.flowId
        ? deriveContinuationDelegateChildSessionKeyFromParent(sessionKey, delegate.flowId)
        : undefined;
      if (
        childSessionKey &&
        (hasActiveSubagentRegistryRun(childSessionKey) ||
          (delegate.flowId && hasAcceptedContinuationChildRun(childSessionKey, delegate.flowId)))
      ) {
        currentChainCount = nextHop;
        currentChainId = dispatchChainId;
        dispatched++;
        dispatchedFlowIds.push(delegate.flowId!);
        continue;
      }
      const spawnResult = await spawnSubagentDirect(
        {
          task:
            `[continuation:post-compaction] ` +
            `[continuation:chain-hop:${nextHop}] ` +
            `Compaction just completed. Carry this working state to the post-compaction session: ${delegate.task}`,
          silentAnnounce: true,
          wakeOnReturn: true,
          drainsContinuationDelegateQueue: true,
          continuationChainState: {
            count: nextHop,
            startedAt: chainStartedAt,
            tokens: accumulatedChainTokens,
            chainId: dispatchChainId,
          },
          ...(delegate.flowId ? { continuationDelegateFlowId: delegate.flowId } : {}),
          ...(delegate.model ? { model: delegate.model } : {}),
          ...(delegate.targetSessionKey
            ? { continuationTargetSessionKey: delegate.targetSessionKey }
            : {}),
          ...(delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0
            ? { continuationTargetSessionKeys: delegate.targetSessionKeys }
            : {}),
          ...(delegate.fanoutMode ? { continuationFanoutMode: delegate.fanoutMode } : {}),
          ...(spawnTraceparent ? { traceparent: spawnTraceparent } : {}),
        },
        spawnCtx,
      );
      if (spawnResult.status === "accepted") {
        currentChainCount = nextHop;
        currentChainId = dispatchChainId;
        dispatched++;
        if (delegate.flowId) {
          dispatchedFlowIds.push(delegate.flowId);
        }
        continue;
      }
      postCompactionLog.warn(
        `[continuation:post-compaction-spawn-rejected] status=${spawnResult.status} session=${sessionKey} reason=${spawnResult.error ?? "not accepted"} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate spawn ${spawnResult.status}: ${spawnResult.error ?? "delegation was not accepted."}. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        { sessionKey, trusted: true },
      );
      if (spawnResult.status === "forbidden") {
        markTerminalRejected(
          delegate,
          `Post-compaction delegate spawn forbidden: ${spawnResult.error ?? "delegation was not accepted."}.`,
        );
      } else {
        noteTransientFailure(delegate);
      }
    } catch (err) {
      postCompactionLog.warn(
        `[continuation:post-compaction-spawn-failed] error=${err instanceof Error ? err.message : String(err)} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate spawn failed: ${String(err)}. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        { sessionKey, trusted: true },
      );
      noteTransientFailure(delegate);
    }
  }

  return {
    dispatched,
    failed,
    dispatchedFlowIds,
    terminalRejectedFlowIds,
    transientFailedFlowIds,
    chainState: {
      currentChainCount,
      chainStartedAt,
      accumulatedChainTokens,
      ...(currentChainId ? { chainId: currentChainId } : {}),
    },
  };
}

/**
 * Startup recovery for post-compaction delegates left `running` by a crash
 * between release-claim and durable handoff (#1144/#1158).
 *
 * The normal consumers of staged post-compaction delegates are the compaction
 * release seams (`dispatchPostCompactionDelegates` / `releasePostCompactionLifecycle`).
 * A row orphaned to `running` by a crash has no further seam for a session that
 * already compacted, so it would sit forever. This re-drives those rows to
 * delivery immediately at startup WITHOUT waiting for another compaction seam:
 * it dispatches only the crash-orphaned `running` rows (never queued
 * awaiting-seam rows, which are staged for a compaction that has not happened),
 * finalizes ONLY the rows whose spawn was accepted, terminalizes deterministic
 * policy/cap/forbidden rejections as failed, and leaves transient spawn
 * failures `running` so they stay recoverable on the next restart — no silent
 * drop, no premature terminalize. At-least-once on the crash seam is
 * intentional.
 *
 * Honors the continuation deny-gate: when continuation is disabled, recovery is
 * a no-op (rows stay recoverable for when it is re-enabled), matching
 * {@link recoverPendingContinuationDelegates}.
 */

export async function requeueAwaitingNextCompactionDelegates(options: {
  runningUpdatedAtOrBefore: number;
}): Promise<{ requeued: number }> {
  return {
    requeued: requeueAwaitingNextCompactionDelegateRows({
      runningUpdatedAtOrBefore: options.runningUpdatedAtOrBefore,
    }),
  };
}

export async function recoverAndReleaseStagedPostCompactionDelegates(options: {
  runningUpdatedAtOrBefore: number;
}): Promise<{ sessions: number; dispatched: number; failed: number }> {
  const runtimeConfig = resolveContinuationRuntimeConfig();
  if (!runtimeConfig.enabled) {
    return { sessions: 0, dispatched: 0, failed: 0 };
  }
  const recoverable = listRecoverableStagedPostCompactionDelegates({
    runningUpdatedAtOrBefore: options.runningUpdatedAtOrBefore,
  });
  if (recoverable.length === 0) {
    return { sessions: 0, dispatched: 0, failed: 0 };
  }
  let pendingDeliverySourceKeys: Set<string>;
  try {
    pendingDeliverySourceKeys = await loadPendingPostCompactionDeliverySourceKeys();
  } catch (err) {
    postCompactionLog.warn(
      `[continuation:post-compaction-recovery-delivery-gate-failed] leaving staged delegates recoverable: ${formatErrorMessage(err)}`,
    );
    return { sessions: 0, dispatched: 0, failed: 0 };
  }

  // Group the crash-orphaned rows by owner session so each session releases once
  // against its own persisted chain-state basis.
  const delegatesBySession = new Map<string, PendingContinuationDelegate[]>();
  for (const { sessionKey, delegate } of recoverable) {
    if (
      delegate.flowId &&
      pendingDeliverySourceKeys.has(pendingPostCompactionSourceKey(sessionKey, delegate.flowId))
    ) {
      postCompactionLog.info(
        `[continuation:post-compaction-recovery-deferred-for-delivery] session=${sessionKey} flowId=${delegate.flowId}`,
      );
      continue;
    }
    const list = delegatesBySession.get(sessionKey) ?? [];
    list.push(delegate);
    delegatesBySession.set(sessionKey, list);
  }
  const runtimeConfigSnapshot = getRuntimeConfig();
  let dispatched = 0;
  let failed = 0;
  let recoveredSessions = 0;
  for (const [sessionKey, delegates] of delegatesBySession) {
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;
    const storePath = resolveStorePath(runtimeConfigSnapshot.session?.store, { agentId });
    let entry: ReturnType<typeof loadSessionEntry>;
    try {
      entry = loadSessionEntry({
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
        sessionKey,
        storePath,
      });
    } catch (err) {
      postCompactionLog.warn(
        `[continuation:post-compaction-recovery-store-load-failed] path=${storePath} leaving staged delegates recoverable: ${formatErrorMessage(err)}`,
      );
      continue;
    }
    if (!entry) {
      postCompactionLog.warn(
        `[continuation:post-compaction-recovery-session-missing] path=${storePath} session=${sessionKey} leaving staged delegates recoverable`,
      );
      continue;
    }
    recoveredSessions++;
    const chainState = loadContinuationChainState(entry);
    const deliveryContext = entry?.deliveryContext;
    const spawnCtx: PostCompactionSpawnContext = {
      agentSessionKey: sessionKey,
      ...(deliveryContext?.channel ? { agentChannel: deliveryContext.channel } : {}),
      ...(deliveryContext?.accountId ? { agentAccountId: deliveryContext.accountId } : {}),
      ...(deliveryContext?.to ? { agentTo: deliveryContext.to } : {}),
      ...(deliveryContext?.threadId !== undefined
        ? { agentThreadId: deliveryContext.threadId }
        : {}),
    };
    const result = await dispatchStagedPostCompactionDelegates(delegates, sessionKey, spawnCtx, {
      chainState,
    });
    dispatched += result.dispatched;
    failed += result.failed;
    // Finalize ONLY the rows whose spawn was accepted. Deterministic policy/cap
    // rejections (including spawn-forbidden) were failed by
    // dispatchStagedPostCompactionDelegates; transient spawn failures keep
    // `running` status and unchanged updatedAt (at/before this boot cutoff), so
    // the next restart recovers them again — never a silent drop or premature
    // finish.
    if (result.dispatchedFlowIds.length > 0) {
      try {
        const updated = await updateSessionEntry(
          { sessionKey, storePath },
          (sessionEntry) => {
            persistContinuationChainState({
              sessionEntry,
              count: result.chainState.currentChainCount,
              startedAt: result.chainState.chainStartedAt,
              tokens: result.chainState.accumulatedChainTokens,
              ...(result.chainState.chainId ? { chainId: result.chainState.chainId } : {}),
            });
            return sessionEntry;
          },
          { requireWriteSuccess: true },
        );
        if (!updated) {
          throw new Error(`session entry disappeared during recovery: ${sessionKey}`);
        }
      } catch (err) {
        postCompactionLog.warn(
          `[continuation:post-compaction-recovery-chain-persist-failed] session=${sessionKey} leaving accepted rows recoverable: ${formatErrorMessage(err)}`,
        );
        continue;
      }
      persistContinuationChainState({
        sessionEntry: entry,
        count: result.chainState.currentChainCount,
        startedAt: result.chainState.chainStartedAt,
        tokens: result.chainState.accumulatedChainTokens,
        ...(result.chainState.chainId ? { chainId: result.chainState.chainId } : {}),
      });
      const finalized = finalizeStagedPostCompactionDelegates(result.dispatchedFlowIds);
      assertStagedPostCompactionFinalizationComplete({
        flowIds: result.dispatchedFlowIds,
        finalized,
        context: `post-compaction startup recovery for ${sessionKey}`,
      });
    }
  }
  return { sessions: recoveredSessions, dispatched, failed };
}
