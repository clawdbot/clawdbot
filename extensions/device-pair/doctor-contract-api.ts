// Device Pair doctor contract migrates shipped plugin-owned state.
import fs from "node:fs/promises";
import path from "node:path";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";
import {
  DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  normalizeLegacyNotifyState,
  notifySubscriberStoreKey,
  type LegacyNotifyStateFile,
  type NotifySubscription,
} from "./notify-state.js";

function resolveLegacyNotifyStatePath(stateDir: string): string {
  return path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
}

async function readLegacyNotifyState(filePath: string): Promise<LegacyNotifyStateFile | null> {
  try {
    return normalizeLegacyNotifyState(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "device-pair-notify-json-to-plugin-state",
    label: "Device Pair notify subscribers",
    async detectLegacyState(params) {
      const filePath = resolveLegacyNotifyStatePath(params.stateDir);
      const state = await readLegacyNotifyState(filePath);
      if (!state || state.subscribers.length === 0) {
        return null;
      }
      return {
        preview: [
          `- Device Pair notify subscribers: ${filePath} -> plugin state (${DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE}, ${state.subscribers.length} subscriber(s))`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = resolveLegacyNotifyStatePath(params.stateDir);
      const state = await readLegacyNotifyState(filePath);
      if (!state || state.subscribers.length === 0) {
        return { changes, warnings };
      }

      const store = params.context.openPluginStateKeyedStore<NotifySubscription>({
        namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
        maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
      });
      let imported = 0;
      let alreadyPresent = 0;
      for (const subscriber of state.subscribers) {
        const inserted = await store.registerIfAbsent(
          notifySubscriberStoreKey(subscriber),
          subscriber,
        );
        if (inserted) {
          imported++;
        } else {
          alreadyPresent++;
        }
      }

      changes.push(
        `Migrated Device Pair notify subscribers -> plugin state (${imported} imported, ${alreadyPresent} already present)`,
      );
      await archiveLegacyStateSource({
        filePath,
        label: "Device Pair notify-state",
        changes,
        warnings,
      });
      return { changes, warnings };
    },
  },
];
