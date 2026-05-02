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
