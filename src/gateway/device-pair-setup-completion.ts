import type { DevicePairSetupCompletedEvent } from "../../packages/gateway-protocol/src/index.js";
import { recordDevicePairSetupCompletion } from "../infra/device-bootstrap.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import type { DeviceBootstrapTokenRecord } from "../infra/device-pairing.types.js";
import { resolvePairingSetupAccess } from "../shared/device-bootstrap-profile.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";

/**
 * Settle one consumed setup record after credential delivery succeeded: record
 * the terminal outcome first, then announce it. Persisting first is what makes
 * the broadcast safe to lose — a client that misses the frame reconciles the
 * same fact through `device.pair.setupStatus`.
 */
export async function settleSetupCompletion(params: {
  record: DeviceBootstrapTokenRecord;
  deviceId: string;
  broadcast: GatewayBroadcastFn;
  baseDir?: string;
  ts?: number;
}): Promise<void> {
  const setupId = params.record.setupId;
  if (!setupId) {
    return;
  }
  const paired = await getPairedDevice(params.deviceId, params.baseDir);
  const deviceName = paired?.operatorLabel ?? paired?.displayName;
  const named = deviceName ? { deviceName } : {};
  const access = resolvePairingSetupAccess(params.record.profile);
  const completedAtMs = params.ts ?? Date.now();
  await recordDevicePairSetupCompletion({
    setupId,
    deviceId: params.deviceId,
    ...named,
    access,
    completedAtMs,
    ...(params.baseDir ? { baseDir: params.baseDir } : {}),
  });
  const payload = {
    setupId,
    deviceId: params.deviceId,
    ...named,
    access,
    ts: completedAtMs,
  } satisfies DevicePairSetupCompletedEvent;
  // Slow operator sockets drop this frame rather than being closed; the
  // recorded completion above is the recovery path, so the drop is bounded.
  params.broadcast("device.pair.setup.completed", payload, { dropIfSlow: true });
}
