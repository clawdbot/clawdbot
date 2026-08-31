import {
  mutateDevicePairingStoreStateInTransaction,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";

export function seedDevicePairingStoreState(
  state: DevicePairingStoreState,
  baseDir?: string,
  options?: { clearApnsNodeIds?: readonly string[] },
): void {
  mutateDevicePairingStoreStateInTransaction(baseDir, (current, persist) => {
    current.pendingById = state.pendingById;
    current.pairedByDeviceId = state.pairedByDeviceId;
    persist("both", options);
  });
}
