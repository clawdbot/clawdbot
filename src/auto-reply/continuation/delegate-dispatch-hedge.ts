import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import type { DelegateDispatchParams, DelegateDispatchResult } from "./delegate-dispatch.js";
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
  | "inheritedSilent"
  | "inheritedWake"
>;

// Per-session hedge timer for re-checking unmatured pending delegates in fully
// quiet channels. A fresh dispatch cancels and replaces the existing hedge.
const hedgeTimers = new Map<string, NodeJS.Timeout>();

export function clearDelegateDispatchHedge(sessionKey: string): void {
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

export function armDelegateDispatchHedge(
  sessionKey: string,
  fireAt: number,
  params: DelegateDispatchHedgeParams,
  dispatchToolDelegates: DispatchToolDelegates,
): void {
  clearDelegateDispatchHedge(sessionKey);
  const fireIn = Math.max(0, fireAt - Date.now());
  log.info(
    `[continuation:delegate-hedge-armed] fireIn=${fireIn}ms fireAt=${fireAt} session=${sessionKey}`,
  );
  retainContinuationTimerRef(sessionKey);
  const handle = setTimeout(() => {
    hedgeTimers.delete(sessionKey);
    // Natural fire must release the same timer ref and handle as cancellation,
    // or continuation state remains alive after the hedge has done its work.
    unregisterContinuationTimerHandle(sessionKey, handle);
    log.info(`[continuation:delegate-hedge-fired] session=${sessionKey}`);
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      // Enforce the budget against the latest persisted chain state rather than
      // the snapshot captured when the hedge was armed.
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
        // Delayed descendants of a silent/wake chain must remain internal when
        // the hedge eventually dispatches them.
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
        armDelegateDispatchHedge(
          sessionKey,
          Date.now() + DELEGATE_DISPATCH_RETRY_MS,
          {
            ...params,
            ...(params.persistChainState ? { persistBeforeTerminalCommit: true } : {}),
            recoverRunningDelegates: true,
            includeRunningUpdatedAtOrBefore: Date.now(),
          },
          dispatchToolDelegates,
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
  hedgeTimers.set(sessionKey, handle);
}

/** Test-only: cancel pending hedge timers and clear the registry. */
export function resetDelegateDispatchHedgesForTests(): void {
  for (const [sessionKey, handle] of hedgeTimers) {
    clearTimeout(handle);
    unregisterContinuationTimerHandle(sessionKey, handle);
  }
  hedgeTimers.clear();
}
