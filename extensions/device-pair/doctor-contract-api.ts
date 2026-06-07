// Device Pair doctor contract migrates shipped plugin-owned state.
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readLegacyNotifyState(filePath: string): Promise<LegacyNotifyStateFile | null> {
  try {
    return normalizeLegacyNotifyState(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

async function archiveLegacySource(params: {
  filePath: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated Device Pair notify-state source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived Device Pair notify-state legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving Device Pair notify-state legacy source: ${String(err)}`);
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
      await archiveLegacySource({ filePath, changes, warnings });
      return { changes, warnings };
    },
  },
];
