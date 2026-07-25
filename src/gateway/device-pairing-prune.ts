// Prunes superseded silent device pairings after a fresh silent auto-approval.
import {
  pruneSupersededSilentPairedDevices,
  type PrunedSupersededPairedDevice,
} from "../infra/device-pairing.js";
import { clearRemovedNodeRuntimeState } from "./node-runtime-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

type PruneContext = Pick<
  GatewayRequestContext,
  | "broadcast"
  | "hasConnectedClientsForDevice"
  | "invalidateClientsForDevice"
  | "disconnectClientsForDevice"
> & {
  logGateway: Pick<GatewayRequestContext["logGateway"], "info" | "warn">;
  nodeRegistry: Pick<GatewayRequestContext["nodeRegistry"], "updateSurface">;
};

/**
 * After a silent auto-approval, retire older silent pairings of the same client
 * cluster. Ephemeral state dirs mint a fresh deviceId per run and every run
 * re-pairs silently, so without this the paired-device list grows without bound
 * (dozens of stale operator/node records per host).
 */
export async function pruneSupersededSilentPairingsAfterApproval(params: {
  deviceId: string;
  context: PruneContext;
  baseDir?: string;
  nowMs?: number;
}): Promise<PrunedSupersededPairedDevice[]> {
  const { context } = params;
  const pruned = await pruneSupersededSilentPairedDevices({
    deviceId: params.deviceId,
    baseDir: params.baseDir,
    nowMs: params.nowMs,
    isDeviceConnected: (deviceId) => context.hasConnectedClientsForDevice?.(deviceId) ?? false,
  });
  for (const entry of pruned) {
    context.logGateway.info(
      `device pairing pruned superseded silent pairing device=${entry.deviceId} roles=${entry.roles.join(",") || "none"}`,
    );
    if (entry.roles.includes("node")) {
      // Persistent pruning is a node removal owner too. Clear disconnected
      // queues, wake lifecycles, and runtime metadata before session teardown.
      clearRemovedNodeRuntimeState({ nodeId: entry.deviceId, context });
    }
    // Invalidate before disconnect so buffered frames from a racing reconnect
    // fail authorization, mirroring device.pair.remove ordering.
    context.invalidateClientsForDevice?.(entry.deviceId, { reason: "device-pair-removed" });
    if (entry.roles.includes("node")) {
      context.broadcast(
        "node.pair.resolved",
        { requestId: "", nodeId: entry.deviceId, decision: "removed", ts: Date.now() },
        { dropIfSlow: true },
      );
    }
    context.disconnectClientsForDevice?.(entry.deviceId);
  }
  return pruned;
}
