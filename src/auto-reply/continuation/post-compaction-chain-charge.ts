// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
/**
 * Exactly-once continuation-depth accounting for released post-compaction work.
 *
 * Queued post-compaction delivery charges the parent chain only after a child is
 * actually accepted, so every pre-acceptance failure (attachment materialization,
 * spawn fence, spawn rejection) leaves the budget untouched and the entry
 * retryable. This module owns the durable marker that makes that charge
 * idempotent across crash, restart, and queue replay
 * (karmaterminal/openclaw#1198).
 */

import {
  decodeDelegateFlow,
  delegateFlowRecords,
  isPostCompactionDelegateFlow,
} from "./delegate-flow-store.js";
import { markPendingDelegateChainStatePersistPlanned } from "./delegate-store.js";
import type { ChainState, PendingContinuationDelegate } from "./types.js";

/**
 * Reserve the accepted post-compaction hop on its TaskFlow row, idempotently.
 *
 * Returns the chain state the session entry must be persisted to, and the
 * revision acceptance must commit against (the marker write bumps the row a
 * revision). A row that already carries an `advanced` marker returns that marker
 * unchanged, so a replayed delivery re-persists the same hop instead of
 * advancing depth again. Because the marker is written before the session-entry
 * patch, an absent marker proves the entry was never advanced for this row, and
 * a `terminal` marker records a rejection that consumed no hop at all.
 */
export function reserveAcceptedPostCompactionChainHop(
  delegate: Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">,
  plannedChainState: ChainState,
): { chainState: ChainState; expectedRevision: number | undefined } {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    return { chainState: plannedChainState, expectedRevision: delegate.expectedRevision };
  }
  const flow = delegateFlowRecords.get(delegate.flowId);
  const decoded = flow && isPostCompactionDelegateFlow(flow) ? decodeDelegateFlow(flow) : undefined;
  if (decoded?.persistedChainState && decoded.persistedChainStateKind !== "terminal") {
    return { chainState: decoded.persistedChainState, expectedRevision: flow?.revision };
  }
  const marked = markPendingDelegateChainStatePersistPlanned(
    { ...delegate, expectedRevision: flow?.revision ?? delegate.expectedRevision },
    plannedChainState,
    "advanced",
  );
  return { chainState: plannedChainState, expectedRevision: marked.expectedRevision };
}
