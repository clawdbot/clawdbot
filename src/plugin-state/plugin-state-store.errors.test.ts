import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import {
  clearOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
  recordOpenClawStateDatabaseOpenFailure,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  closePluginStateDatabase,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
  pluginStateEntriesInKeyRange,
} from "./plugin-state-store.js";

let testState: OpenClawTestState | undefined;
beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-open-errors" });
});
beforeEach(() => testState?.applyEnv());
afterEach(() => resetPluginStateStoreForTests());
afterAll(async () => testState?.cleanup());

describe("plugin state open errors", () => {
  it("reports the opened database path for corrupt values with an explicit env", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-corrupt-explicit-env", applyEnv: false },
      async (state) => {
        const options = { namespace: "corrupt-env", maxEntries: 10, env: state.env };
        const sync = createPluginStateSyncKeyedStore<{ owner: string }>("discord", options);
        const store = createPluginStateKeyedStore<{ owner: string }>("discord", options);
        sync.register("key", { owner: "custom" });
        const database = openOpenClawStateDatabase({ env: state.env });
        expect(database.path).not.toBe(resolveOpenClawStateSqlitePath());
        database.db
          .prepare("UPDATE plugin_state_entries SET value_json = ? WHERE namespace = ?")
          .run("invalid JSON", options.namespace);
        const expected = {
          code: "PLUGIN_STATE_CORRUPT",
          path: database.path,
          message: "Plugin state entry contains corrupt JSON.",
        };
        for (const connection of ["warm", "readonly"]) {
          if (connection === "readonly") {
            closePluginStateDatabase();
          }
          for (const read of [
            () => sync.lookup("key"),
            () => store.lookup("key"),
            () => sync.entries(),
            () => store.entries(),
            () =>
              pluginStateEntriesInKeyRange({
                pluginId: "discord",
                namespace: options.namespace,
                keyStartInclusive: "key",
                keyEndExclusive: "kez",
                limit: 1,
                env: state.env,
              }),
          ]) {
            await expect((async () => await read())()).rejects.toMatchObject(expected);
          }
          expect(sync.lookupMany(["key"])).toEqual([
            { ok: false, error: expect.objectContaining({ ...expected, operation: "lookup" }) },
          ]);
          await expect(store.lookupMany(["key"])).resolves.toEqual([
            { ok: false, error: expect.objectContaining({ ...expected, operation: "lookup" }) },
          ]);
        }
        let callbackCalled = false;
        for (const stateStore of [sync, store]) {
          const readers = [
            { operation: "consume", read: () => stateStore.consume("key") },
            {
              operation: "lookup",
              read: () =>
                stateStore.update("key", () => {
                  callbackCalled = true;
                  return { owner: "changed" };
                }),
            },
            {
              operation: "delete",
              read: () =>
                stateStore.deleteIf("key", () => {
                  callbackCalled = true;
                  return true;
                }),
            },
          ];
          for (const { read, operation } of readers) {
            await expect((async () => await read())()).rejects.toMatchObject({
              ...expected,
              operation,
            });
          }
        }
        expect(callbackCalled).toBe(false);
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT value_json FROM plugin_state_entries WHERE namespace = ?")
            .get(options.namespace),
        ).toEqual({ value_json: "invalid JSON" });
      },
    );
  });

  it("keeps warm ownership denials distinct from acquisition failures for the same path", async () => {
    // A different open database must not make this fixture's closed path look warm.
    openOpenClawStateDatabase();
    await withOpenClawTestState({ label: "plugin-state-ownership-errors" }, async () => {
      const options = { namespace: "ownership", maxEntries: 10 };
      const store = createPluginStateKeyedStore("discord", options);
      const syncStore = createPluginStateSyncKeyedStore("discord", options);
      await store.register("k", { version: 1 });
      claimOpenClawStateOwnership("fixture-supervisor", {
        env: { ...process.env, OPENCLAW_SUPERVISOR_MODE: "external" },
      });

      for (const code of ["PLUGIN_STATE_WRITE_FAILED", "PLUGIN_STATE_OPEN_FAILED"]) {
        expect(() => syncStore.register("k", { version: 2 })).toThrowError(
          expect.objectContaining({ code, operation: "register" }),
        );
        await expect(store.register("k", { version: 2 })).rejects.toMatchObject({
          code,
          operation: "register",
        });
        await expect(store.lookup("k")).resolves.toEqual({ version: 1 });
        if (code === "PLUGIN_STATE_WRITE_FAILED") {
          expect(closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath())).toBe(true);
        }
      }
    });
  });

  it("keeps transaction lock contention distinct from database-open failures", () => {
    const store = createPluginStateSyncKeyedStore("discord", {
      namespace: "write-contention",
      maxEntries: 10,
    });
    store.register("k", { version: 1 });
    const database = openOpenClawStateDatabase();
    const blocker = new DatabaseSync(database.path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      expect(() =>
        runWithSqliteBusyTimeout(database.db, 0, () => store.register("k", { version: 2 })),
      ).toThrowError(
        expect.objectContaining({
          code: "PLUGIN_STATE_WRITE_FAILED",
          operation: "register",
          message: "Failed to register plugin state entry.",
        }),
      );
    } finally {
      blocker.close();
    }
    expect(store.lookup("k")).toEqual({ version: 1 });
  });

  it("fails closed for process-local and persisted database quarantine", async () => {
    const store = createPluginStateKeyedStore("discord", {
      namespace: "quarantine",
      maxEntries: 10,
    });
    await store.register("k", { ok: true });
    const databasePath = resolveOpenClawStateSqlitePath(testState?.env);
    closePluginStateDatabase();

    recordOpenClawStateDatabaseOpenFailure(databasePath, new Error("latched failure"));
    await expect(store.lookup("k")).rejects.toMatchObject({
      code: "PLUGIN_STATE_OPEN_FAILED",
      path: databasePath,
      message: "Failed to open the plugin state database.",
    });
    clearOpenClawStateDatabaseOpenFailure(databasePath);

    expect(
      recordOpenClawDatabaseQuarantine({
        env: testState?.env,
        kind: "state",
        path: databasePath,
        reason: "persisted failure",
      }),
    ).toBe(true);
    try {
      for (const operation of [
        () => store.lookup("k"),
        () => store.lookupMany(["k"]),
        () => store.register("k", { ok: true }),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: "PLUGIN_STATE_OPEN_FAILED",
          path: databasePath,
          message:
            "Failed to open the plugin state database.\nDatabase integrity verification failed. Restore or repair the state database, then run openclaw doctor --fix.",
        });
      }
    } finally {
      clearOpenClawStateDatabaseOpenFailure(databasePath);
      expect(clearOpenClawDatabaseQuarantine(databasePath, { env: testState?.env })).toBe(true);
    }
  });

  it("fails closed for a newer shared-state schema", async () => {
    const store = createPluginStateKeyedStore("discord", {
      namespace: "newer-schema",
      maxEntries: 10,
    });
    await store.register("k", { ok: true });
    const databasePath = resolveOpenClawStateSqlitePath(testState?.env);
    openOpenClawStateDatabase().db.exec(
      `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`,
    );
    closePluginStateDatabase();

    try {
      for (const operation of [
        () => store.lookup("k"),
        () => store.lookupMany(["k"]),
        () => store.register("k", { ok: true }),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: "PLUGIN_STATE_OPEN_FAILED",
          path: databasePath,
          message:
            "Failed to open the plugin state database.\nThe state database uses a newer schema. Run an OpenClaw build that supports it.",
        });
      }
    } finally {
      clearOpenClawStateDatabaseOpenFailure(databasePath);
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
      } finally {
        database.close();
      }
    }
  });
});
