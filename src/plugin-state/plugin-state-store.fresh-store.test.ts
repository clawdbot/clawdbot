// Fresh-store reads: a state DB created before the first plugin-state write has no
// plugin_state_entries table; read-only paths must report empty, not error (#117249).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  countPluginStateLiveEntries,
  createPluginStateKeyedStore,
  pluginStateEntriesInKeyRange,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";

afterEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
});

describe("plugin state fresh-store reads", () => {
  it("treats an existing state database without the lazy plugin-state table as empty", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-read-only-table-missing", applyEnv: false },
      async (state) => {
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        mkdirSync(path.dirname(databasePath), { recursive: true });
        const database = new DatabaseSync(databasePath);
        database.exec("CREATE TABLE unrelated_state (id INTEGER PRIMARY KEY)");
        database.close();

        const store = createPluginStateKeyedStore("discord", {
          namespace: "read-only-table-missing",
          maxEntries: 10,
          env: state.env,
        });

        await expect(store.lookup("k")).resolves.toBeUndefined();
        await expect(store.entries()).resolves.toEqual([]);
        expect(
          pluginStateEntriesInKeyRange({
            pluginId: "discord",
            namespace: "read-only-table-missing",
            keyStartInclusive: "a",
            keyEndExclusive: "z",
            limit: 1,
            env: state.env,
          }),
        ).toEqual([]);
        expect(countPluginStateLiveEntries("discord", state.env)).toBe(0);

        const verify = new DatabaseSync(databasePath, { readOnly: true });
        expect(
          verify
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'plugin_state_entries'",
            )
            .get(),
        ).toBeUndefined();
        verify.close();
      },
    );
  });
});
