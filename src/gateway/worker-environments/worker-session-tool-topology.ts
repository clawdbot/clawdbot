import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { isCurrentPlacementTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";

export type WorkerSessionToolSource = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  turnClaim: NonNullable<WorkerConnectionIdentity["turnClaim"]> & {
    owner: { kind: "worker"; environmentId: string; ownerEpoch: number };
  };
  entry: NonNullable<ReturnType<typeof loadGatewaySessionEntryReadOnly>["entry"]>;
};

export type WorkerSessionToolTarget = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  topologyParent?: {
    sessionKey: string;
    sessionId: string;
  };
};

function relationKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export { relationKey as workerSessionRelationKey };

export function resolveWorkerSessionToolSource(params: {
  identity: WorkerConnectionIdentity;
  placements: WorkerSessionPlacementStore;
}): WorkerSessionToolSource {
  const identity = params.identity;
  const claim = identity.turnClaim;
  if (!identity.sessionId || !claim || claim.owner.kind !== "worker") {
    throw new Error("Worker session operation requires an active source turn");
  }
  const placement = params.placements.get(identity.sessionId);
  if (
    !placement ||
    (placement.state !== "active" && placement.state !== "draining") ||
    !isCurrentPlacementTurnClaim(placement, claim)
  ) {
    throw new Error("Worker source session placement changed");
  }
  const loaded = loadGatewaySessionEntryReadOnly(placement.sessionKey, {
    agentId: placement.agentId,
  });
  if (
    loaded.canonicalKey !== placement.sessionKey ||
    loaded.entry?.sessionId !== identity.sessionId ||
    loaded.entry.archivedAt !== undefined
  ) {
    throw new Error("Worker source session incarnation changed");
  }
  return {
    agentId: placement.agentId,
    sessionKey: placement.sessionKey,
    sessionId: identity.sessionId,
    turnClaim: { ...claim, owner: claim.owner },
    entry: loaded.entry,
  };
}

export function resolveWorkerSessionToolTarget(params: {
  source: WorkerSessionToolSource;
  requestedSessionKey: string;
}): WorkerSessionToolTarget {
  const loaded = loadGatewaySessionEntryReadOnly(params.requestedSessionKey);
  const entry = loaded.entry;
  const targetSessionId = entry?.sessionId;
  if (
    loaded.canonicalKey !== params.requestedSessionKey ||
    !targetSessionId ||
    !entry ||
    entry.archivedAt !== undefined ||
    targetSessionId === params.source.sessionId
  ) {
    throw new Error("Worker sessions_send target is not an exact live session");
  }
  const sourceParent =
    relationKey(params.source.entry.parentSessionKey) ?? relationKey(params.source.entry.spawnedBy);
  const sourceParentId = relationKey(params.source.entry.parentSessionId);
  const targetParent = relationKey(entry.parentSessionKey) ?? relationKey(entry.spawnedBy);
  const targetParentId = relationKey(entry.parentSessionId);
  const parentToChild =
    targetParent === params.source.sessionKey && targetParentId === params.source.sessionId;
  const childToParent = sourceParent === loaded.canonicalKey && sourceParentId === targetSessionId;
  const sharedParentIncarnation = Boolean(
    sourceParent &&
    sourceParentId &&
    sourceParent === targetParent &&
    sourceParentId === targetParentId,
  );
  const parent =
    sharedParentIncarnation && sourceParent && sourceParentId
      ? loadGatewaySessionEntryReadOnly(sourceParent)
      : undefined;
  const siblingToSibling = Boolean(
    parent &&
    parent.canonicalKey === sourceParent &&
    parent.entry?.sessionId === sourceParentId &&
    parent.entry?.archivedAt === undefined,
  );
  if (!parentToChild && !childToParent && !siblingToSibling) {
    throw new Error("Worker sessions_send target is outside the authorized session tree");
  }
  // Session identity owns messaging authority. Target turn admission chooses
  // its execution placement, including Gateway-local or reclaimed workers.
  return {
    agentId: loaded.agentId,
    sessionKey: loaded.canonicalKey,
    sessionId: targetSessionId,
    ...(siblingToSibling && sourceParent && sourceParentId
      ? { topologyParent: { sessionKey: sourceParent, sessionId: sourceParentId } }
      : {}),
  };
}

export function assertWorkerSessionToolChild(params: {
  childSessionKey: string;
  childSessionId: string;
  sourceSessionKey: string;
  sourceSessionId: string;
  targetAgentId: string;
}): void {
  const loaded = loadGatewaySessionEntryReadOnly(params.childSessionKey, {
    agentId: params.targetAgentId,
  });
  const parent =
    relationKey(loaded.entry?.parentSessionKey) ?? relationKey(loaded.entry?.spawnedBy);
  const parentSessionId = relationKey(loaded.entry?.parentSessionId);
  if (
    loaded.canonicalKey !== params.childSessionKey ||
    loaded.entry?.sessionId !== params.childSessionId ||
    loaded.entry.archivedAt !== undefined ||
    parent !== params.sourceSessionKey ||
    parentSessionId !== params.sourceSessionId
  ) {
    throw new Error("Spawned cloud child session incarnation changed");
  }
}
