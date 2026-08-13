import type {
  DevicePairSetupCompletedEvent,
  DevicePairSetupDeliveryUncertainEvent,
} from "../../packages/gateway-protocol/src/index.js";
import {
  confirmDevicePairSetupCompletionDelivery,
  consumeDeviceBootstrapTokenWithSetupCompletion,
} from "../infra/device-bootstrap.js";
import type {
  DeviceBootstrapTokenRecord,
  DevicePairSetupCompletionRecord,
  PairedDevice,
} from "../infra/device-pairing.types.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";

export type SetupHandoff = {
  record: DeviceBootstrapTokenRecord;
  completion?: DevicePairSetupCompletionRecord;
};

// Consumption retires the bearer and records an uncertain handoff before the
// response. A separate confirmation makes operator-visible success truthful.
export async function consumeSetupHandoff(params: {
  token: string;
  deviceId: string;
  pairedDeviceMatches?: (device: PairedDevice | null) => boolean;
  baseDir?: string;
  ts?: number;
}): Promise<SetupHandoff | null> {
  const completedAtMs = params.ts ?? Date.now();
  const consumed = await consumeDeviceBootstrapTokenWithSetupCompletion({
    token: params.token,
    deviceId: params.deviceId,
    completedAtMs,
    ...(params.pairedDeviceMatches ? { pairedDeviceMatches: params.pairedDeviceMatches } : {}),
    ...(params.baseDir ? { baseDir: params.baseDir } : {}),
  });
  return consumed;
}

/** Confirm the response completed before the operator can observe success. */
export async function confirmSetupHandoffDelivery(params: {
  handoff: SetupHandoff;
  baseDir?: string;
}): Promise<SetupHandoff | null> {
  const completion = params.handoff.completion;
  if (!completion) {
    return params.handoff;
  }
  const confirmed = await confirmDevicePairSetupCompletionDelivery({
    setupId: completion.setupId,
    deviceId: completion.deviceId,
    ...(params.baseDir ? { baseDir: params.baseDir } : {}),
  });
  return confirmed ? { record: params.handoff.record, completion: confirmed } : null;
}

/** Broadcast the already-committed completion; status reconciliation owns delivery loss. */
export function broadcastSetupHandoffCompletion(params: {
  handoff: SetupHandoff;
  broadcast: GatewayBroadcastFn;
}): void {
  const completion = params.handoff.completion;
  if (!completion || completion.deliveryState !== "confirmed") {
    return;
  }
  const payload = {
    setupId: completion.setupId,
    deviceId: completion.deviceId,
    ...(completion.deviceName ? { deviceName: completion.deviceName } : {}),
    access: completion.access,
    ts: completion.completedAtMs,
  } satisfies DevicePairSetupCompletedEvent;
  // Slow operator sockets drop this frame rather than being closed; the
  // recorded completion above is the recovery path, so the drop is bounded.
  params.broadcast("device.pair.setup.completed", payload, { dropIfSlow: true });
}

/** Tell the operator that replay is blocked but credential delivery is unknown. */
export function broadcastSetupHandoffDeliveryUncertain(params: {
  handoff: SetupHandoff;
  broadcast: GatewayBroadcastFn;
}): void {
  const completion = params.handoff.completion;
  if (!completion || completion.deliveryState !== "uncertain") {
    return;
  }
  const payload = {
    setupId: completion.setupId,
    deviceId: completion.deviceId,
    ...(completion.deviceName ? { deviceName: completion.deviceName } : {}),
    access: completion.access,
    ts: completion.completedAtMs,
  } satisfies DevicePairSetupDeliveryUncertainEvent;
  params.broadcast("device.pair.setup.deliveryUncertain", payload, { dropIfSlow: true });
}
