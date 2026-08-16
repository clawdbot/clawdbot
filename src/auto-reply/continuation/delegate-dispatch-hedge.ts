import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import type {
  DelegateDispatchParams,
  DelegateDispatchResult,
} from "./delegate-dispatch-contract.js";
import { clearRecoverableDelegatesChainTokensFold } from "./delegate-store.js";
import {
  registerContinuationTimerHandle,
  retainContinuationTimerRef,
  unregisterContinuationTimerHandle,
} from "./state.js";

const log = createSubsystemLogger("continuation/delegate-dispatch");
export const DELEGATE_DISPATCH_RETRY_MS = 30_000;

type DispatchToolDelegates = (params: DelegateDispatchParams) => Promise<DelegateDispatchResult>;

type DelegateDispatchHedgeParams = Pick<
  DelegateDispatchParams,
  | "chainState"
  | "ctx"
  | "maxChainLength"
  | "config"
  | "loadFreshChainState"
  | "applyDelegateChainTokensFold"
  | "persistChainState"
  | "persistBeforeTerminalCommit"
  | "recoverRunningDelegates"
  | "queuedCreatedAtOrBefore"
  | "includeRunningUpdatedAtOrBefore"
>;

// Per-session hedge timer for re-checking unmatured pending delegates in fully
// quiet channels. Re-arming preserves the earliest pending deadline.
type DelegateDispatchHedge = {
  handle: NodeJS.Timeout;
  fireAt: number;
  params: DelegateDispatchHedgeParams;
  dispatchToolDelegates: DispatchToolDelegates;
};

const hedgeTimers = new Map<string, DelegateDispatchHedge>();

export function clearDelegateDispatchHedge(sessionKey: string): void {
  const existing = hedgeTimers.get(sessionKey);
  if (existing) {
    clearTimeout(existing.handle);
    hedgeTimers.delete(sessionKey);
    unregisterContinuationTimerHandle(sessionKey, existing.handle);
  }
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// An unset incoming field must not erase what an earlier arm supplied: a merged
// hedge that still claims "applyDelegateChainTokensFold" without its
// persist/load callbacks reads as "foldWithoutPersist" in dispatch, which
// force-claims not-yet-due delegates and loses the folded chain cost. The two
// cutoffs below are merged explicitly and stay unaffected.
function definedEntriesOnly(params: DelegateDispatchHedgeParams): DelegateDispatchHedgeParams {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  // SAFETY: filtering out undefined values keeps every remaining key's value type intact.
  return Object.fromEntries(entries) as DelegateDispatchHedgeParams;
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

function mergeOptionalUpperBound(
  existing: number | undefined,
  incoming: number | undefined,
): number | undefined {
  return existing === undefined || incoming === undefined
    ? undefined
    : Math.max(existing, incoming);
}

function mergeHedgeParams(
  existing: DelegateDispatchHedgeParams,
  incoming: DelegateDispatchHedgeParams,
): DelegateDispatchHedgeParams {
  const merged: DelegateDispatchHedgeParams = {
    ...existing,
    ...definedEntriesOnly(incoming),
    ...(existing.applyDelegateChainTokensFold || incoming.applyDelegateChainTokensFold
      ? { applyDelegateChainTokensFold: true }
      : {}),
    ...(existing.persistBeforeTerminalCommit || incoming.persistBeforeTerminalCommit
      ? { persistBeforeTerminalCommit: true }
      : {}),
    ...(existing.recoverRunningDelegates || incoming.recoverRunningDelegates
      ? { recoverRunningDelegates: true }
      : {}),
  };
  const queuedCreatedAtOrBefore = mergeOptionalUpperBound(
    existing.queuedCreatedAtOrBefore,
    incoming.queuedCreatedAtOrBefore,
  );
  if (queuedCreatedAtOrBefore === undefined) {
    delete merged.queuedCreatedAtOrBefore;
  } else {
    merged.queuedCreatedAtOrBefore = queuedCreatedAtOrBefore;
  }
  if (incoming.recoverRunningDelegates) {
    const includeRunningUpdatedAtOrBefore = existing.recoverRunningDelegates
      ? mergeOptionalUpperBound(
          existing.includeRunningUpdatedAtOrBefore,
          incoming.includeRunningUpdatedAtOrBefore,
        )
      : incoming.includeRunningUpdatedAtOrBefore;
    if (includeRunningUpdatedAtOrBefore === undefined) {
      delete merged.includeRunningUpdatedAtOrBefore;
    } else {
      merged.includeRunningUpdatedAtOrBefore = includeRunningUpdatedAtOrBefore;
    }
  }
  return merged;
}

export function armDelegateDispatchHedge(
  sessionKey: string,
  fireAt: number,
  params: DelegateDispatchHedgeParams,
  dispatchToolDelegates: DispatchToolDelegates,
): void {
  const existing = hedgeTimers.get(sessionKey);
  if (existing && existing.fireAt <= fireAt) {
    existing.params = mergeHedgeParams(existing.params, params);
    existing.dispatchToolDelegates = dispatchToolDelegates;
    return;
  }
  const mergedParams = existing ? mergeHedgeParams(existing.params, params) : params;
  clearDelegateDispatchHedge(sessionKey);
  const fireIn = Math.max(0, fireAt - Date.now());
  log.info(
    `[continuation:delegate-hedge-armed] fireIn=${fireIn}ms fireAt=${fireAt} session=${sessionKey}`,
  );
  retainContinuationTimerRef(sessionKey);
  const handle = setTimeout(() => {
    const hedge = hedgeTimers.get(sessionKey);
    if (hedge?.handle !== handle) {
      return;
    }
    hedgeTimers.delete(sessionKey);
    // Natural fire must release the same timer ref and handle as cancellation,
    // or continuation state remains alive after the hedge has done its work.
    unregisterContinuationTimerHandle(sessionKey, handle);
    log.info(`[continuation:delegate-hedge-fired] session=${sessionKey}`);
    const { params: activeParams, dispatchToolDelegates: activeDispatchToolDelegates } = hedge;
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      // Enforce the budget against the latest persisted chain state rather than
      // the snapshot captured when the hedge was armed.
      const refreshedChainState = activeParams.loadFreshChainState
        ? activeParams.loadFreshChainState()
        : activeParams.chainState;
      const result = await activeDispatchToolDelegates({
        sessionKey,
        chainState: refreshedChainState,
        ctx: activeParams.ctx,
        maxChainLength: activeParams.maxChainLength,
        ...(activeParams.config ? { config: activeParams.config } : {}),
        loadFreshChainState: activeParams.loadFreshChainState,
        ...(activeParams.applyDelegateChainTokensFold
          ? { applyDelegateChainTokensFold: true }
          : {}),
        persistChainState: activeParams.persistChainState,
        ...(activeParams.persistBeforeTerminalCommit || activeParams.persistChainState
          ? { persistBeforeTerminalCommit: true }
          : {}),
        ...(activeParams.recoverRunningDelegates ? { recoverRunningDelegates: true } : {}),
        ...(activeParams.queuedCreatedAtOrBefore !== undefined
          ? { queuedCreatedAtOrBefore: activeParams.queuedCreatedAtOrBefore }
          : {}),
        ...(activeParams.includeRunningUpdatedAtOrBefore !== undefined
          ? { includeRunningUpdatedAtOrBefore: activeParams.includeRunningUpdatedAtOrBefore }
          : {}),
      });
      if (activeParams.persistChainState && (result.dispatched > 0 || result.rejected > 0)) {
        if (!result.chainStatePersistedBeforeTerminalCommit) {
          await activeParams.persistChainState(result.chainState);
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
        armDelegateDispatchHedge(
          sessionKey,
          Date.now() + DELEGATE_DISPATCH_RETRY_MS,
          {
            ...activeParams,
            ...(activeParams.persistChainState ? { persistBeforeTerminalCommit: true } : {}),
            recoverRunningDelegates: true,
            includeRunningUpdatedAtOrBefore: Date.now(),
          },
          activeDispatchToolDelegates,
        );
      } catch (rearmErr) {
        log.error(
          `[continuation:delegate-hedge-rearm-error] error=${formatErrorMessage(rearmErr)} session=${sessionKey}`,
        );
      }
    });
  }, fireIn);
  registerContinuationTimerHandle(sessionKey, handle);
  handle.unref();
  hedgeTimers.set(sessionKey, {
    handle,
    fireAt,
    params: mergedParams,
    dispatchToolDelegates,
  });
}

/** Test-only: cancel pending hedge timers and clear the registry. */
export function resetDelegateDispatchHedgesForTests(): void {
  for (const [sessionKey, timer] of hedgeTimers) {
    clearTimeout(timer.handle);
    unregisterContinuationTimerHandle(sessionKey, timer.handle);
  }
  hedgeTimers.clear();
}
