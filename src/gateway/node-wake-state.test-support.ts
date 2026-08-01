import { nodeWakeStateByOwner, nodeWakeStateKey } from "./node-wake-state-store.js";

/** Read-only test projection; callers cannot mutate lifecycle ownership. */
export function getNodeWakeStateSnapshot(
  nodeId: string,
  pairingGeneration?: string,
):
  | {
      lastWakeAtMs: number;
      wakeInFlight: boolean;
      lastNudgeAtMs: number;
      lifecycleUsers: number;
    }
  | undefined {
  const owner = nodeWakeStateByOwner.get(nodeWakeStateKey(nodeId, pairingGeneration));
  return owner
    ? {
        lastWakeAtMs: owner.lastWakeAtMs,
        wakeInFlight: owner.inFlightWake !== undefined,
        lastNudgeAtMs: owner.lastNudgeAtMs,
        lifecycleUsers: owner.lifecycle?.users ?? 0,
      }
    : undefined;
}

export function resetNodeWakeStateForTest(): void {
  for (const owner of nodeWakeStateByOwner.values()) {
    owner.lifecycle?.controller.abort();
  }
  nodeWakeStateByOwner.clear();
}
