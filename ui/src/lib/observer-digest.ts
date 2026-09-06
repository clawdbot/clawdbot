import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";

// Freshest-wins reconciliation for observer digest copies (live event map vs
// projected session row). Revisions are session-monotonic by server contract
// (revision floors preserve continuity across runs), so cross-copy comparison
// by revision, then updatedAt, is safe.
type ComparableObserverDigest = { revision: number; updatedAt: number };

type ProjectedObserverDigest = Pick<
  SessionObserverDigest,
  "agentId" | "runId" | "headline" | "health" | "updatedAt" | "revision"
>;

export function projectSessionObserverDigest(
  sessionKey: string,
  digest: ProjectedObserverDigest | null | undefined,
): SessionObserverDigest | null {
  if (!digest) {
    return null;
  }
  return {
    sessionKey,
    ...(digest.agentId ? { agentId: digest.agentId } : {}),
    runId: digest.runId,
    revision: digest.revision,
    updatedAt: digest.updatedAt,
    headline: digest.headline,
    health: digest.health,
  };
}

export function isCriticalObserverHealth(health: unknown): health is "stuck" | "waiting-on-user" {
  return health === "stuck" || health === "waiting-on-user";
}

/** Local live run id wins; otherwise the observer must still own an exact active run. */
export function resolveChatPaneObserverRunId(params: {
  localRunId: string | null;
  session: { hasActiveRun?: boolean; activeRunIds?: readonly string[] } | undefined;
  digest: { runId?: string } | null;
}): string | null {
  if (params.localRunId) {
    return params.localRunId;
  }
  if (!params.session?.hasActiveRun || !params.digest?.runId) {
    return null;
  }
  return params.session.activeRunIds?.includes(params.digest.runId) ? params.digest.runId : null;
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
