// Fresh-store reads: a startup-checkpoint DB created before the first plugin-state write has no
// plugin_state_entries table; read-only paths must report empty, not error (#117249).
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  countPluginStateLiveEntries,
  createPluginStateKeyedStore,
  pluginStateEntriesInKeyRange,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

afterEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
});

async function expectPluginStateReadFailure(
  promise: Promise<unknown>,
  expected: { operation: "entries" | "lookup"; path: string },
): Promise<void> {
  let storeError: unknown;
  try {
    await promise;
  } catch (error) {
    storeError = error;
  }
  expect(storeError).toBeInstanceOf(PluginStateStoreError);
  expect(storeError).toMatchObject({
    code: "PLUGIN_STATE_READ_FAILED",
    operation: expected.operation,
    path: expected.path,
  });
}

describe("plugin state fresh-store reads", () => {
  it("treats an existing state database without the lazy plugin-state table as empty", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-read-only-table-missing", applyEnv: false },
      async (state) => {
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        withOpenClawStateStartupMigrationCheckpointDatabase(() => undefined, { env: state.env });

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
        const tables = verify
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
          .all();
        verify.close();
        expect(tables).toEqual([{ name: "schema_meta" }, { name: "state_leases" }]);
      },
    );
  });

  it("rejects a missing plugin-state table after another state table has been initialized", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-read-only-table-damaged", applyEnv: false },
      async (state) => {
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        withOpenClawStateStartupMigrationCheckpointDatabase(() => undefined, { env: state.env });
        const database = new DatabaseSync(databasePath);
        database.exec(`
          CREATE TABLE config_machine_state (
            state_key TEXT NOT NULL PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
          ) STRICT
        `);
        database.close();

        const store = createPluginStateKeyedStore("discord", {
          namespace: "read-only-table-damaged",
          maxEntries: 10,
          env: state.env,
        });

        await expectPluginStateReadFailure(store.lookup("k"), {
          operation: "lookup",
          path: databasePath,
        });
        await expectPluginStateReadFailure(store.entries(), {
          operation: "entries",
          path: databasePath,
        });
      },
    );
  });
});
