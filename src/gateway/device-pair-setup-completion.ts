import type { DevicePairSetupCompletedEvent } from "../../packages/gateway-protocol/src/index.js";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  restoreConsumedDeviceBootstrapToken,
} from "../infra/device-bootstrap.js";
import type {
  DeviceBootstrapTokenRecord,
  DevicePairSetupCompletionRecord,
} from "../infra/device-pairing.types.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";

export type SetupHandoff = {
  record: DeviceBootstrapTokenRecord;
  completion?: DevicePairSetupCompletionRecord;
};

// Completion records durable pairing, not response receipt. Commit it before
// handoff so a crash with an unknowable delivery outcome cannot erase the fact.
export async function consumeSetupHandoff(params: {
  token: string;
  deviceId: string;
  baseDir?: string;
  ts?: number;
}): Promise<SetupHandoff | null> {
  const completedAtMs = params.ts ?? Date.now();
  const consumed = await consumeDeviceBootstrapTokenWithSetupCompletion({
    token: params.token,
    deviceId: params.deviceId,
    completedAtMs,
    ...(params.baseDir ? { baseDir: params.baseDir } : {}),
  });
  return consumed;
}

/** Compensate an explicit delivery failure without leaving a false completion behind. */
export async function restoreSetupHandoff(params: {
  handoff: SetupHandoff;
  baseDir?: string;
}): Promise<void> {
  await restoreConsumedDeviceBootstrapToken({
    record: params.handoff.record,
    ...(params.handoff.completion ? { completion: params.handoff.completion } : {}),
    ...(params.baseDir ? { baseDir: params.baseDir } : {}),
  });
}

/** Broadcast the already-committed completion; status reconciliation owns delivery loss. */
export function broadcastSetupHandoffCompletion(params: {
  handoff: SetupHandoff;
  broadcast: GatewayBroadcastFn;
}): void {
  const completion = params.handoff.completion;
  if (!completion) {
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
