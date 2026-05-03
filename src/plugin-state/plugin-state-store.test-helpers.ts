import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolvePluginStateSqlitePath } from "./plugin-state-store.paths.js";
import { closePluginStateSqliteStore, probePluginStateStore } from "./plugin-state-store.sqlite.js";

export type PluginStateSeedEntry = {
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  createdAt?: number;
  expiresAt?: number | null;
};

export function seedPluginStateEntriesForTests(entries: PluginStateSeedEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  probePluginStateStore();
  closePluginStateSqliteStore();

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(resolvePluginStateSqlitePath());
  const insertEntry = db.prepare(`
    INSERT INTO plugin_state_entries (
      plugin_id,
      namespace,
      entry_key,
      value_json,
      created_at,
      expires_at
    ) VALUES (
      @plugin_id,
      @namespace,
      @entry_key,
      @value_json,
      @created_at,
      @expires_at
    )
  `);
  const now = Date.now();

  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const valueJson = JSON.stringify(entry.value);
      if (valueJson == null) {
        throw new Error("plugin state seed value must be JSON serializable");
      }
      insertEntry.run({
        plugin_id: entry.pluginId,
        namespace: entry.namespace,
        entry_key: entry.key,
        value_json: valueJson,
        created_at: entry.createdAt ?? now + index,
        expires_at: entry.expiresAt ?? null,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
