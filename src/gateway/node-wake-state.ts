// Gateway-owned APNs wake, reconnect nudge, and cancellation state.
import {
  nodeWakeOwnerBySignal,
  nodeWakeStateByOwner,
  nodeWakeStateKey,
  type NodeWakeOwnerState,
} from "./node-wake-state-store.js";

export const NODE_WAKE_RECONNECT_WAIT_MS = 3_000;
export const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12_000;
export const NODE_WAKE_RECONNECT_POLL_MS = 150;

export type NodeWakeAttempt = {
  available: boolean;
  throttled: boolean;
  path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error" | "invalidated";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

export type NodeWakeNudgeAttempt = {
  sent: boolean;
  throttled: boolean;
  reason:
    | "throttled"
    | "no-registration"
    | "no-auth"
    | "send-error"
    | "apns-not-ok"
    | "sent"
    | "invalidated";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

export type NodeWakeLifecycle = AbortSignal;

function getOrCreateNodeWakeOwner(nodeId: string, pairingGeneration?: string): NodeWakeOwnerState {
  const normalizedNodeId = nodeId.trim();
  const stateKey = nodeWakeStateKey(normalizedNodeId, pairingGeneration);
  const existing = nodeWakeStateByOwner.get(stateKey);
  if (existing) {
    return existing;
  }
  const created: NodeWakeOwnerState = {
    nodeId: normalizedNodeId,
    stateKey,
    lastWakeAtMs: 0,
    lastNudgeAtMs: 0,
  };
  nodeWakeStateByOwner.set(stateKey, created);
  return created;
}

function deleteIdleNodeWakeOwner(owner: NodeWakeOwnerState): void {
  if (
    owner.lifecycle?.users ||
    owner.inFlightWake ||
    owner.lastWakeAtMs > 0 ||
    owner.lastNudgeAtMs > 0
  ) {
    return;
  }
  owner.lifecycle?.controller.abort();
  if (owner.lifecycle) {
    nodeWakeOwnerBySignal.delete(owner.lifecycle.controller.signal);
  }
  nodeWakeStateByOwner.delete(owner.stateKey);
}

export function captureNodeWakeLifecycle(
  nodeId: string,
  pairingGeneration?: string,
): NodeWakeLifecycle {
  const owner = getOrCreateNodeWakeOwner(nodeId, pairingGeneration);
  if (!owner.lifecycle || owner.lifecycle.controller.signal.aborted) {
    owner.lifecycle = { controller: new AbortController(), users: 0 };
    nodeWakeOwnerBySignal.set(owner.lifecycle.controller.signal, owner);
  }
  owner.lifecycle.users += 1;
  return owner.lifecycle.controller.signal;
}

export function isNodeWakeLifecycleCurrent(
  nodeId: string,
  lifecycle: NodeWakeLifecycle,
  pairingGeneration?: string,
): boolean {
  const owner = nodeWakeOwnerBySignal.get(lifecycle);
  const expectedStateKey = nodeWakeStateKey(nodeId, pairingGeneration);
  return (
    !lifecycle.aborted &&
    owner?.nodeId === nodeId.trim() &&
    owner.stateKey === expectedStateKey &&
    nodeWakeStateByOwner.get(expectedStateKey) === owner &&
    owner.lifecycle?.controller.signal === lifecycle
  );
}

export function releaseNodeWakeLifecycle(nodeId: string, lifecycle: NodeWakeLifecycle): void {
  const owner = nodeWakeOwnerBySignal.get(lifecycle);
  if (
    owner?.nodeId !== nodeId.trim() ||
    nodeWakeStateByOwner.get(owner.stateKey) !== owner ||
    owner.lifecycle?.controller.signal !== lifecycle
  ) {
    return;
  }
  owner.lifecycle.users = Math.max(0, owner.lifecycle.users - 1);
  deleteIdleNodeWakeOwner(owner);
}

/** Owns wake dedupe and throttle state while the caller owns APNs policy and I/O. */
export async function runNodeWakeAttempt(params: {
  nodeId: string;
  pairingGeneration?: string;
  force: boolean;
  throttleMs: number;
  attempt: (markAttempted: () => void) => Promise<NodeWakeAttempt>;
}): Promise<NodeWakeAttempt> {
  const owner = getOrCreateNodeWakeOwner(params.nodeId, params.pairingGeneration);
  if (owner.inFlightWake) {
    return await owner.inFlightWake;
  }
  if (
    !params.force &&
    owner.lastWakeAtMs > 0 &&
    Date.now() - owner.lastWakeAtMs < params.throttleMs
  ) {
    return { available: true, throttled: true, path: "throttled", durationMs: 0 };
  }

  const attempt = params.attempt(() => {
    owner.lastWakeAtMs = Date.now();
  });
  owner.inFlightWake = attempt;
  try {
    return await attempt;
  } finally {
    if (owner.inFlightWake === attempt) {
      owner.inFlightWake = undefined;
    }
    deleteIdleNodeWakeOwner(owner);
  }
}

/** Owns reconnect-nudge throttling while the caller owns APNs policy and I/O. */
export async function runNodeWakeNudgeAttempt(params: {
  nodeId: string;
  pairingGeneration?: string;
  throttleMs: number;
  throttled: () => NodeWakeNudgeAttempt;
  attempt: () => Promise<NodeWakeNudgeAttempt>;
}): Promise<NodeWakeNudgeAttempt> {
  const owner = getOrCreateNodeWakeOwner(params.nodeId, params.pairingGeneration);
  if (owner.lastNudgeAtMs > 0 && Date.now() - owner.lastNudgeAtMs < params.throttleMs) {
    return params.throttled();
  }
  const result = await params.attempt();
  if (result.reason === "sent") {
    owner.lastNudgeAtMs = Date.now();
  }
  deleteIdleNodeWakeOwner(owner);
  return result;
}

export function clearNodeWakeState(nodeId: string): void {
  const normalizedNodeId = nodeId.trim();
  for (const owner of nodeWakeStateByOwner.values()) {
    if (owner.nodeId !== normalizedNodeId) {
      continue;
    }
    owner.lastWakeAtMs = 0;
    owner.inFlightWake = undefined;
    owner.lastNudgeAtMs = 0;
    deleteIdleNodeWakeOwner(owner);
  }
}

export function invalidateNodeWakeState(nodeId: string): void {
  const normalizedNodeId = nodeId.trim();
  for (const owner of nodeWakeStateByOwner.values()) {
    if (owner.nodeId !== normalizedNodeId) {
      continue;
    }
    owner.lifecycle?.controller.abort();
    if (owner.lifecycle) {
      nodeWakeOwnerBySignal.delete(owner.lifecycle.controller.signal);
    }
    nodeWakeStateByOwner.delete(owner.stateKey);
  }
}
