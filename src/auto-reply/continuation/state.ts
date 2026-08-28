/**
 * Continuation chain state tracking.
 *
 * Tracks per-session chain metadata (depth, start time, accumulated tokens)
 * and timer handle registration. NO generation guard — delayed delegates
 * survive channel noise by design.
 *
 * RFC: docs/design/continue-work-signal-v2.md §3.3
 */

import type { SessionEntry } from "../../config/sessions/types.js";
import { stagedPostCompactionDelegateCount } from "./delegate-store-post-compaction.js";
import { pendingDelegateCount } from "./delegate-store.js";
import type { ChainState } from "./types.js";
import { pendingWorkCount } from "./work-store.js";

type ContinuationTimerHandle = ReturnType<typeof setTimeout>;

// Per-session timer handles for delayed continuation work.
const continuationTimerHandles = new Map<string, Set<ContinuationTimerHandle>>();
// Per-session ref count for outstanding timers (used to determine if
// continuation state should be kept alive).
const continuationTimerRefs = new Map<string, number>();
// ---------------------------------------------------------------------------
// Delegate-pending queries — derived from TaskFlow, not a separate Map
//
// The old branch had a volatile delegatePendingFlags Map that duplicated
// information already in TaskFlow via pendingDelegateCount. Removed:
// the source of truth is the TaskFlow registry.
// ---------------------------------------------------------------------------

export function hasDelegatePending(sessionKey: string): boolean {
  return (
    pendingDelegateCount(sessionKey) > 0 ||
    stagedPostCompactionDelegateCount(sessionKey) > 0 ||
    pendingWorkCount(sessionKey) > 0
  );
}

// ---------------------------------------------------------------------------
// Timer handle registration
// ---------------------------------------------------------------------------

/**
 * Increment the timer ref count for a session. Call when scheduling a
 * delayed continuation timer.
 */
export function retainContinuationTimerRef(sessionKey: string): void {
  continuationTimerRefs.set(sessionKey, (continuationTimerRefs.get(sessionKey) ?? 0) + 1);
}

/**
 * Decrement the timer ref count. Call when a timer fires or is cancelled.
 */
export function releaseContinuationTimerRef(sessionKey: string): void {
  const current = continuationTimerRefs.get(sessionKey) ?? 0;
  if (current <= 1) {
    continuationTimerRefs.delete(sessionKey);
  } else {
    continuationTimerRefs.set(sessionKey, current - 1);
  }
}

export function hasLiveContinuationTimerRefs(sessionKey: string): boolean {
  return (continuationTimerRefs.get(sessionKey) ?? 0) > 0;
}

/**
 * Register a timer handle so it can be cleared on session reset.
 */
export function registerContinuationTimerHandle(
  sessionKey: string,
  handle: ContinuationTimerHandle,
): void {
  const existing = continuationTimerHandles.get(sessionKey);
  if (existing) {
    existing.add(handle);
    return;
  }
  continuationTimerHandles.set(sessionKey, new Set([handle]));
}

/**
 * Unregister a timer handle after it fires or is cancelled.
 * Also releases the timer ref.
 */
export function unregisterContinuationTimerHandle(
  sessionKey: string,
  handle: ContinuationTimerHandle,
): boolean {
  const existing = continuationTimerHandles.get(sessionKey);
  if (!existing?.delete(handle)) {
    return false;
  }
  if (existing.size === 0) {
    continuationTimerHandles.delete(sessionKey);
  }
  releaseContinuationTimerRef(sessionKey);
  return true;
}

/**
 * Clear all tracked continuation timers for a session. Used on explicit
 * session reset (/new, /reset) — NOT on inbound noise.
 */
export function clearTrackedContinuationTimers(sessionKey: string): void {
  const existing = continuationTimerHandles.get(sessionKey);
  if (!existing || existing.size === 0) {
    return;
  }
  continuationTimerHandles.delete(sessionKey);
  for (const handle of existing) {
    clearTimeout(handle);
    // Release refs asynchronously to avoid re-entrancy during cleanup.
    const releaseHandle = setTimeout(() => {
      releaseContinuationTimerRef(sessionKey);
    }, 0);
    releaseHandle.unref();
  }
}

// ---------------------------------------------------------------------------
// Chain state persistence
// ---------------------------------------------------------------------------

/**
 * Structural subset of `SessionEntry` covering only the fields the
 * continuation-chain read path needs. Declared independently so callers
 * that want to avoid a static edge into `src/config/sessions/types.js`
 * (notably `subagent-announce.ts` — cycle-avoidance) can satisfy the
 * helper signature without an extra type import.
 */
type ContinuationChainSource = {
  continuationChainCount?: number;
  continuationChainStartedAt?: number;
  continuationChainTokens?: number;
  continuationChainId?: string;
};

/**
 * Read continuation chain state from a SessionEntry with safe defaults.
 *
 * Collapses the scattered `?? 0` / `?? Date.now()` sentinel pattern from
 * 6+ call sites (agent-runner, followup-runner, subagent-announce) into
 * one canonical adapter. The returned ChainState has `turnTokens` folded
 * into `accumulatedChainTokens` so callers don't repeat the addition.
 *
 * - `undefined` source → zeroed chain, `chainStartedAt = Date.now()`
 * - missing `continuationChainStartedAt` → `Date.now()` (the chain appears
 *   to start fresh this turn; matches historical sentinel behavior).
 *
 * Accepts any shape compatible with `ContinuationChainSource`, including
 * `SessionEntry` (structural compatibility).
 */
export function loadContinuationChainState(
  source: ContinuationChainSource | undefined,
  turnTokens = 0,
): ChainState {
  return {
    currentChainCount: source?.continuationChainCount ?? 0,
    chainStartedAt: source?.continuationChainStartedAt ?? Date.now(),
    accumulatedChainTokens: (source?.continuationChainTokens ?? 0) + turnTokens,
    ...(source?.continuationChainId ? { chainId: source.continuationChainId } : {}),
  };
}

/**
 * Persist continuation chain metadata to the session entry.
 * Called after scheduling to keep chain depth, start time, token cost, and the
 * stable chain id in sync with the session store.
 */
export function persistContinuationChainState(params: {
  sessionEntry?: SessionEntry;
  count: number;
  startedAt: number;
  tokens: number;
  chainId?: string;
}): void {
  if (!params.sessionEntry) {
    return;
  }
  params.sessionEntry.continuationChainCount = params.count;
  params.sessionEntry.continuationChainStartedAt = params.startedAt;
  params.sessionEntry.continuationChainTokens = params.tokens;
  // Persist the chain id alongside depth/start/tokens so the stable chain
  // correlation survives across drains. `loadContinuationChainState` reads
  // `continuationChainId` back on later hops; without writing it here, callers
  // that persist an advanced `chainState` (the delegate-drain on the followup
  // and subagent-announce paths) dropped the minted id and the next drain
  // re-minted a fresh one, breaking multi-hop trace correlation. Written only
  // when provided so callers that don't carry a chain id (e.g. continue_work)
  // keep whatever id is already on the entry.
  if (params.chainId !== undefined) {
    params.sessionEntry.continuationChainId = params.chainId;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetContinuationStateForTests(): void {
  continuationTimerHandles.clear();
  continuationTimerRefs.clear();
  // delegatePendingFlags removed — derived from TaskFlow.
}
