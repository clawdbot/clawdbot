// Node wake state tracks APNs wake attempts and reconnect nudges for paired
// nodes, plus a narrow read-only testing seam.
export const NODE_WAKE_RECONNECT_WAIT_MS = 3_000;
export const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12_000;
export const NODE_WAKE_RECONNECT_POLL_MS = 150;

export type NodeWakeAttempt = {
  available: boolean;
  throttled: boolean;
  path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

type NodeWakeState = {
  lastWakeAtMs: number;
  inFlight?: Promise<NodeWakeAttempt>;
};

export const nodeWakeById = new Map<string, NodeWakeState>();
export const nodeWakeNudgeById = new Map<string, number>();

export function clearNodeWakeState(nodeId: string): void {
  nodeWakeById.delete(nodeId);
  nodeWakeNudgeById.delete(nodeId);
}

// Narrow read-only seam for tests that assert nodeWakeById is cleaned up on
// early-return paths. Keep production surface untouched and do not expose the
// underlying Map reference.
export const testing = {
  getNodeWakeByIdSize(): number {
    return nodeWakeById.size;
  },
  hasNodeWakeEntry(nodeId: string): boolean {
    return nodeWakeById.has(nodeId);
  },
  resetWakeState(): void {
    nodeWakeById.clear();
    nodeWakeNudgeById.clear();
  },
};
