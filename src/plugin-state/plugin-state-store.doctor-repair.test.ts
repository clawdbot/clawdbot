import { rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createPluginStateSyncKeyedStore,
  MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
  pluginStateDeleteEntriesIfUnchanged,
  pluginStateDoctorEntriesInKeyRange,
  pluginStateEntriesInKeyRange,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import {
  clearPluginStateStoreForTests,
  seedPluginStateEntriesForTests,
} from "./plugin-state-store.test-helpers.js";

let testState: OpenClawTestState | undefined;

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-doctor-repair" });
  rmSync(path.dirname(resolveOpenClawStateSqlitePath()), { recursive: true, force: true });
});

beforeEach(() => {
  testState?.applyEnv();
  clearPluginStateStoreForTests();
});

afterEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(async () => {
  resetPluginStateStoreForTests();
  await testState?.cleanup();
});

describe("plugin state Doctor repair", () => {
  it("bulk-deletes only unchanged scoped rows in one bounded transaction", () => {
    const namespace = "bulk-bindings";
    seedPluginStateEntriesForTests([
      ...Array.from({ length: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES }, (_, index) => ({
        pluginId: "codex",
        namespace,
        key: `binding:${String(index).padStart(4, "0")}`,
        value: { generation: 1 },
      })),
      { pluginId: "codex", namespace: "other", key: "binding:0000", value: { keep: true } },
      { pluginId: "other", namespace, key: "binding:0000", value: { keep: true } },
    ]);
    const observed = pluginStateDoctorEntriesInKeyRange({
      pluginId: "codex",
      namespace,
      prefix: "binding:",
      limit: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
    });
    const store = createPluginStateSyncKeyedStore<{ generation: number }>("codex", {
      namespace,
      maxEntries: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
    });
    store.register("binding:0000", { generation: 2 });
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    const ownerAssertions: boolean[] = [];
    const assertOwnedInTransaction = (database: DatabaseSync) => {
      ownerAssertions.push(database.isTransaction);
    };
    try {
      expect(
        pluginStateDeleteEntriesIfUnchanged({
          pluginId: "codex",
          namespace,
          entries: observed,
          assertOwnedInTransaction,
        }),
      ).toEqual({ deleted: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES - 1, changed: 1 });
      expect(ownerAssertions).toEqual([true]);
      expect(exec.mock.calls.filter(([sql]) => sql.trim() === "BEGIN IMMEDIATE")).toHaveLength(1);
      expect(store.lookup("binding:0000")).toEqual({ generation: 2 });
      expect(
        createPluginStateSyncKeyedStore("codex", { namespace: "other", maxEntries: 1 }).lookup(
          "binding:0000",
        ),
      ).toEqual({ keep: true });
      expect(
        createPluginStateSyncKeyedStore("other", { namespace, maxEntries: 1 }).lookup(
          "binding:0000",
        ),
      ).toEqual({ keep: true });
      expect(() =>
        pluginStateDeleteEntriesIfUnchanged({
          pluginId: "codex",
          namespace,
          entries: [...observed, observed[0]!],
          assertOwnedInTransaction,
        }),
      ).toThrow(/cannot exceed 512 entries/);
    } finally {
      exec.mockRestore();
    }
  });

  it("pages past malformed rows and compares siblings' original JSON bytes", () => {
    const namespace = "raw-doctor-bindings";
    seedPluginStateEntriesForTests([
      { pluginId: "codex", namespace, key: "binding:a", value: { corrupt: true } },
      { pluginId: "codex", namespace, key: "binding:b", value: { generation: 1 } },
      { pluginId: "codex", namespace, key: "binding:c", value: { generation: 1 } },
      { pluginId: "codex", namespace, key: "binding:d", value: { generation: 1 }, createdAt: -1 },
    ]);
    const database = openOpenClawStateDatabase().db;
    const replaceJson = database.prepare(
      "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
    );
    replaceJson.run("{malformed", "codex", namespace, "binding:a");
    replaceJson.run('{ "generation" : 1 }', "codex", namespace, "binding:b");
    replaceJson.run('{ "generation" : 1 }', "codex", namespace, "binding:c");

    const first = pluginStateDoctorEntriesInKeyRange({
      pluginId: "codex",
      namespace,
      prefix: "binding:",
      limit: 1,
    });
    expect(first).toEqual([
      expect.objectContaining({ key: "binding:a", valueJson: "{malformed", expiresAt: null }),
    ]);
    expect(first[0]).not.toHaveProperty("value");
    expect(() =>
      pluginStateEntriesInKeyRange({
        pluginId: "codex",
        namespace,
        keyStartInclusive: "binding:",
        keyEndExclusive: "binding;",
        limit: 1,
      }),
    ).toThrow(/corrupt JSON/);

    const siblings = pluginStateDoctorEntriesInKeyRange({
      pluginId: "codex",
      namespace,
      prefix: "binding:",
      after: first[0]!.key,
      limit: 2,
    });
    expect(siblings).toEqual([
      expect.objectContaining({
        key: "binding:b",
        value: { generation: 1 },
        valueJson: '{ "generation" : 1 }',
      }),
      expect.objectContaining({
        key: "binding:c",
        value: { generation: 1 },
        valueJson: '{ "generation" : 1 }',
      }),
    ]);
    replaceJson.run('{"generation":1}', "codex", namespace, "binding:c");

    expect(() =>
      pluginStateDeleteEntriesIfUnchanged({
        pluginId: "codex",
        namespace,
        entries: siblings,
        assertOwnedInTransaction: () => {
          throw new Error("maintenance ownership expired");
        },
      }),
    ).toThrow(/maintenance ownership expired/);
    expect(
      pluginStateDeleteEntriesIfUnchanged({
        pluginId: "codex",
        namespace,
        entries: siblings,
        assertOwnedInTransaction: () => {},
      }),
    ).toEqual({ deleted: 1, changed: 1 });
    const preserved = pluginStateDoctorEntriesInKeyRange({
      pluginId: "codex",
      namespace,
      prefix: "binding:",
      limit: 4,
    });
    expect(preserved.map((entry) => entry.key)).toEqual(["binding:a", "binding:c", "binding:d"]);
    expect(preserved[2]).not.toHaveProperty("value");
  });
});
