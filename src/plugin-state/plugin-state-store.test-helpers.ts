// Plugin state test helpers seed SQLite plugin state fixtures.
import type { PluginStateStoreProbeResult } from "./plugin-state-store.types.js";
import "./plugin-state-store.js";
import "./plugin-state-store.sqlite.js";

// Test-only seed helpers for plugin state. Values are serialized through the
// same JSON storage path used by the production sqlite store.
type PluginStateSeedEntry = {
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  createdAt?: number;
  expiresAt?: number | null;
};

type PluginStateDatabaseSeedEntry = {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  createdAt?: number;
  expiresAt?: number | null;
};

type PluginStateSqliteTestApi = {
  probePluginStateStore(): PluginStateStoreProbeResult;
  seedPluginStateDatabaseEntriesForTests(entries: readonly PluginStateDatabaseSeedEntry[]): void;
  setMaxPluginStateEntriesPerPluginForTests(value?: number): void;
};

type PluginStateStoreTestApi = {
  clearPluginStateStoreForTests(): void;
};

function getSqliteTestApi(): PluginStateSqliteTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.pluginStateSqliteTestApi")
  ] as PluginStateSqliteTestApi;
}

function getStoreTestApi(): PluginStateStoreTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.pluginStateStoreTestApi")
  ] as PluginStateStoreTestApi;
}

export function clearPluginStateStoreForTests(): void {
  getStoreTestApi().clearPluginStateStoreForTests();
}

export function probePluginStateStore(): PluginStateStoreProbeResult {
  return getSqliteTestApi().probePluginStateStore();
}

export function setMaxPluginStateEntriesPerPluginForTests(value?: number): void {
  getSqliteTestApi().setMaxPluginStateEntriesPerPluginForTests(value);
}

/** Seeds plugin state entries for tests without opening public store handles. */
export function seedPluginStateEntriesForTests(entries: PluginStateSeedEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  getSqliteTestApi().seedPluginStateDatabaseEntriesForTests(
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
