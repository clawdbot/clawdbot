type StoredNodeWakeAttempt = {
  available: boolean;
  throttled: boolean;
  path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error" | "invalidated";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

export type NodeWakeOwnerState = {
  nodeId: string;
  stateKey: string;
  lastWakeAtMs: number;
  inFlightWake?: Promise<StoredNodeWakeAttempt>;
  lastNudgeAtMs: number;
  lifecycle?: {
    controller: AbortController;
    users: number;
  };
};

export const nodeWakeStateByOwner = new Map<string, NodeWakeOwnerState>();
export const nodeWakeOwnerBySignal = new WeakMap<AbortSignal, NodeWakeOwnerState>();

export function nodeWakeStateKey(nodeId: string, pairingGeneration?: string): string {
  return JSON.stringify([nodeId.trim(), pairingGeneration?.trim() || null]);
}
