/** Stateless startup and post-compaction recovery for continuation delegates. */

import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  loadPendingSessionDeliveries,
  type QueuedSessionDelivery,
} from "../../infra/session-delivery-queue-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import { DelegateTerminalChainStatePersistError } from "./delegate-dispatch-chain-state.js";
import type { DelegateDispatchContext } from "./delegate-dispatch-contract.js";
import { dispatchToolDelegates } from "./delegate-dispatch.js";
import {
  assertStagedPostCompactionFinalizationComplete,
  finalizeStagedPostCompactionDelegates,
  listRecoverableStagedPostCompactionDelegates,
  requeueAwaitingNextCompactionDelegatesRaw as requeueAwaitingNextCompactionDelegateRows,
} from "./delegate-store-post-compaction.js";
import {
  classifyRecoverablePendingDelegates,
  clearRecoverableDelegatesChainTokensFold,
  listPendingDelegateSessionKeysForRecovery,
} from "./delegate-store.js";
import {
  dispatchStagedPostCompactionDelegates,
  type PostCompactionSpawnContext,
} from "./post-compaction-staged-dispatch.js";
import type { ChainState } from "./scheduler.js";
import { loadContinuationChainState, persistContinuationChainState } from "./state.js";
import type { PendingContinuationDelegate } from "./types.js";

const log = createSubsystemLogger("continuation/delegate-dispatch");

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const includeRunningUpdatedAtOrBefore = params.includeRunningUpdatedAtOrBefore ?? Date.now();
  classifyRecoverablePendingDelegates({
    queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore,
    includeRunningUpdatedAtOrBefore,
  });
  // Honor the deny-gate across the restart seam: if continuation is disabled,
  // recovery must NOT replay valid queued/running delegates — re-driving them
  // here would override the user's explicit `continuation.enabled=false`.
  if (!runtimeConfig.enabled) {
    return { sessions: 0, dispatched: 0, rejected: 0 };
  }
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
      params.storePath ??
      resolveSessionStorePathCore(runtimeConfigSnapshot.session?.store, { agentId });
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
        // delegate's durable fold so the cost cap holds across the restart.
        applyDelegateChainTokensFold: true,
        // A recovered delayed delegate only arms a hedge here; pass the persist +
        // fresh-load callbacks so the eventual hedge fire durably advances the
        // folded chain state instead of losing it (cost-cap bypass).
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
// Post-compaction delegate startup recovery (docs/design/continue-work-signal-v2.md §4.4)
// ---------------------------------------------------------------------------

const postCompactionRecoveryLog = createSubsystemLogger("continuation/compaction");

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

/**
 * Startup recovery for post-compaction delegates left `running` by a crash
 * between release-claim and durable handoff.
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
 * Honors the continuation deny-gate: when continuation is disabled, recovery
 * classifies cutoff-eligible crash-orphans only to dead-letter malformed rows,
 * then performs no dispatch. Valid rows stay recoverable for when it is
 * re-enabled, matching {@link recoverPendingContinuationDelegates}.
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
    postCompactionRecoveryLog.warn(
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
      postCompactionRecoveryLog.info(
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
    const storePath = resolveSessionStorePathCore(runtimeConfigSnapshot.session?.store, {
      agentId,
    });
    let entry: ReturnType<typeof loadSessionEntry>;
    try {
      entry = loadSessionEntry({
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
        sessionKey,
        storePath,
      });
    } catch (err) {
      postCompactionRecoveryLog.warn(
        `[continuation:post-compaction-recovery-store-load-failed] path=${storePath} leaving staged delegates recoverable: ${formatErrorMessage(err)}`,
      );
      continue;
    }
    if (!entry) {
      postCompactionRecoveryLog.warn(
        `[continuation:post-compaction-recovery-session-missing] path=${storePath} session=${sessionKey} leaving staged delegates recoverable`,
      );
      continue;
    }
    recoveredSessions++;
    const chainState = loadContinuationChainState(entry);
    const deliveryContext = deliveryContextFromSession(entry);
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
      holdPendingWhileDisabled: true,
      finalizeAcceptedFlow: async ({ flowId, chainState: acceptedChainState }) => {
        const updated = await updateSessionEntry(
          { sessionKey, storePath },
          (sessionEntry) => {
            persistContinuationChainState({
              sessionEntry,
              count: acceptedChainState.currentChainCount,
              startedAt: acceptedChainState.chainStartedAt,
              tokens: acceptedChainState.accumulatedChainTokens,
              ...(acceptedChainState.chainId ? { chainId: acceptedChainState.chainId } : {}),
            });
            return sessionEntry;
          },
          { requireWriteSuccess: true },
        );
        if (!updated) {
          throw new Error(`session entry disappeared during recovery: ${sessionKey}`);
        }
        persistContinuationChainState({
          sessionEntry: entry,
          count: acceptedChainState.currentChainCount,
          startedAt: acceptedChainState.chainStartedAt,
          tokens: acceptedChainState.accumulatedChainTokens,
          ...(acceptedChainState.chainId ? { chainId: acceptedChainState.chainId } : {}),
        });
        const finalized = finalizeStagedPostCompactionDelegates([flowId]);
        assertStagedPostCompactionFinalizationComplete({
          flowIds: [flowId],
          finalized,
          context: `post-compaction startup recovery for ${sessionKey}`,
        });
      },
    });
    dispatched += result.dispatched;
    failed += result.failed;
  }
  return { sessions: recoveredSessions, dispatched, failed };
}
