// Fresh-store reads remain empty after checkpoint bootstrap; missing canonical tables stay errors.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
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
  it("initializes an empty canonical plugin-state store before startup checkpoint reads", async () => {
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
        await expect(store.lookupMany(["k"])).resolves.toEqual([{ ok: true, value: undefined }]);
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
        try {
          expect(verify.prepare("PRAGMA user_version").get()).toEqual({
            user_version: OPENCLAW_STATE_SCHEMA_VERSION,
          });
          expect(
            verify
              .prepare("SELECT name FROM sqlite_schema WHERE name = 'plugin_state_entries'")
              .get(),
          ).toEqual({ name: "plugin_state_entries" });
        } finally {
          verify.close();
        }
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
        database.exec("DROP TABLE plugin_state_entries");
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
