/**
 * Continuation delegate dispatch — spawn logic for both immediate and delayed delegates.
 *
 * Consumes pending delegates from the store and dispatches them via spawnSubagentDirect.
 * Handles per-turn cap enforcement, chain-hop prefix, and mode flags.
 *
 * OBSERVABILITY: every spawn outcome (accepted/rejected/failed) is logged at info level,
 * regardless of whether the spawn was immediate or timer-triggered. The old branch gated
 * success logging behind `timerTriggered`, making immediate delegates invisible to operators.
 * Do not reproduce this.
 *
 * RFC: docs/design/continue-work-signal-v2.md §3.2, §3.4
 */

import { deriveContinuationDelegateChildSessionKeyFromParent } from "../../agents/subagent-continuation-ids.js";
import {
  getSubagentRunByChildSessionKey,
  hasLiveContinuationDelegateChildRun,
  isSubagentRunLive,
} from "../../agents/subagent-registry-read.js";
import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import type { SpawnSubagentContext } from "../../agents/subagent-spawn.js";
import {
  emitContinuationDelegateFireSpan,
  emitContinuationDisabledSpan,
  resolveContinuationTraceparent,
  startContinuationDelegateSpan,
} from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { sanitizeInboundSystemTags } from "../../security/system-tags.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import {
  annotateQueuedDelegatesInheritedPolicy,
  clearRecoverableDelegatesChainTokensFold,
  consumePendingDelegates,
  markPendingDelegateChainStatePersistPlanned,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
  peekSoonestUnmaturedDelegateDueAt,
} from "./delegate-store.js";
import { checkContinuationBudget, type ChainState } from "./scheduler.js";
import {
  registerContinuationTimerHandle,
  retainContinuationTimerRef,
  unregisterContinuationTimerHandle,
} from "./state.js";
import { hasCrossSessionDelegateTargeting } from "./targeting-pure.js";
import type { ContinuationRuntimeConfig, PendingContinuationDelegate } from "./types.js";

const log = createSubsystemLogger("continuation/delegate-dispatch");
const HEDGE_DISPATCH_FAILURE_RETRY_MS = 30_000;

// Per-session hedge timer for re-checking unmatured pending delegates in fully
// quiet channels (no further response-finalize event). Idempotent per
// sessionKey: a fresh dispatch call cancels + replaces any existing hedge.
const hedgeTimers = new Map<string, NodeJS.Timeout>();

function clearHedgeTimer(sessionKey: string): void {
  const existing = hedgeTimers.get(sessionKey);
  if (existing) {
    clearTimeout(existing);
    hedgeTimers.delete(sessionKey);
    unregisterContinuationTimerHandle(sessionKey, existing);
  }
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDelegateTaskForSystemEvent(task: string): string {
  return sanitizeInboundSystemTags(task);
}

function surfaceHedgeDispatchFailure(sessionKey: string, errorMessage: string): void {
  try {
    enqueueSystemEvent(
      `[system:continuation-warning] Hedge-timer dispatch failed; queued delegates may be orphaned. Error: ${errorMessage}. Re-issue continue_delegate if the work is still needed.`,
      { sessionKey, trusted: true },
    );
  } catch (err) {
    log.error(
      `[continuation:delegate-hedge-event-error] error=${formatErrorMessage(err)} session=${sessionKey}`,
    );
  }
}

/** @internal One-way recovery classifier for persist-before-terminal failures. */
export class DelegateTerminalChainStatePersistError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(formatErrorMessage(originalError));
    this.name = "DelegateTerminalChainStatePersistError";
    this.originalError = originalError;
  }
}

async function persistChainStateBeforeTerminalCommit(
  params: {
    persistBeforeTerminalCommit?: boolean;
    persistChainState?: (chainState: ChainState) => void | Promise<void>;
  },
  delegate: PendingContinuationDelegate,
  chainState: ChainState,
  options: { markPlannedChainState?: boolean; markerKind?: "advanced" | "terminal" } = {},
): Promise<PendingContinuationDelegate> {
  if (!params.persistBeforeTerminalCommit || !params.persistChainState) {
    return delegate;
  }
  try {
    const plannedDelegate = options.markPlannedChainState
      ? markPendingDelegateChainStatePersistPlanned(
          delegate,
          chainState,
          options.markerKind ?? "advanced",
        )
      : delegate;
    await params.persistChainState(chainState);
    return plannedDelegate;
  } catch (err) {
    throw new DelegateTerminalChainStatePersistError(err);
  }
}

function armHedgeTimer(
  sessionKey: string,
  fireAt: number,
  params: {
    chainState: ChainState;
    ctx: DelegateDispatchContext;
    maxChainLength: number;
    config?: ContinuationRuntimeConfig;
    loadFreshChainState?: () => ChainState;
    applyDelegateChainTokensFold?: boolean;
    persistChainState?: (chainState: ChainState) => void | Promise<void>;
    persistBeforeTerminalCommit?: boolean;
    recoverRunningDelegates?: boolean;
    queuedCreatedAtOrBefore?: number;
    includeRunningUpdatedAtOrBefore?: number;
    inheritedSilent?: boolean;
    inheritedWake?: boolean;
  },
): void {
  clearHedgeTimer(sessionKey);
  const fireIn = Math.max(0, fireAt - Date.now());
  log.info(
    `[continuation:delegate-hedge-armed] fireIn=${fireIn}ms fireAt=${fireAt} session=${sessionKey}`,
  );
  retainContinuationTimerRef(sessionKey);
  const handle = setTimeout(() => {
    hedgeTimers.delete(sessionKey);
    // Release ref + handle registration on natural fire (matches
    // clearHedgeTimer on cancel). Without this, every hedge that fires
    // naturally leaks a timer-ref and handle, keeping continuation state
    // alive past its useful lifetime.
    unregisterContinuationTimerHandle(sessionKey, handle);
    log.info(`[continuation:delegate-hedge-fired] session=${sessionKey}`);
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      // Re-load chain state at fire time when the caller supplies a
      // fresh-loader. The originally-captured `params.chainState`
      // is a snapshot from when the hedge was armed and may understate
      // currentChainCount if other dispatches advanced it in between. The
      // hedge must enforce the chain-budget against the latest persisted
      // state, not the snapshot.
      const refreshedChainState = params.loadFreshChainState
        ? params.loadFreshChainState()
        : params.chainState;
      const result = await dispatchToolDelegates({
        sessionKey,
        chainState: refreshedChainState,
        ctx: params.ctx,
        maxChainLength: params.maxChainLength,
        ...(params.config ? { config: params.config } : {}),
        loadFreshChainState: params.loadFreshChainState,
        // Carry the recovery fold flag across the hedge: a recovered delayed
        // delegate annotated with `chainTokensFold` after a child chain-cost
        // persist failure must still be checked against the folded (not stale)
        // basis when its delay elapses and the hedge re-dispatches it.
        ...(params.applyDelegateChainTokensFold ? { applyDelegateChainTokensFold: true } : {}),
        persistChainState: params.persistChainState,
        ...(params.persistBeforeTerminalCommit || params.persistChainState
          ? { persistBeforeTerminalCommit: true }
          : {}),
        ...(params.recoverRunningDelegates ? { recoverRunningDelegates: true } : {}),
        ...(params.queuedCreatedAtOrBefore !== undefined
          ? { queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore }
          : {}),
        ...(params.includeRunningUpdatedAtOrBefore !== undefined
          ? { includeRunningUpdatedAtOrBefore: params.includeRunningUpdatedAtOrBefore }
          : {}),
        // Inherited silent/wake policy must survive the hedge: a delayed delegate
        // armed by a silent/wake parent chain must still spawn internal when the
        // hedge finally dispatches it, not announce to the channel.
        ...(params.inheritedSilent ? { inheritedSilent: true } : {}),
        ...(params.inheritedWake ? { inheritedWake: true } : {}),
      });
      if (params.persistChainState && (result.dispatched > 0 || result.rejected > 0)) {
        if (!result.chainStatePersistedBeforeTerminalCommit) {
          await params.persistChainState(result.chainState);
        }
        if (result.appliedChainTokensFold && result.appliedChainTokensFold > 0) {
          clearRecoverableDelegatesChainTokensFold(sessionKey);
        }
      }
    }).catch((err: unknown) => {
      const errorMessage = formatErrorMessage(err);
      log.error(`[continuation:delegate-hedge-error] error=${errorMessage} session=${sessionKey}`);
      surfaceHedgeDispatchFailure(sessionKey, errorMessage);
      try {
        armHedgeTimer(sessionKey, Date.now() + HEDGE_DISPATCH_FAILURE_RETRY_MS, {
          ...params,
          ...(params.persistChainState ? { persistBeforeTerminalCommit: true } : {}),
          recoverRunningDelegates: true,
          includeRunningUpdatedAtOrBefore: Date.now(),
        });
      } catch (rearmErr) {
        log.error(
          `[continuation:delegate-hedge-rearm-error] error=${formatErrorMessage(rearmErr)} session=${sessionKey}`,
        );
      }
    });
  }, fireIn);
  registerContinuationTimerHandle(sessionKey, handle);
  handle.unref();
  hedgeTimers.set(sessionKey, handle);
}

/**
 * Test-only: cancel any pending hedge timers and clear the registry.
 */
export function resetDelegateDispatchHedgesForTests(): void {
  for (const [sessionKey, handle] of hedgeTimers) {
    clearTimeout(handle);
    unregisterContinuationTimerHandle(sessionKey, handle);
  }
  hedgeTimers.clear();
}

export type DelegateDispatchContext = {
  sessionKey: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
};

/**
 * Consume and dispatch all pending tool-dispatched delegates for a session.
 *
 * Called by agent-runner.ts after the response finalizes.
 * Each delegate goes through chain/cost enforcement and is spawned via spawnSubagentDirect.
 */

function hasActiveSubagentRegistryRun(childSessionKey: string): boolean {
  return isSubagentRunLive(getSubagentRunByChildSessionKey(childSessionKey));
}

function hasAcceptedContinuationChildRun(childSessionKey: string, flowId: string): boolean {
  return hasLiveContinuationDelegateChildRun({ childSessionKey, flowId });
}

function markDelegateFailed(
  delegate: { flowId?: string; expectedRevision?: number; task: string },
  summary: string,
): boolean {
  return markPendingDelegateFailed(delegate, summary);
}

export async function dispatchToolDelegates(params: {
  sessionKey: string;
  chainState: ChainState;
  ctx: DelegateDispatchContext;
  maxChainLength: number;
  /**
   * Resolved runtime config for the active run. Callers with scoped/runtime
   * snapshots should pass it so delegate caps match the turn that queued them.
   */
  config?: ContinuationRuntimeConfig;
  /**
   * Delegate slots already consumed by another continuation signal in the same
   * turn, e.g. a bracket-style CONTINUE_DELEGATE.
   */
  reservedDelegateSlots?: number;
  /**
   * Optional callback the hedge timer invokes to re-load the chain state
   * from the persisted session entry at fire time, so the re-dispatch sees
   * any chain-count advancement that happened while the timer was pending.
   * Without this the hedge captures a stale `chainState` snapshot and may
   * dispatch past `maxChainLength`.
   */
  loadFreshChainState?: () => ChainState;
  recoverRunningDelegates?: boolean;
  queuedCreatedAtOrBefore?: number;
  includeRunningUpdatedAtOrBefore?: number;
  /**
   * Dispatch queued delegates immediately even if their `delayMs` has not
   * elapsed. Fail-closed lever for the child chain-cost persist-failure path:
   * a delayed delegate left durably queued would recover from the stale child
   * entry and under-enforce the cost cap, so dispatch it now on the correct
   * in-memory folded basis instead.
   */
  dispatchQueuedRegardlessOfDelay?: boolean;
  /**
   * When true, add each consumed delegate's durable `chainTokensFold` to the
   * chain cost basis. Set by restart recovery: recovery rebuilds chain cost from
   * the child session entry, which is stale (missing this run's tokens) when the
   * settle-time persist failed; the delegate carries the fold so the cost cap is
   * still enforced against the post-run total. Live dispatch leaves this
   * unset because the live drain already folds the cost into `chainState`.
   */
  applyDelegateChainTokensFold?: boolean;
  /**
   * Optional callback used by hedge-fired dispatches, where there is no
   * enclosing runner finalize frame to persist the advanced chain state.
   */
  persistChainState?: (chainState: ChainState) => void | Promise<void>;
  /**
   * Recovery paths must persist the advanced/folded chain state before they
   * terminalize a claimed TaskFlow row. If the write fails, the row stays
   * `running` so the next recovery can reconcile an already-accepted child
   * without losing the only durable chain-cost fold.
   */
  persistBeforeTerminalCommit?: boolean;
  /**
   * Inherited silent/wake policy from a silent/wake parent continuation chain.
   * When set, a consumed delegate with its own `mode` unset (normal) still
   * spawns internal (silent) — and wakes on return when `inheritedWake` is also
   * set — instead of announcing to the channel. Mirrors the `parentWasSilent`
   * handling the subagent-announce chain-hop guards apply, so descendants of a
   * silent/wake chain drained early stay internal.
   */
  inheritedSilent?: boolean;
  inheritedWake?: boolean;
}): Promise<{
  dispatched: number;
  rejected: number;
  chainState: ChainState;
  appliedChainTokensFold?: number;
  chainStatePersistedBeforeTerminalCommit?: boolean;
}> {
  const { sessionKey, chainState, ctx } = params;
  const config = params.config ?? resolveContinuationRuntimeConfig();
  // Fail closed: applying a delegate chain-cost fold requires a persist path so
  // a hedge armed for a still-unmatured delegate can durably advance the folded
  // chain state when it fires. Without `persistChainState` the hedge would fold
  // the cost only in memory and lose it (later hops rebuild from the stale entry
  // and bypass the cost cap), so force immediate dispatch here instead of arming
  // a lossy hedge.
  const foldWithoutPersist =
    params.applyDelegateChainTokensFold === true && !params.persistChainState;
  const ignoreDelay = params.dispatchQueuedRegardlessOfDelay === true || foldWithoutPersist;
  const toolDelegates = consumePendingDelegates(sessionKey, {
    includeRunning: params.recoverRunningDelegates === true,
    queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore,
    includeRunningUpdatedAtOrBefore: params.includeRunningUpdatedAtOrBefore,
    ignoreDelay,
  });

  // Arm (or re-arm) a hedge timer for any unmatured queued delegates so they
  // still fire in fully-quiet channels where no further response-finalize
  // arrives. The hedge re-invokes this function; idempotent per sessionKey.
  const soonestUnmaturedDueAt = peekSoonestUnmaturedDelegateDueAt(sessionKey, {
    queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore,
  });
  if (soonestUnmaturedDueAt !== undefined) {
    annotateQueuedDelegatesInheritedPolicy(sessionKey, {
      ...(params.inheritedSilent ? { inheritedSilent: true } : {}),
      ...(params.inheritedWake ? { inheritedWake: true } : {}),
    });
    armHedgeTimer(sessionKey, soonestUnmaturedDueAt, {
      chainState: params.chainState,
      ctx: params.ctx,
      maxChainLength: params.maxChainLength,
      ...(params.config ? { config: params.config } : {}),
      loadFreshChainState: params.loadFreshChainState,
      ...(params.applyDelegateChainTokensFold ? { applyDelegateChainTokensFold: true } : {}),
      persistChainState: params.persistChainState,
      ...(params.persistBeforeTerminalCommit ? { persistBeforeTerminalCommit: true } : {}),
      ...(params.recoverRunningDelegates ? { recoverRunningDelegates: true } : {}),
      ...(params.queuedCreatedAtOrBefore !== undefined
        ? { queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore }
        : {}),
      ...(params.includeRunningUpdatedAtOrBefore !== undefined
        ? { includeRunningUpdatedAtOrBefore: params.includeRunningUpdatedAtOrBefore }
        : {}),
      ...(params.inheritedSilent ? { inheritedSilent: true } : {}),
      ...(params.inheritedWake ? { inheritedWake: true } : {}),
    });
  } else {
    clearHedgeTimer(sessionKey);
  }

  if (toolDelegates.length === 0) {
    return { dispatched: 0, rejected: 0, chainState };
  }

  log.info(
    `[continue_delegate] Consuming ${toolDelegates.length} tool delegate(s) for session ${sessionKey}`,
  );

  const { maxDelegatesPerTurn, maxChainLength, crossSessionTargeting } = config;
  const delegateSlotsAvailable = Math.max(
    0,
    maxDelegatesPerTurn - (params.reservedDelegateSlots ?? 0),
  );
  const delegatesWithinLimit = toolDelegates.slice(0, delegateSlotsAvailable);
  const delegatesOverLimit = toolDelegates.slice(delegateSlotsAvailable);
  let dispatched = 0;
  let rejected = delegatesOverLimit.length;
  let currentChainCount = chainState.currentChainCount;
  // Restart recovery rebuilds `chainState` from the (possibly stale) child
  // session entry; add the delegate's durable chain-cost fold so the cost cap is
  // enforced against the post-run total. Applied once (the fold is a per-child
  // shared cost carried identically on each of the child's delegates), and only
  // when the caller opts in — live dispatch already folds it into `chainState`
  //.
  const appliedChainTokensFold = params.applyDelegateChainTokensFold
    ? Math.max(0, ...toolDelegates.map((delegate) => delegate.chainTokensFold ?? 0))
    : 0;
  let currentAccumulatedTokens = chainState.accumulatedChainTokens + appliedChainTokensFold;
  let currentChainId = chainState.chainId;
  let chainStatePersistedBeforeTerminalCommit = false;
  const currentTerminalChainState = (): ChainState => ({
    currentChainCount,
    chainStartedAt: chainState.chainStartedAt,
    accumulatedChainTokens: currentAccumulatedTokens,
    ...(currentChainId ? { chainId: currentChainId } : {}),
  });
  const terminalChainStateForDelegate = (delegate: PendingContinuationDelegate): ChainState =>
    delegate.persistedChainState ?? currentTerminalChainState();
  const persistTerminalChainState = async (
    delegate: PendingContinuationDelegate,
    nextState: ChainState,
    options: { markPlannedChainState?: boolean; markerKind?: "advanced" | "terminal" } = {},
  ): Promise<PendingContinuationDelegate> => {
    const updatedDelegate = await persistChainStateBeforeTerminalCommit(
      params,
      delegate,
      nextState,
      options,
    );
    if (params.persistBeforeTerminalCommit && params.persistChainState) {
      chainStatePersistedBeforeTerminalCommit = true;
    }
    return updatedDelegate;
  };

  for (const dropped of delegatesOverLimit) {
    const summary = `Tool delegate rejected: maxDelegatesPerTurn exceeded (${maxDelegatesPerTurn}).`;
    log.info(
      `[continuation:delegate-rejected] maxDelegatesPerTurn=${maxDelegatesPerTurn} task=${dropped.task.slice(0, 80)} session=${sessionKey}`,
    );
    const failedDelegate = await persistTerminalChainState(
      dropped,
      terminalChainStateForDelegate(dropped),
      {
        markPlannedChainState: appliedChainTokensFold > 0,
        markerKind: "terminal",
      },
    );
    markDelegateFailed(failedDelegate, summary);
    enqueueSystemEvent(
      `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(dropped.task)}`,
      {
        sessionKey,
        trusted: true,
      },
    );
  }

  for (const delegate of delegatesWithinLimit) {
    const spawnSessionKey = delegate.spawnRequesterSessionKey ?? sessionKey;
    const childSessionKey = delegate.flowId
      ? deriveContinuationDelegateChildSessionKeyFromParent(spawnSessionKey, delegate.flowId)
      : undefined;
    const acceptedChildAlreadyKnown = Boolean(
      childSessionKey &&
      (hasActiveSubagentRegistryRun(childSessionKey) ||
        (delegate.flowId && hasAcceptedContinuationChildRun(childSessionKey, delegate.flowId))),
    );
    if (
      crossSessionTargeting === "disabled" &&
      hasCrossSessionDelegateTargeting(delegate, sessionKey)
    ) {
      const delegateMode = delegate.mode ?? "normal";
      const delegateDelivery: "immediate" | "timer" =
        delegate.delayMs && delegate.delayMs > 0 ? "timer" : "immediate";
      const summary = "Tool delegate rejected: cross-session targeting is disabled by policy.";
      log.info(
        `[continuation:delegate-rejected] policy.cross_session_targeting task=${delegate.task.slice(0, 80)} session=${sessionKey}`,
      );
      const failedDelegate = await persistTerminalChainState(
        delegate,
        terminalChainStateForDelegate(delegate),
        {
          markPlannedChainState: appliedChainTokensFold > 0,
          markerKind: "terminal",
        },
      );
      markDelegateFailed(failedDelegate, summary);
      enqueueSystemEvent(
        `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        {
          sessionKey,
          trusted: true,
        },
      );
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: Math.max(0, maxChainLength - currentChainCount),
        disabledReason: "policy.cross_session_targeting",
        signalKind: "tool-delegate",
        delegateDelivery,
        delegateMode,
        reason: delegate.task,
        log: (message) => log.info(message),
      });
      rejected++;
      continue;
    }

    const persistedChainStateKind = delegate.persistedChainStateKind ?? "advanced";
    const budgetChainState: ChainState = delegate.persistedChainState
      ? {
          currentChainCount:
            persistedChainStateKind === "advanced"
              ? Math.max(0, delegate.persistedChainState.currentChainCount - 1)
              : delegate.persistedChainState.currentChainCount,
          chainStartedAt: delegate.persistedChainState.chainStartedAt,
          accumulatedChainTokens: delegate.persistedChainState.accumulatedChainTokens,
          ...(delegate.persistedChainState.chainId
            ? { chainId: delegate.persistedChainState.chainId }
            : {}),
        }
      : {
          currentChainCount,
          chainStartedAt: chainState.chainStartedAt,
          accumulatedChainTokens: currentAccumulatedTokens,
          ...(currentChainId ? { chainId: currentChainId } : {}),
        };
    const budgetCheck =
      delegate.persistedChainState && acceptedChildAlreadyKnown
        ? undefined
        : checkContinuationBudget({
            chainState: budgetChainState,
            config,
            sessionKey,
          });

    if (budgetCheck) {
      const summary = `Tool delegate rejected: ${budgetCheck}.`;
      log.info(
        `[continuation:delegate-rejected] ${budgetCheck} task=${delegate.task.slice(0, 80)} session=${sessionKey}`,
      );
      const failedDelegate = await persistTerminalChainState(
        delegate,
        terminalChainStateForDelegate(delegate),
        {
          markPlannedChainState: appliedChainTokensFold > 0,
          markerKind: "terminal",
        },
      );
      markDelegateFailed(failedDelegate, summary);
      enqueueSystemEvent(
        `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        {
          sessionKey,
          trusted: true,
        },
      );
      rejected++;
      continue;
    }

    const nextHop =
      delegate.persistedChainState && persistedChainStateKind === "advanced"
        ? delegate.persistedChainState.currentChainCount
        : currentChainCount + 1;
    const delegateAccumulatedTokens =
      delegate.persistedChainState?.accumulatedChainTokens ?? currentAccumulatedTokens;
    const dispatchChainId =
      delegate.persistedChainState?.chainId ?? currentChainId ?? generateChainId();
    const plannedTerminalChainState: ChainState = {
      currentChainCount: nextHop,
      chainStartedAt: delegate.persistedChainState?.chainStartedAt ?? chainState.chainStartedAt,
      accumulatedChainTokens: delegateAccumulatedTokens,
      ...(dispatchChainId ? { chainId: dispatchChainId } : {}),
    };
    const commitPlannedChainState = (chainId: string | undefined): void => {
      dispatched++;
      currentChainCount = nextHop;
      currentAccumulatedTokens = delegateAccumulatedTokens;
      currentChainId = chainId ?? currentChainId;
    };

    // Own mode wins; otherwise inherit the parent chain's silent/wake policy so a
    // default-mode delegate spawned under a silent/wake chain stays internal
    // instead of announcing (mirrors the subagent-announce chain-hop guards).
    const ownSilent = delegate.mode === "silent" || delegate.mode === "silent-wake";
    const ownWake = delegate.mode === "silent-wake";
    const canInheritMode = delegate.mode === undefined || delegate.mode === "normal";
    const inheritedSilent = delegate.inheritedSilent === true || params.inheritedSilent === true;
    const inheritedWake = delegate.inheritedWake === true || params.inheritedWake === true;
    const silent = ownSilent || (canInheritMode && inheritedSilent);
    const silentWake = ownWake || (canInheritMode && inheritedSilent && inheritedWake);
    const outboundTraceparent = resolveContinuationTraceparent(delegate.traceparent);
    const delegateMode = silentWake ? "silent-wake" : silent ? "silent" : "normal";
    const delegateDelayMs = delegate.delayMs ?? 0;
    const delegateDelivery: "immediate" | "timer" = delegateDelayMs > 0 ? "timer" : "immediate";

    const spawnCtx: SpawnSubagentContext = {
      agentSessionKey: spawnSessionKey,
      agentChannel: delegate.spawnRequesterChannel ?? ctx.agentChannel,
      agentAccountId: delegate.spawnRequesterAccountId ?? ctx.agentAccountId,
      agentTo: delegate.spawnRequesterTo ?? ctx.agentTo,
      agentThreadId: delegate.spawnRequesterThreadId ?? ctx.agentThreadId,
    };

    let dispatchSpan: ReturnType<typeof startContinuationDelegateSpan> | undefined;
    try {
      if (delegateDelivery === "timer") {
        emitContinuationDelegateFireSpan({
          chainId: dispatchChainId,
          chainStepRemainingAtDispatch: maxChainLength - nextHop,
          delegateMode,
          delayMs: delegateDelayMs,
          fireDeferredMs: Date.now() - (delegate.firstArmedAt ?? Date.now()),
          reason: delegate.task,
          traceparent: outboundTraceparent,
          log: (message) => log.info(message),
        });
      }
      dispatchSpan = startContinuationDelegateSpan({
        chainId: dispatchChainId,
        chainStepRemaining: maxChainLength - nextHop,
        delayMs: delegateDelayMs,
        delivery: delegateDelivery,
        delegateMode,
        reason: delegate.task,
        traceparent: outboundTraceparent,
        log: (message) => log.info(message),
      });
      const spawnTraceparent = dispatchSpan.traceparent?.() ?? outboundTraceparent;
      if (childSessionKey && acceptedChildAlreadyKnown) {
        const acceptedDelegate = await persistTerminalChainState(
          delegate,
          plannedTerminalChainState,
          { markPlannedChainState: true, markerKind: "advanced" },
        );
        try {
          markPendingDelegateSpawnAccepted(
            acceptedDelegate,
            childSessionKey,
            params.persistChainState ? { requireWriteSuccess: true } : {},
          );
        } catch (err) {
          const errorMessage = formatErrorMessage(err);
          log.warn(
            `[continuation:delegate-accept-finalize-failed] flowId=${delegate.flowId ?? "unknown"} session=${sessionKey} leaving row recoverable: ${errorMessage}`,
          );
          dispatchSpan.setStatus("ERROR", errorMessage);
          rejected++;
          continue;
        }
        dispatchSpan.setStatus("OK");
        commitPlannedChainState(dispatchChainId);
        continue;
      }
      const result = await spawnSubagentDirect(
        {
          task: `[continuation:chain-hop:${nextHop}] Delegated task (turn ${nextHop}/${maxChainLength}): ${delegate.task}`,
          drainsContinuationDelegateQueue: true,
          continuationChainState: {
            count: nextHop,
            startedAt: plannedTerminalChainState.chainStartedAt,
            tokens: delegateAccumulatedTokens,
            chainId: dispatchChainId,
          },
          ...(delegate.model ? { model: delegate.model } : {}),
          ...(delegate.attachments ? { attachments: delegate.attachments } : {}),
          ...(delegate.attachAs?.mountPath ? { attachMountPath: delegate.attachAs.mountPath } : {}),
          ...(delegate.flowId ? { continuationDelegateFlowId: delegate.flowId } : {}),
          ...(silent ? { silentAnnounce: true } : {}),
          ...(silentWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
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

      if (result.status === "accepted") {
        // INFO-level on EVERY successful spawn — observability parity.
        log.info(
          `[continuation:delegate-spawned] hop=${nextHop}/${maxChainLength} mode=${delegate.mode ?? "normal"} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
        );
        enqueueSystemEvent(
          `[continuation:delegate-spawned] Spawned turn ${nextHop}/${maxChainLength}: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
          { sessionKey, trusted: true },
        );
        const acceptedChildSessionKey = result.childSessionKey ?? childSessionKey;
        const acceptedDelegate = await persistTerminalChainState(
          delegate,
          plannedTerminalChainState,
          { markPlannedChainState: true, markerKind: "advanced" },
        );
        if (acceptedChildSessionKey) {
          try {
            markPendingDelegateSpawnAccepted(
              acceptedDelegate,
              acceptedChildSessionKey,
              params.persistChainState ? { requireWriteSuccess: true } : {},
            );
          } catch (err) {
            const errorMessage = formatErrorMessage(err);
            log.warn(
              `[continuation:delegate-accept-finalize-failed] flowId=${delegate.flowId ?? "unknown"} session=${sessionKey} leaving row recoverable: ${errorMessage}`,
            );
            dispatchSpan.setStatus("ERROR", errorMessage);
            rejected++;
            continue;
          }
        }
        dispatchSpan.setStatus("OK");
        commitPlannedChainState(dispatchChainId);
      } else {
        const reasonText = result.error ?? "delegation was not accepted.";
        const summary = `DELEGATE spawn ${result.status}: ${reasonText}`;
        log.info(
          `[continuation:delegate-spawn-rejected] status=${result.status} session=${sessionKey} reason=${reasonText} task=${delegate.task.slice(0, 80)}`,
        );
        const failedDelegate = await persistTerminalChainState(
          delegate,
          terminalChainStateForDelegate(delegate),
          { markPlannedChainState: appliedChainTokensFold > 0, markerKind: "terminal" },
        );
        markDelegateFailed(failedDelegate, summary);
        dispatchSpan.setStatus("ERROR", reasonText);
        enqueueSystemEvent(
          `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
          {
            sessionKey,
            trusted: true,
          },
        );
        rejected++;
      }
    } catch (err) {
      if (err instanceof DelegateTerminalChainStatePersistError) {
        const message = formatErrorMessage(err.originalError);
        dispatchSpan?.recordException(err.originalError);
        dispatchSpan?.setStatus("ERROR", message);
        log.warn(
          `[continuation:delegate-terminal-chain-persist-failed] error=${message} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
        );
        if (chainStatePersistedBeforeTerminalCommit && appliedChainTokensFold > 0) {
          clearRecoverableDelegatesChainTokensFold(sessionKey);
        }
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const summary = `DELEGATE spawn failed: ${message}`;
      dispatchSpan?.recordException(err);
      dispatchSpan?.setStatus("ERROR", message);
      log.info(`[continuation:delegate-spawn-failed] error=${message} session=${sessionKey}`);
      const failedDelegate = await persistTerminalChainState(
        delegate,
        terminalChainStateForDelegate(delegate),
        {
          markPlannedChainState: appliedChainTokensFold > 0,
          markerKind: "terminal",
        },
      );
      markDelegateFailed(failedDelegate, summary);
      enqueueSystemEvent(
        `[continuation] ${summary}. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        {
          sessionKey,
          trusted: true,
        },
      );
      rejected++;
    } finally {
      dispatchSpan?.end();
    }
  }

  return {
    dispatched,
    rejected,
    // Return the advanced chain state so callers can persist `currentChainCount`,
    // `chainStartedAt`, and `accumulatedChainTokens` after dispatch. Without
    // this the persisted counter never advances across hops and the
    // maxChainLength budget enforcement breaks.
    chainState: {
      currentChainCount,
      chainStartedAt: chainState.chainStartedAt,
      accumulatedChainTokens: currentAccumulatedTokens,
      ...(currentChainId ? { chainId: currentChainId } : {}),
    },
    ...(appliedChainTokensFold > 0 ? { appliedChainTokensFold } : {}),
    ...(chainStatePersistedBeforeTerminalCommit ? { chainStatePersistedBeforeTerminalCommit } : {}),
  };
}
