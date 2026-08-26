import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";

describe("plugin state schema compatibility", () => {
  it("cold-opens when an existing move table lacks its first-use column", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-placement-move-column", applyEnv: false },
      async (state) => {
        try {
          const first = createPluginStateKeyedStore<{ owner: string }>("discord", {
            namespace: "same-version-placement-move",
            maxEntries: 10,
            env: state.env,
          });
          await first.register("first", { owner: "discord" });
          resetPluginStateStoreForTests();

          const databasePath = resolveOpenClawStateSqlitePath(state.env);
          const previousDatabase = new DatabaseSync(databasePath);
          let versionBefore: unknown;
          let metadataBefore: unknown;
          try {
            versionBefore = previousDatabase.prepare("PRAGMA user_version").get();
            metadataBefore = previousDatabase
              .prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'")
              .get();
            expect(versionBefore).toEqual({ user_version: OPENCLAW_STATE_SCHEMA_VERSION });
            expect(
              previousDatabase
                .prepare(
                  "SELECT plugin_id, namespace, entry_key, value_json FROM plugin_state_entries",
                )
                .all(),
            ).toEqual([
              {
                plugin_id: "discord",
                namespace: "same-version-placement-move",
                entry_key: "first",
                value_json: JSON.stringify({ owner: "discord" }),
              },
            ]);
            expect(
              previousDatabase
                .prepare("SELECT COUNT(*) AS count FROM worker_session_placement_moves")
                .get(),
            ).toEqual({ count: 0 });
            const columnsBefore = previousDatabase
              .prepare("PRAGMA table_info(worker_session_placement_moves)")
              .all()
              .map((column) => (column as { name: string }).name);
            expect(columnsBefore).toContain("target_machine_class");
            previousDatabase.exec(
              "ALTER TABLE worker_session_placement_moves DROP COLUMN target_machine_class;",
            );
            expect(
              previousDatabase
                .prepare("PRAGMA table_info(worker_session_placement_moves)")
                .all()
                .map((column) => (column as { name: string }).name),
            ).toEqual(columnsBefore.filter((column) => column !== "target_machine_class"));
          } finally {
            previousDatabase.close();
          }

          const second = createPluginStateKeyedStore<{ owner: string }>("telegram", {
            namespace: "same-version-placement-move",
            maxEntries: 10,
            env: state.env,
          });
          await second.register("second", { owner: "telegram" });
          resetPluginStateStoreForTests();

          const reopenedDatabase = new DatabaseSync(databasePath);
          try {
            expect(
              reopenedDatabase
                .prepare(
                  `SELECT plugin_id, namespace, entry_key, value_json
                   FROM plugin_state_entries
                   ORDER BY plugin_id`,
                )
                .all(),
            ).toEqual([
              {
                plugin_id: "discord",
                namespace: "same-version-placement-move",
                entry_key: "first",
                value_json: JSON.stringify({ owner: "discord" }),
              },
              {
                plugin_id: "telegram",
                namespace: "same-version-placement-move",
                entry_key: "second",
                value_json: JSON.stringify({ owner: "telegram" }),
              },
            ]);
            expect(
              reopenedDatabase
                .prepare("PRAGMA table_info(worker_session_placement_moves)")
                .all()
                .map((column) => (column as { name: string }).name),
            ).not.toContain("target_machine_class");
            expect(reopenedDatabase.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
            expect(
              reopenedDatabase
                .prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'")
                .get(),
            ).toEqual(metadataBefore);
          } finally {
            reopenedDatabase.close();
          }
        } finally {
          resetPluginStateStoreForTests();
        }
      },
    );
  });
});
