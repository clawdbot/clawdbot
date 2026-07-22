import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";

// Freshest-wins reconciliation for observer digest copies (live event map vs
// projected session row). Revisions are session-monotonic by server contract
// (revision floors preserve continuity across runs), so cross-copy comparison
// by revision, then updatedAt, is safe.
type ComparableObserverDigest = { revision: number; updatedAt: number };

const OBSERVER_DIGEST_HISTORY_LIMIT = 50;

type ProjectedObserverDigest = Pick<
  SessionObserverDigest,
  "runId" | "headline" | "health" | "updatedAt" | "revision"
>;

/** Local live run id wins; otherwise the row's server-reported active runs
 * identify the run, preferring the one the digest belongs to. */
export function resolveChatPaneObserverRunId(params: {
  localRunId: string | null;
  session: { hasActiveRun?: boolean; activeRunIds?: readonly string[] } | undefined;
  digest: { runId?: string } | null;
}): string | null {
  if (params.localRunId) {
    return params.localRunId;
  }
  if (!params.session?.hasActiveRun) {
    return null;
  }
  const activeRunIds = params.session.activeRunIds ?? [];
  return params.digest?.runId && activeRunIds.includes(params.digest.runId)
    ? params.digest.runId
    : (activeRunIds[0] ?? null);
}

export function pickFreshestObserverDigest<T extends ComparableObserverDigest>(
  first: T,
  second: T,
): T;
export function pickFreshestObserverDigest<T extends ComparableObserverDigest>(
  first: T | null | undefined,
  second: T | null | undefined,
): T | null;
export function pickFreshestObserverDigest<T extends ComparableObserverDigest>(
  first: T | null | undefined,
  second: T | null | undefined,
): T | null {
  if (!first) {
    return second ?? null;
  }
  if (!second) {
    return first;
  }
  if (first.revision !== second.revision) {
    return first.revision > second.revision ? first : second;
  }
  return first.updatedAt >= second.updatedAt ? first : second;
}

function compareObserverDigestFreshness(
  left: ComparableObserverDigest,
  right: ComparableObserverDigest,
): number {
  if (left.revision === right.revision && left.updatedAt === right.updatedAt) {
    return 0;
  }
  return pickFreshestObserverDigest(left, right) === left ? 1 : -1;
}

function observerDigestsEqual(left: SessionObserverDigest, right: SessionObserverDigest): boolean {
  return (
    left.sessionKey === right.sessionKey &&
    left.runId === right.runId &&
    left.revision === right.revision &&
    left.updatedAt === right.updatedAt &&
    left.headline === right.headline &&
    left.assessment === right.assessment &&
    left.health === right.health &&
    left.planProgress?.completed === right.planProgress?.completed &&
    left.planProgress?.total === right.planProgress?.total
  );
}

/** Pane-local observer history. Entries stay oldest-first so trimming always
 * drops the least-recent digest and renderers can reverse without re-sorting.
 * Session identity is the invalidation signal: a conversation reset mints a
 * new sessionId server-side, so an id change — never wall clocks — clears the
 * old conversation's history, locally and across clients. */
export class ObserverDigestHistory {
  private readonly bySession = new Map<string, SessionObserverDigest[]>();
  // Authoritative sessionId per key, tracked independently of entries so an
  // id learned before the first digest still detects a later remote reset.
  private readonly sessionIds = new Map<string, string>();
  // Local resets invalidate the pre-reset sessionId so a stale cached row
  // cannot re-seed history before the refreshed row (new id) arrives.
  private readonly invalidatedSessionIds = new Map<string, string>();

  /** Reconcile with an authoritative session row. Returns true when a
   * sessionId change cleared that session's history. */
  sync(sessionKey: string, rowSessionId: string | null | undefined): boolean {
    if (!rowSessionId) {
      return false;
    }
    const invalidated = this.invalidatedSessionIds.get(sessionKey);
    if (invalidated !== undefined && invalidated !== rowSessionId) {
      this.invalidatedSessionIds.delete(sessionKey);
    }
    const known = this.sessionIds.get(sessionKey);
    this.sessionIds.set(sessionKey, rowSessionId);
    if (known !== undefined && known !== rowSessionId) {
      return this.bySession.delete(sessionKey);
    }
    return false;
  }

  hydrate(
    sessionKey: string,
    digest: ProjectedObserverDigest | null | undefined,
    rowSessionId?: string | null,
  ): boolean {
    if (!digest) {
      return false;
    }
    if (rowSessionId && this.invalidatedSessionIds.get(sessionKey) === rowSessionId) {
      return false;
    }
    // Delegating to sync keeps hydrate order-independent from row updates.
    this.sync(sessionKey, rowSessionId);
    if (!this.bySession.has(sessionKey)) {
      this.bySession.set(sessionKey, [{ ...digest, sessionKey }]);
      return true;
    }
    // A projection can advance past the live listener (reconnect, missed
    // event); reconcile it through the same freshness rules as live digests.
    return this.record({ ...digest, sessionKey });
  }

  record(digest: SessionObserverDigest): boolean {
    const history = this.bySession.get(digest.sessionKey) ?? [];
    const existingIndex = history.findIndex(
      (candidate) => candidate.runId === digest.runId && candidate.revision === digest.revision,
    );
    if (existingIndex >= 0) {
      const existing = history[existingIndex]!;
      // Passing the live candidate first lets an exact projection tie gain the
      // richer assessment/plan fields while still using canonical freshness.
      const freshest = pickFreshestObserverDigest(digest, existing);
      if (freshest === existing) {
        return false;
      }
      const next =
        digest.revision === existing.revision && digest.updatedAt === existing.updatedAt
          ? {
              ...existing,
              ...digest,
              assessment: digest.assessment ?? existing.assessment,
              planProgress: digest.planProgress ?? existing.planProgress,
            }
          : freshest;
      if (observerDigestsEqual(existing, next)) {
        return false;
      }
      history[existingIndex] = next;
    } else {
      history.push(digest);
    }
    history.sort(compareObserverDigestFreshness);
    if (history.length > OBSERVER_DIGEST_HISTORY_LIMIT) {
      history.splice(0, history.length - OBSERVER_DIGEST_HISTORY_LIMIT);
    }
    this.bySession.set(digest.sessionKey, history);
    return true;
  }

  get(sessionKey: string): readonly SessionObserverDigest[] {
    return this.bySession.get(sessionKey) ?? [];
  }

  /** Conversation reset: drop history and refuse the pre-reset sessionId.
   * Compare-and-invalidate: if the tracked identity already moved past the
   * captured pre-reset id (the replacement row landed during the reset
   * request), the new conversation's state must not be erased. The known id
   * is kept on purpose otherwise: a late pre-reset live event can re-seed
   * entries, and the next row's id mismatch must still sweep them. */
  markReset(sessionKey: string, knownSessionId?: string | null): void {
    // Accepted tradeoff: without a known pre-reset id (row absent from the
    // cached roster at reset time) no tombstone is possible, so a late
    // pre-reset live event could transiently survive until the next digest
    // or row refresh. Guarding it needs a pending-reset quarantine state for
    // a compound-improbable path with cosmetic-only impact.
    const tracked = this.sessionIds.get(sessionKey);
    if (knownSessionId && tracked !== undefined && tracked !== knownSessionId) {
      return;
    }
    this.bySession.delete(sessionKey);
    if (knownSessionId) {
      this.sessionIds.set(sessionKey, knownSessionId);
      this.invalidatedSessionIds.set(sessionKey, knownSessionId);
    }
  }

  clear(): void {
    this.bySession.clear();
    this.sessionIds.clear();
    this.invalidatedSessionIds.clear();
  }
}
