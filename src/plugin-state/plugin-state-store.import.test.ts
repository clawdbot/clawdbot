import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createPluginStateSyncKeyedStore,
  importPluginStateEntriesForDoctor,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import {
  clearPluginStateStoreForTests,
  seedPluginStateEntriesForTests,
  setMaxPluginStateEntriesPerPluginForTests,
} from "./plugin-state-store.test-helpers.js";

let testState: OpenClawTestState;
const pluginId = "import-test";
const options = { namespace: "legacy", maxEntries: 2_000 };
const entries = Array.from({ length: 1_001 }, (_, index) => ({
  key: `row-${index}`,
  value: index,
  createdAt: index - 2_000,
}));

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-import" });
});
beforeEach(() => {
  testState.applyEnv();
  clearPluginStateStoreForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  setMaxPluginStateEntriesPerPluginForTests(undefined);
  resetPluginStateStoreForTests();
});
afterAll(async () => {
  await testState.cleanup();
});

describe("doctor plugin state import", () => {
  it("bounds commit work while retaining source ages and remaining TTLs", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const exec = vi.spyOn(openOpenClawStateDatabase().db, "exec");
    importPluginStateEntriesForDoctor(
      pluginId,
      options,
      entries.map((entry) => ({ ...entry, ttlMs: 100 })),
    );
    const commits = exec.mock.calls.filter(([sql]) => sql === "COMMIT").length;
    expect(commits).toBeGreaterThan(1);
    expect(commits).toBeLessThanOrEqual(3);
    const store = createPluginStateSyncKeyedStore(pluginId, options);
    expect(store.entries()).toEqual(entries.map((entry) => ({ ...entry, expiresAt: 10_100 })));
    now.mockReturnValue(10_100);
    expect(store.entries()).toEqual([]);
  });

  it("commits the successful prefix of a failed batch and converges on rerun", () => {
    const bounded = { ...options, maxEntries: 600 };
    const db = openOpenClawStateDatabase().db;
    db.exec(`CREATE TEMP TRIGGER fail_import BEFORE DELETE ON plugin_state_entries
      WHEN OLD.entry_key = 'row-150' BEGIN SELECT RAISE(ABORT, 'injected import failure'); END`);
    const store = createPluginStateSyncKeyedStore(pluginId, bounded);
    try {
      expect(() => importPluginStateEntriesForDoctor(pluginId, bounded, entries)).toThrow(
        "Failed to register plugin state entry",
      );
      expect(store.entries()).toEqual(entries.slice(150, 750));
    } finally {
      db.exec("DROP TRIGGER fail_import");
    }
    resetPluginStateStoreForTests();
    importPluginStateEntriesForDoctor(pluginId, bounded, entries);
    expect(store.entries()).toEqual(entries.slice(-600));
    importPluginStateEntriesForDoctor(pluginId, bounded, entries);
    expect(store.entries()).toEqual(entries.slice(-600));
  });

  it.each([false, true])("refreshes retention across clock changes (backward: %s)", (backward) => {
    let clock = backward ? 10_002 : 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    setMaxPluginStateEntriesPerPluginForTests(2);
    seedPluginStateEntriesForTests([
      { pluginId, namespace: "durable", key: "sibling", value: true, expiresAt: 10_001 },
    ]);
    const db = openOpenClawStateDatabase().db;
    db.function("advance_import_clock", () => {
      clock = backward ? 10_000 : 10_001;
      return 0;
    });
    db.exec(`CREATE TEMP TRIGGER advance_clock AFTER INSERT ON plugin_state_entries
      WHEN NEW.entry_key = 'first' BEGIN SELECT advance_import_clock(); END`);
    const limited = { ...options, maxEntries: 2, overflowPolicy: "reject-new" as const };
    const source = [
      { key: "first", value: 1, createdAt: -2 },
      { key: "second", value: 2, createdAt: -1, ttlMs: 100 },
    ];
    if (backward) {
      expect(() => importPluginStateEntriesForDoctor(pluginId, limited, source)).toThrow(
        "reached the 2 live row limit",
      );
    } else {
      importPluginStateEntriesForDoctor(pluginId, limited, source);
    }
    const actual = createPluginStateSyncKeyedStore(pluginId, limited).entries();
    expect(actual).toEqual(
      backward
        ? [source[0]]
        : [source[0], { key: "second", value: 2, createdAt: -1, expiresAt: 10_101 }],
    );
  });

  it.each([0, 17, 750])("commits only the valid prefix before preparation fails at %i", (index) => {
    const invalid = entries.map((entry, offset) =>
      offset === index ? { ...entry, createdAt: Number.NaN } : entry,
    );
    expect(() => importPluginStateEntriesForDoctor(pluginId, options, invalid)).toThrow(
      "createdAt must be a safe integer",
    );
    const store = createPluginStateSyncKeyedStore(pluginId, options);
    expect(store.entries()).toEqual(entries.slice(0, index));
    importPluginStateEntriesForDoctor(pluginId, options, entries);
    expect(store.entries()).toEqual(entries);
  });

  it.each(["evict-oldest", "reject-new"] as const)(
    "preserves %s retention with duplicate keys and durable sibling rows",
    (overflowPolicy) => {
      setMaxPluginStateEntriesPerPluginForTests(3);
      seedPluginStateEntriesForTests([
        { pluginId, namespace: "durable", key: "sibling", value: true },
      ]);
      const limited = { ...options, maxEntries: 2, overflowPolicy };
      const source = [
        { key: "z", value: 1, createdAt: 20 },
        { key: "a", value: 2, createdAt: 10 },
        { key: "z", value: 3, createdAt: 20 },
        { key: "older", value: 4, createdAt: -10 },
      ];
      if (overflowPolicy === "reject-new") {
        expect(() => importPluginStateEntriesForDoctor(pluginId, limited, source)).toThrow(
          "reached its 2-row limit",
        );
      } else {
        importPluginStateEntriesForDoctor(pluginId, limited, source);
      }
      const store = createPluginStateSyncKeyedStore(pluginId, limited);
      expect(store.entries()).toEqual([source[overflowPolicy === "reject-new" ? 1 : 3], source[2]]);
      expect(
        createPluginStateSyncKeyedStore(pluginId, { namespace: "durable", maxEntries: 1 }).lookup(
          "sibling",
        ),
      ).toBe(true);
    },
  );
});
