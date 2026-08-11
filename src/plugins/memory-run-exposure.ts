import { randomUUID } from "node:crypto";
import type { AudienceRef } from "../memory-host-sdk/host/authorization.js";

export type MemoryRunExposureSnapshot = Readonly<{
  exposureSetId: string;
  revisionNumber: number;
  previous?: MemoryRunExposureSnapshot;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
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
  "exposureSetId" | "revisionNumber" | "previous" | "createdAt"
>;

const exposuresByRun = new Map<string, MemoryRunExposureSnapshot>();

function key(params: { agentId: string; sessionId: string; runId: string }): string {
  return `${params.agentId}\u0000${params.sessionId}\u0000${params.runId}`;
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

/** Records an immutable run-exposure revision before scoped content leaves the broker. */
export function recordMemoryRunExposure(facts: MemoryRunExposureFacts): MemoryRunExposureSnapshot {
  const normalizedKey = key(facts);
  const previous = exposuresByRun.get(normalizedKey);
  const snapshot = Object.freeze({
    exposureSetId: `mre1_${randomUUID()}`,
    revisionNumber: (previous?.revisionNumber ?? 0) + 1,
    ...(previous ? { previous } : {}),
    ...facts,
    sourcePolicySetIds: sortedUnique(facts.sourcePolicySetIds),
    exposedResourceRevisions: sortedUnique(facts.exposedResourceRevisions),
    exposureReceiptIds: sortedUnique(facts.exposureReceiptIds),
    egressReceiptIds: sortedUnique(facts.egressReceiptIds),
    deliveryAudiences: sortedAudiences(facts.deliveryAudiences),
    createdAt: Date.now(),
  }) satisfies MemoryRunExposureSnapshot;
  exposuresByRun.set(normalizedKey, snapshot);
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
