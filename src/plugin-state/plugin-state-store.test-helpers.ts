// Plugin state test helpers seed SQLite plugin state fixtures.
import { seedPluginStateDatabaseEntriesForTests } from "./plugin-state-store.sqlite.js";

// Test-only seed helpers for plugin state. Values are serialized through the
// same JSON storage path used by the production sqlite store.
export type PluginStateSeedEntry = {
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  createdAt?: number;
  expiresAt?: number | null;
};

/** Seeds plugin state entries for tests without opening public store handles. */
export function seedPluginStateEntriesForTests(entries: PluginStateSeedEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  seedPluginStateDatabaseEntriesForTests(
    entries.map((entry) => {
      const valueJson = JSON.stringify(entry.value);
      if (valueJson == null) {
        throw new Error("plugin state seed value must be JSON serializable");
      }
      return {
        pluginId: entry.pluginId,
        namespace: entry.namespace,
        key: entry.key,
        valueJson,
        ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
        ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
      };
    }),
  );
}
