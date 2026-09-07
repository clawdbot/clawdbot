import { listAgentIds } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
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
    agentId: string;
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

function resolveParent(source: WorkerSessionToolSource) {
  const key = relationKey(source.entry.parentSessionKey) ?? relationKey(source.entry.spawnedBy);
  const id = relationKey(source.entry.parentSessionId);
  if (!key || !id) {
    return undefined;
  }
  const cfg = getRuntimeConfig();
  const keyAgentId = parseAgentSessionKey(key)?.agentId;
  const matches = new Map<string, ReturnType<typeof loadGatewaySessionEntryReadOnly>>();
  // Global keys have one row per owner. Probe the recorded key and incarnation,
  // retaining canonical ownership even when several agents share a fixed store.
  for (const candidate of keyAgentId ? [keyAgentId] : listAgentIds(cfg)) {
    const owner = resolveRequestedSessionAgentId(cfg, key, candidate);
    if (!owner.ok) {
      continue;
    }
    const loaded = loadGatewaySessionEntryReadOnly(key, { agentId: owner.agentId });
    if (loaded.canonicalKey === key && loaded.entry?.sessionId === id) {
      matches.set(`${loaded.agentId}\0${loaded.canonicalKey}`, loaded);
    }
  }
  const parent = matches.size === 1 ? matches.values().next().value : undefined;
  return parent?.entry?.archivedAt === undefined && parent
    ? { ...parent, sessionId: id }
    : undefined;
}

export function resolveWorkerSessionToolTarget(params: {
  source: WorkerSessionToolSource;
  requestedSessionKey: string;
}): WorkerSessionToolTarget {
  const sourceParentKey =
    relationKey(params.source.entry.parentSessionKey) ?? relationKey(params.source.entry.spawnedBy);
  const parent =
    params.requestedSessionKey === sourceParentKey ? resolveParent(params.source) : undefined;
  const loaded =
    params.requestedSessionKey === sourceParentKey
      ? parent
      : loadGatewaySessionEntryReadOnly(params.requestedSessionKey);
  const entry = loaded?.entry;
  const targetSessionId = entry?.sessionId;
  if (
    loaded?.canonicalKey !== params.requestedSessionKey ||
    !targetSessionId ||
    !entry ||
    entry.archivedAt !== undefined ||
    targetSessionId === params.source.sessionId
  ) {
    throw new Error("Worker sessions_send target is not an exact live session");
  }
  const targetParent = relationKey(entry.parentSessionKey) ?? relationKey(entry.spawnedBy);
  const targetParentId = relationKey(entry.parentSessionId);
  const parentToChild =
    targetParent === params.source.sessionKey && targetParentId === params.source.sessionId;
  const childToParent = loaded === parent;
  const siblingParent =
    !parentToChild &&
    !childToParent &&
    targetParent === sourceParentKey &&
    targetParentId === relationKey(params.source.entry.parentSessionId)
      ? resolveParent(params.source)
      : undefined;
  if (!parentToChild && !childToParent && !siblingParent) {
    throw new Error("Worker sessions_send target is outside the authorized session tree");
  }
  // Session identity owns messaging authority. Target turn admission chooses
  // its execution placement, including Gateway-local or reclaimed workers.
  return {
    agentId: loaded.agentId,
    sessionKey: loaded.canonicalKey,
    sessionId: targetSessionId,
    ...(siblingParent
      ? {
          topologyParent: {
            agentId: siblingParent.agentId,
            sessionKey: siblingParent.canonicalKey,
            sessionId: siblingParent.sessionId,
          },
        }
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
