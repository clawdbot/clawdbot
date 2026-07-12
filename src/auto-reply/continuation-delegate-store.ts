/**
 * Re-export shim — delegates to the canonical TaskFlow-backed store at
 * `./continuation/delegate-store.js`.
 *
 * Every delegate operation is backed by TaskFlow (SQLite persistence).
 * The former volatile in-memory delegate substrate and config gate have
 * been removed. TaskFlow is the only substrate.
 *
 * This file exists so that existing import paths
 * (`../continuation-delegate-store.js`) keep working without a mass
 * import rewrite. Post-compaction functions wrap the canonical store
 * to preserve the `SessionPostCompactionDelegate` type contract that
 * downstream callers (persistPendingPostCompactionDelegates,
 * post-compaction-delegate-dispatch) rely on.
 */

import type { SessionPostCompactionDelegate } from "../config/sessions.js";
import {
  consumeStagedPostCompactionDelegates as canonicalConsumeStaged,
  requeueReleasedPostCompactionDelegate as canonicalRequeueReleasedPostCompactionDelegate,
  stagePostCompactionDelegate as canonicalStage,
} from "./continuation/delegate-store.js";

// ---------------------------------------------------------------------------
// Pure re-exports — identical signature to canonical store
// ---------------------------------------------------------------------------

export {
  cancelPendingDelegates,
  consumePendingDelegates,
  enqueuePendingDelegate,
  annotateQueuedDelegatesChainTokensFold,
  clearQueuedDelegatesChainTokensFold,
  assertStagedPostCompactionFinalizationComplete,
  finalizeStagedPostCompactionDelegates,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
  pendingDelegateCount,
  requeueAwaitingNextCompactionDelegates,
  failQueuedDelegatesCreatedAtOrAfter,
  listRecoverableStagedPostCompactionDelegates,
  resetDelegateStoreForTests,
  stagedPostCompactionDelegateCount,
} from "./continuation/delegate-store.js";

// ---------------------------------------------------------------------------
// Post-compaction wrappers — adapt SessionPostCompactionDelegate ↔ TaskFlow
//
// Downstream callers (agent-runner persist path, delivery queue) speak
// SessionPostCompactionDelegate { task, createdAt, firstArmedAt?, silent?,
// silentWake?, targetSessionKey?, targetSessionKeys?, fanoutMode?, traceparent?, model? }.
// The canonical store speaks StagedPostCompactionDelegate { task, stagedAt, firstArmedAt? }
// and returns PendingContinuationDelegate { task, mode?, firstArmedAt? }.
// ---------------------------------------------------------------------------

export function stagePostCompactionDelegate(
  sessionKey: string,
  delegate: SessionPostCompactionDelegate,
): void {
  const stagedAt = delegate.createdAt ?? Date.now();
  canonicalStage(sessionKey, {
    task: delegate.task,
    stagedAt,
    firstArmedAt: delegate.firstArmedAt ?? stagedAt,
    ...(delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {}),
    ...(delegate.targetSessionKeys ? { targetSessionKeys: delegate.targetSessionKeys } : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(delegate.traceparent && delegate.traceparentProvenance === "internal"
      ? { traceparent: delegate.traceparent }
      : {}),
    ...(delegate.model ? { model: delegate.model } : {}),
  });
}

export function consumeStagedPostCompactionDelegates(
  sessionKey: string,
  options?: { claimFor?: "release" | "next-seam-persist" },
): SessionPostCompactionDelegate[] {
  const now = Date.now();
  return canonicalConsumeStaged(sessionKey, options).map((d) => {
    const firstArmedAt = d.firstArmedAt ?? now;
    const delegate: SessionPostCompactionDelegate = {
      task: d.task,
      createdAt: firstArmedAt,
      firstArmedAt,
      silent: true,
      silentWake: true,
    };
    if (d.targetSessionKey) {
      delegate.targetSessionKey = d.targetSessionKey;
    }
    if (d.targetSessionKeys) {
      delegate.targetSessionKeys = d.targetSessionKeys;
    }
    if (d.fanoutMode) {
      delegate.fanoutMode = d.fanoutMode;
    }
    if (d.traceparent) {
      delegate.traceparent = d.traceparent;
      delegate.traceparentProvenance = "internal";
    }
    if (d.model) {
      delegate.model = d.model;
    }
    if (d.flowId) {
      // Runtime-only claim handle so callers can finalize exactly this row after
      // a durable handoff or terminal rejection (#1144).
      delegate.flowId = d.flowId;
    }
    if (d.expectedRevision !== undefined) {
      delegate.expectedRevision = d.expectedRevision;
    }
    return delegate;
  });
}

export function requeueReleasedPostCompactionDelegate(
  delegate: Pick<SessionPostCompactionDelegate, "flowId" | "expectedRevision" | "task">,
): boolean {
  return canonicalRequeueReleasedPostCompactionDelegate(delegate);
}
