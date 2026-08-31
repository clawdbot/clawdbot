import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  clearOpenClawStateDatabaseOpenFailure,
  openOpenClawStateDatabase,
  recordOpenClawStateDatabaseOpenFailure,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  closePluginStateDatabase,
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";

let testState: OpenClawTestState | undefined;
beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-open-errors" });
});
beforeEach(() => testState?.applyEnv());
afterEach(() => resetPluginStateStoreForTests());
afterAll(async () => testState?.cleanup());

describe("plugin state open errors", () => {
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
      for (const operation of [() => store.lookup("k"), () => store.register("k", { ok: true })]) {
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
      for (const operation of [() => store.lookup("k"), () => store.register("k", { ok: true })]) {
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
