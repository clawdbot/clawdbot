// Freshest-wins reconciliation for observer digest copies (live event map vs
// projected session row). Revisions are session-monotonic by server contract
// (revision floors preserve continuity across runs), so cross-copy comparison
// by revision, then updatedAt, is safe.
type ComparableObserverDigest = { revision: number; updatedAt: number };

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
