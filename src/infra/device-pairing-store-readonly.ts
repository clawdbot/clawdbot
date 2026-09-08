// Read-only device pairing snapshots avoid joining the shared-state writer lifecycle.
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  readDevicePairingStoreStateFromDatabase,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";

/** Load pairing state without creating or migrating the shared state database. */
export function loadDevicePairingStoreStateReadOnly(baseDir?: string): DevicePairingStoreState {
  const options = baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readDevicePairingStoreStateFromDatabase(db),
      options,
    ) ?? { pendingById: {}, pairedByDeviceId: {} }
  );
}

/** Read paired-device authority synchronously for closure-bound privileged use. */
export function listPairedDevicesReadOnly(baseDir?: string) {
  return Object.values(loadDevicePairingStoreStateReadOnly(baseDir).pairedByDeviceId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
}
