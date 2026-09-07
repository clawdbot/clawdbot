// Device Pair doctor contract migrates shipped plugin-owned state.
import path from "node:path";
import {
  defineLegacyJsonStateMigration,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  normalizeLegacyNotifyState,
  notifySubscriberStoreKey,
  type LegacyNotifyStateFile,
} from "./notify-state.js";

function resolveLegacyNotifyStatePath(stateDir: string): string {
  return path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  defineLegacyJsonStateMigration<LegacyNotifyStateFile>({
    id: "device-pair-notify-json-to-plugin-state",
    label: "Device Pair notify subscribers",
    resolvePath: resolveLegacyNotifyStatePath,
    parse: normalizeLegacyNotifyState,
    namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
    maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
    capacityPrecheck: {
      warning: ({ available, missing }) =>
        `Skipped Device Pair notify subscriber migration because plugin state has room for ${available} of ${missing} missing entries; left legacy source in place`,
    },
    archiveLabel: "Device Pair notify-state",
    describeEntries: (state, { filePath }) => ({
      preview: [
        `- Device Pair notify subscribers: ${filePath} -> plugin state (${DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE}, ${state.subscribers.length} subscriber(s))`,
      ],
      change: ({ imported, alreadyPresent }) =>
        `Migrated Device Pair notify subscribers -> plugin state (${imported} imported, ${alreadyPresent} already present)`,
    }),
    toRows: (state) =>
      state.subscribers.map((subscriber) => ({
        key: notifySubscriberStoreKey(subscriber),
        value: subscriber,
      })),
  }),
];
