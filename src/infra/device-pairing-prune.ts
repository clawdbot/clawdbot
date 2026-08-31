import {
  mutateDevicePairingState,
  normalizeDevicePairingId,
  withDevicePairingLock,
} from "./device-pairing-state.js";
import {
  invalidatePairedCardRendererCache,
  listApprovedPairedDeviceRoles,
  type PairedDevice,
} from "./device-pairing.js";

// Silent pairings from the same client software on the same host mint a fresh
// deviceId whenever their state dir (and thus keypair) is ephemeral. The cluster
// key groups those records so a replacement pairing can retire its predecessors.
function silentPairingClusterKey(
  device: Pick<PairedDevice, "clientId" | "clientMode" | "displayName">,
): string | null {
  const clientId = device.clientId?.trim().toLowerCase() ?? "";
  const clientMode = device.clientMode?.trim().toLowerCase() ?? "";
  const displayName = device.displayName?.trim().toLowerCase() ?? "";
  if (!clientId && !clientMode && !displayName) {
    return null;
  }
  return `${clientId}\0${clientMode}\0${displayName}`;
}

/** Superseded silent pairing removed in favor of a newer record for the same client. */
export type PrunedSupersededPairedDevice = {
  deviceId: string;
  roles: string[];
};

// A concurrently approved sibling may still be mid-handshake and not yet visible
// to the connected-clients check; freshly approved records are never prune
// candidates so parallel silent pairings cannot delete each other's rows.
const PRUNE_RECENT_APPROVAL_GRACE_MS = 60_000;

/**
 * Remove silent-approved sibling records superseded by a newly approved silent
 * pairing of the same client cluster. Only records whose latest approval was
 * same-host local ("silent") are eligible, as anchor and as victim: local
 * clients re-pair silently by construction and share the gateway host, so the
 * metadata cluster key cannot match a different machine. Currently connected
 * devices are skipped so concurrent sessions with distinct state dirs keep
 * their tokens while live.
 */
export async function pruneSupersededSilentPairedDevices(params: {
  deviceId: string;
  baseDir?: string;
  isDeviceConnected?: (deviceId: string) => boolean;
  nowMs?: number;
}): Promise<PrunedSupersededPairedDevice[]> {
  return await withDevicePairingLock(async () => {
    const removedDevices = mutateDevicePairingState(params.baseDir, (state, persist) => {
      const anchor = state.pairedByDeviceId[normalizeDevicePairingId(params.deviceId)];
      if (!anchor || anchor.approvedVia !== "silent") {
        return [];
      }
      const anchorKey = silentPairingClusterKey(anchor);
      if (!anchorKey) {
        return [];
      }
      const nowMs = params.nowMs ?? Date.now();
      const removed: PrunedSupersededPairedDevice[] = [];
      for (const device of Object.values(state.pairedByDeviceId)) {
        if (device.deviceId === anchor.deviceId) {
          continue;
        }
        // Legacy records without approvedVia stay untouched (fail-safe).
        if (device.approvedVia !== "silent") {
          continue;
        }
        if (silentPairingClusterKey(device) !== anchorKey) {
          continue;
        }
        if (nowMs - device.approvedAtMs < PRUNE_RECENT_APPROVAL_GRACE_MS) {
          continue;
        }
        if (params.isDeviceConnected?.(device.deviceId)) {
          continue;
        }
        delete state.pairedByDeviceId[device.deviceId];
        for (const [requestId, pending] of Object.entries(state.pendingById)) {
          if (pending.deviceId === device.deviceId) {
            delete state.pendingById[requestId];
          }
        }
        removed.push({
          deviceId: device.deviceId,
          roles: listApprovedPairedDeviceRoles(device),
        });
      }
      if (removed.length === 0) {
        return [];
      }
      persist("both", {
        clearApnsNodeIds: removed.map((entry) => entry.deviceId),
      });
      return removed;
    });
    if (removedDevices.length > 0) {
      invalidatePairedCardRendererCache();
    }
    return removedDevices;
  });
}
