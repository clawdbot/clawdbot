import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { loadDeviceBootstrapTokenRecords } from "./device-pairing-store.js";
import type { DeviceBootstrapTokenRecord } from "./device-pairing.types.js";
import { createAsyncLock, pruneExpiredPending } from "./pairing-files.js";

export const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;
export type DeviceBootstrapState = Record<string, DeviceBootstrapTokenRecord>;
export const withDeviceBootstrapLock = createAsyncLock();

export async function loadDeviceBootstrapState(baseDir?: string): Promise<DeviceBootstrapState> {
  const state = loadDeviceBootstrapTokenRecords(baseDir);
  pruneExpiredPending(state, asDateTimestampMs(Date.now()) ?? 0, DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
  return state;
}
