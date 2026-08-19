import { createHash, randomUUID } from "node:crypto";
import {
  MEMORY_OPERATIONS,
  type AudienceRef,
  type MemoryAccessContext,
  type MemoryActorEvidence,
  type MemoryOperation,
} from "../memory-host-sdk/host/authorization.js";

/** Immutable, serializable actor facts captured from the trusted access context. */
export type DurableMemoryActorEvidence =
  | Readonly<{
      version: 1;
      kind: "principal";
      actorKind: "human" | "agent" | "service" | "system";
      principalId: string;
      assurance: "gateway-profile" | "adapter-attested" | "oidc" | "service";
      evidenceRevision: string;
      expiresAt?: string;
    }>
  | Readonly<{
      version: 1;
      kind: "unattributed";
      transportAuditRef: string;
      evidenceRevision: string;
    }>;

/**
 * Delegation facts needed for an audit trail. The bearer token is intentionally
 * absent: durable transcript lineage proves authority without becoming authority.
 */
export type DurableMemoryDelegationSnapshot =
  | Readonly<{ version: 1; kind: "none" }>
  | Readonly<{
      version: 1;
      kind: "delegated";
      rootPrincipalId: string;
      rootContextId: string;
      parentContextId: string;
      parentMemoryPlanId: string;
      capabilitySnapshotId: string;
      allowedOperations: readonly MemoryOperation[];
      maximumAudiences: readonly AudienceRef[];
      depth: number;
    }>;

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
  enterpriseMembershipSnapshotIds: readonly string[];
  deliveryAudiences: readonly AudienceRef[];
  deliveryRevision: string;
  egressRegistryRevision: string;
  sessionIdentityRevision: string;
  subjectRevision: string;
  actorEvidence: DurableMemoryActorEvidence;
  delegationSnapshot: DurableMemoryDelegationSnapshot;
  hostFactsRevision: string;
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

function requireText(value: string, label: string): string {
  if (!value.trim()) {
    throw new TypeError(`${label} must be non-empty`);
  }
  return value;
}

function canonicalIsoDate(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError("actor.expiresAt must be a canonical ISO date");
  }
  return value;
}

function captureActorEvidence(actor: MemoryActorEvidence): DurableMemoryActorEvidence {
  if (actor.kind === "principal") {
    const expiresAt = canonicalIsoDate(actor.expiresAt);
    return Object.freeze({
      version: 1,
      kind: "principal",
      actorKind: actor.actorKind,
      principalId: requireText(actor.principalId, "actor.principalId"),
      assurance: actor.assurance,
      evidenceRevision: requireText(actor.evidenceRevision, "actor.evidenceRevision"),
      ...(expiresAt ? { expiresAt } : {}),
    });
  }
  return Object.freeze({
    version: 1,
    kind: "unattributed",
    transportAuditRef: requireText(actor.transportAuditRef, "actor.transportAuditRef"),
    evidenceRevision: requireText(actor.evidenceRevision, "actor.evidenceRevision"),
  });
}

function captureDelegation(
  delegation: MemoryAccessContext["delegation"],
): DurableMemoryDelegationSnapshot {
  if (!delegation) {
    return Object.freeze({ version: 1, kind: "none" });
  }
  const allowedOperations = Object.freeze([...new Set(delegation.allowedOperations)].toSorted());
  if (
    allowedOperations.length !== delegation.allowedOperations.length ||
    allowedOperations.some((operation) => !MEMORY_OPERATIONS.includes(operation))
  ) {
    throw new TypeError("delegation.allowedOperations must be canonical");
  }
  const maximumAudiences = sortedAudiences(delegation.maximumAudiences);
  if (maximumAudiences.length !== delegation.maximumAudiences.length) {
    throw new TypeError("delegation.maximumAudiences must be canonical");
  }
  if (!Number.isSafeInteger(delegation.depth) || delegation.depth < 0) {
    throw new TypeError("delegation.depth must be a nonnegative integer");
  }
  return Object.freeze({
    version: 1,
    kind: "delegated",
    rootPrincipalId: requireText(delegation.rootPrincipalId, "delegation.rootPrincipalId"),
    rootContextId: requireText(delegation.rootContextId, "delegation.rootContextId"),
    parentContextId: requireText(delegation.parentContextId, "delegation.parentContextId"),
    parentMemoryPlanId: requireText(delegation.parentMemoryPlanId, "delegation.parentMemoryPlanId"),
    capabilitySnapshotId: requireText(
      delegation.capabilitySnapshotId,
      "delegation.capabilitySnapshotId",
    ),
    allowedOperations,
    maximumAudiences,
    depth: delegation.depth,
  });
}

/** Captures only the durable audit subset of a trusted access context. */
export function captureDurableMemoryAuthorizationFacts(context: MemoryAccessContext): Readonly<{
  actorEvidence: DurableMemoryActorEvidence;
  delegationSnapshot: DurableMemoryDelegationSnapshot;
  enterpriseMembershipSnapshotIds: readonly string[];
  hostFactsRevision: string;
}> {
  return Object.freeze({
    actorEvidence: captureActorEvidence(context.actor),
    delegationSnapshot: captureDelegation(context.delegation),
    enterpriseMembershipSnapshotIds: sortedUnique(
      context.verifiedMemberships.map((membership) => membership.snapshotId),
    ),
    hostFactsRevision: requireText(context.hostFactsRevision, "hostFactsRevision"),
  });
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
    enterpriseMembershipSnapshotIds: sortedUnique(facts.enterpriseMembershipSnapshotIds),
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
