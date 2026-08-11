import { createHash, randomUUID } from "node:crypto";
import type { AudienceRef } from "../memory-host-sdk/host/authorization.js";

export type MemoryRunExposureSnapshot = Readonly<{
  exposureSetId: string;
  revisionNumber: number;
  previous?: MemoryRunExposureSnapshot;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
  durableRunScopeId: string;
  contextFingerprint: string;
  planId: string;
  memoryPolicyRevision: string;
  sourcePolicySetIds: readonly string[];
  exposedResourceRevisions: readonly string[];
  exposureReceiptIds: readonly string[];
  egressReceiptIds: readonly string[];
  deliveryAudiences: readonly AudienceRef[];
  deliveryRevision: string;
  egressRegistryRevision: string;
  sessionIdentityRevision: string;
  subjectRevision: string;
  createdAt: number;
}>;

type MemoryRunExposureFacts = Omit<
  MemoryRunExposureSnapshot,
  "exposureSetId" | "revisionNumber" | "previous" | "createdAt" | "durableRunScopeId"
>;

const exposuresByRun = new Map<string, MemoryRunExposureSnapshot>();

function key(params: { agentId: string; sessionId: string; runId: string }): string {
  return `${params.agentId}\u0000${params.sessionId}\u0000${params.runId}`;
}

/** Makes legacy projection keys session-bound without exposing raw session ids in that surface. */
export function createMemoryRunExposureScopeId(params: {
  agentId: string;
  sessionId: string;
  runId: string;
}): string {
  const { agentId, sessionId, runId } = params;
  return `mre-scope1_${createHash("sha256")
    .update(JSON.stringify({ agentId, sessionId, runId }))
    .digest("base64url")}`;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].toSorted());
}

function sortedAudiences(audiences: readonly AudienceRef[]): readonly AudienceRef[] {
  const unique = new Map<string, AudienceRef>();
  for (const audience of audiences) {
    unique.set(`${audience.kind}\u0000${audience.id}`, audience);
  }
  return Object.freeze(
    [...unique.values()]
      .toSorted((left, right) =>
        `${left.kind}\u0000${left.id}`.localeCompare(`${right.kind}\u0000${right.id}`),
      )
      .map((audience) => Object.freeze({ ...audience })),
  );
}

/** Prepares an immutable run-exposure revision without publishing it to process state. */
export function prepareMemoryRunExposure(facts: MemoryRunExposureFacts): MemoryRunExposureSnapshot {
  const normalizedKey = key(facts);
  const previous = exposuresByRun.get(normalizedKey);
  return Object.freeze({
    exposureSetId: `mre1_${randomUUID()}`,
    revisionNumber: (previous?.revisionNumber ?? 0) + 1,
    ...(previous ? { previous } : {}),
    ...facts,
    durableRunScopeId: createMemoryRunExposureScopeId(facts),
    sourcePolicySetIds: sortedUnique(facts.sourcePolicySetIds),
    exposedResourceRevisions: sortedUnique(facts.exposedResourceRevisions),
    exposureReceiptIds: sortedUnique(facts.exposureReceiptIds),
    egressReceiptIds: sortedUnique(facts.egressReceiptIds),
    deliveryAudiences: sortedAudiences(facts.deliveryAudiences),
    createdAt: Date.now(),
  }) satisfies MemoryRunExposureSnapshot;
}

/** Publishes a prepared revision only when no competing revision has advanced this run. */
export function publishMemoryRunExposure(snapshot: MemoryRunExposureSnapshot): boolean {
  const normalizedKey = key(snapshot);
  if (exposuresByRun.get(normalizedKey) !== snapshot.previous) {
    return false;
  }
  exposuresByRun.set(normalizedKey, snapshot);
  return true;
}

/**
 * Makes the durable ledger authoritative for one run. Empty durable state clears a stale
 * process entry after a state-root change; a distinct durable tail is unsafe to overwrite.
 */
export function reconcileMemoryRunExposureWithDurableLedger(params: {
  agentId: string;
  sessionId: string;
  runId: string;
  durableSnapshot: MemoryRunExposureSnapshot | undefined;
}): boolean {
  const normalizedKey = key(params);
  const current = exposuresByRun.get(normalizedKey);
  const { durableSnapshot } = params;
  if (!durableSnapshot) {
    exposuresByRun.delete(normalizedKey);
    return true;
  }
  if (
    durableSnapshot.agentId !== params.agentId ||
    durableSnapshot.sessionId !== params.sessionId ||
    durableSnapshot.runId !== params.runId ||
    (current &&
      (current.exposureSetId !== durableSnapshot.exposureSetId ||
        current.revisionNumber !== durableSnapshot.revisionNumber))
  ) {
    return false;
  }
  exposuresByRun.set(normalizedKey, durableSnapshot);
  return true;
}

/** Records an immutable run-exposure revision for callers that do not need durable pre-output fencing. */
export function recordMemoryRunExposure(facts: MemoryRunExposureFacts): MemoryRunExposureSnapshot {
  const snapshot = prepareMemoryRunExposure(facts);
  if (!publishMemoryRunExposure(snapshot)) {
    throw new Error("memory run exposure advanced before publication");
  }
  return snapshot;
}

/** Returns only the exact run/session exposure; callers cannot substitute another session's run. */
export function readMemoryRunExposure(params: {
  agentId: string;
  sessionId: string;
  runId: string;
}): MemoryRunExposureSnapshot | undefined {
  const snapshot = exposuresByRun.get(key(params));
  return snapshot &&
    snapshot.agentId === params.agentId &&
    snapshot.sessionId === params.sessionId &&
    snapshot.runId === params.runId
    ? snapshot
    : undefined;
}

export function clearMemoryRunExposureForTest(): void {
  exposuresByRun.clear();
}
