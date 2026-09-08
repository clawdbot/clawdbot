import { AsyncResource } from "node:async_hooks";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { commitPluginInstallRecordsOnly } from "./install-record-commit.js";
import {
  collectInstalledPluginIndexMutations,
  prepareInstalledPluginIndexMutation,
} from "./installed-plugin-index-mutations.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { refreshPersistedInstalledPluginIndexWithLeaseSync } from "./installed-plugin-index-store-write.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const stateKey = "plugins.installedIndex";
const priorJson = `{ "revision": 41, "index": {
  "version": 1, "hostContractVersion": "2026.4.25", "compatRegistryVersion": "compat-v1",
  "migrationVersion": 1, "policyHash": "prior", "generatedAtMs": 123,
  "installRecords": {}, "plugins": [], "diagnostics": []
} }`;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeEnv() {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: makeTrackedTempDir("openclaw-plugin-row-receipt", tempDirs),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
}

// An independent connection sees only committed rows, not the writer's projections.
function readRow(databasePath: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "SELECT state_key, value_json, updated_at_ms FROM config_machine_state WHERE state_key = ?",
        )
        .get(stateKey) ?? null
    );
  } finally {
    db.close();
  }
}

describe("installed plugin index mutation receipts", () => {
  it("collects only committed index writes and their owned compensation", async () => {
    const env = makeEnv();
    await withEnvAsync(env, () =>
      withPluginLifecycleLease({}, async (lease) => {
        const failure = new Error("source changed after index publication");
        const collected = await collectInstalledPluginIndexMutations(
          () => lease.assertOwned(),
          () =>
            commitPluginInstallRecordsOnly({
              nextInstallRecords: {},
              nextConfig: {},
              verifyConfigFresh: async () => {
                throw failure;
              },
            }),
        );
        expect(collected.outcome).toEqual({ error: failure });
        expect(collected.mutations).toHaveLength(2);
        expect(collected.mutations[0]?.before).toBeNull();
        expect(collected.mutations[0]?.after).toEqual(collected.mutations[1]?.before);
        expect(collected.mutations[1]?.after).toBeNull();
        expect(readRow(lease.databasePath)).toBeNull();
      }),
    );
  });
  it("discards mutation receipts when the actual outer SQLite transaction rolls back", async () => {
    const env = makeEnv();
    await withPluginLifecycleLease({ env }, async (lease) => {
      const failure = new Error("outer transaction rollback");
      const collected = await collectInstalledPluginIndexMutations(
        () => lease.assertOwned(),
        async () => {
          runOpenClawStateWriteTransaction(
            () => {
              refreshPersistedInstalledPluginIndexWithLeaseSync({
                reason: "source-changed",
                installRecords: {},
                candidates: [],
                env,
                lease,
              });
              throw failure;
            },
            { env },
          );
        },
      );
      expect(collected.outcome).toEqual({ error: failure });
      expect(collected.mutations).toEqual([]);
      expect(readRow(lease.databasePath)).toBeNull();
    });
  });
  it("refuses a write through an escaped mutation scope before opening another transaction", async () => {
    const env = makeEnv();
    await withPluginLifecycleLease({ env }, async (lease) => {
      let inherited: AsyncResource | undefined;
      await collectInstalledPluginIndexMutations(
        () => lease.assertOwned(),
        async () => {
          inherited = new AsyncResource("closed-plugin-mutation");
        },
      );
      try {
        expect(() =>
          inherited!.runInAsyncScope(() =>
            refreshPersistedInstalledPluginIndexWithLeaseSync({
              reason: "source-changed",
              installRecords: {},
              candidates: [],
              env,
              lease,
            }),
          ),
        ).toThrow(/ownership has closed/);
        expect(readRow(lease.databasePath)).toBeNull();
      } finally {
        inherited?.emitDestroy();
      }
    });
  });

  it("rolls back a transaction submitted through an already closed receipt callback", async () => {
    const env = makeEnv();
    await withPluginLifecycleLease({ env }, async (lease) => {
      let publish: ReturnType<typeof prepareInstalledPluginIndexMutation>;
      const collected = await collectInstalledPluginIndexMutations(
        () => lease.assertOwned(),
        async () => {
          publish = prepareInstalledPluginIndexMutation();
        },
      );
      expect(() =>
        runOpenClawStateWriteTransaction(
          ({ db, path: databasePath }) => {
            db.prepare(
              "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
            ).run(stateKey, priorJson, 9007);
            publish!(db, {
              databasePath,
              before: null,
              after: {
                state_key: stateKey,
                value_json: priorJson,
                updated_at_ms: 9007,
              },
            });
          },
          { env },
        ),
      ).toThrow(/ownership has closed/);
      expect(readRow(lease.databasePath)).toBeNull();
      expect(collected.mutations).toEqual([]);
    });
  });

  it.each([null, priorJson, "true"])(
    "retains exact predecessor and committed row for %s",
    async (valueJson) => {
      const env = makeEnv();
      const otherEnv = makeEnv();
      await withPluginLifecycleLease({ env }, async (lease) => {
        if (valueJson !== null) {
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              db.prepare(
                "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
              ).run(stateKey, valueJson, 9_007);
            },
            { path: lease.databasePath, env },
          );
        }
        const before = readRow(lease.databasePath);
        const receipt = await writePersistedInstalledPluginIndexInstallRecordsWithLease(
          {},
          {
            env: otherEnv,
            filePath: lease.databasePath,
            candidates: [],
            lease,
          },
        );
        const after = readRow(lease.databasePath);
        expect(receipt.mutation).toEqual({ databasePath: lease.databasePath, before, after });
        expect(receipt.mutation.before).toEqual(
          valueJson === null
            ? null
            : {
                state_key: stateKey,
                value_json: valueJson,
                updated_at_ms: 9_007,
              },
        );
        expect(receipt.mutation.after.updated_at_ms).toBe(receipt.revision);
        expect(JSON.parse(receipt.mutation.after.value_json).revision).toBe(receipt.revision);
        expect(receipt.previous?.policyHash ?? null).toBe(valueJson === priorJson ? "prior" : null);
        expect(lease.databasePath).toBe(
          path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
        );
        const captured = JSON.stringify(receipt.mutation);
        await writePersistedInstalledPluginIndexInstallRecordsWithLease(
          {},
          {
            env,
            filePath: lease.databasePath,
            candidates: [],
            lease,
          },
        );
        expect(readRow(lease.databasePath)).not.toEqual(after);
        expect(JSON.stringify(receipt.mutation)).toBe(captured);
      });
    },
  );

  it.each([false, true])(
    "returns the row receipt only after caller settlement (fail=%s)",
    async (fail) => {
      const env = makeEnv();
      await withEnvAsync(env, async () => {
        await withPluginLifecycleLease({}, async (lease) => {
          let after;
          const pending = commitPluginInstallRecordsOnly({
            nextInstallRecords: {},
            nextConfig: {},
            verifyConfigFresh: async () => {
              after = readRow(lease.databasePath);
              expect(after).not.toBeNull();
              if (fail) {
                throw new Error("config no longer current");
              }
            },
          });
          if (fail) {
            await expect(pending).rejects.toThrow("config no longer current");
            expect(readRow(lease.databasePath)).toBeNull();
          } else {
            const receipt = await pending;
            expect(receipt?.mutation).toEqual({
              databasePath: lease.databasePath,
              before: null,
              after,
            });
          }
        });
      });
    },
  );

  it("rejects a failed SQLite commit without returning a receipt or publishing its row", async () => {
    const env = makeEnv();
    await withPluginLifecycleLease({ env }, async (lease) => {
      let receipt;
      try {
        await expect(
          (async () => {
            receipt = await writePersistedInstalledPluginIndexInstallRecordsWithLease(
              {},
              {
                env,
                filePath: lease.databasePath,
                candidates: [],
                lease: {
                  assertOwnedInTransaction(db) {
                    lease.assertOwnedInTransaction(db);
                    // A deferred constraint fails at COMMIT, after the index write and receipt capture.
                    db.exec(`CREATE TEMP TABLE receipt_parent (id INTEGER PRIMARY KEY);
                  CREATE TEMP TABLE receipt_child (
                    parent_id INTEGER REFERENCES receipt_parent(id) DEFERRABLE INITIALLY DEFERRED
                  );
                  CREATE TEMP TRIGGER receipt_commit_failure AFTER INSERT ON main.config_machine_state
                    WHEN NEW.state_key = 'plugins.installedIndex'
                    BEGIN INSERT INTO receipt_child VALUES (1); END;`);
                  },
                },
              },
            );
          })(),
        ).rejects.toThrow(/FOREIGN KEY constraint failed/);
        expect(receipt).toBeUndefined();
        expect(readRow(lease.databasePath)).toBeNull();
      } finally {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.exec(`DROP TRIGGER IF EXISTS temp.receipt_commit_failure;
            DROP TABLE IF EXISTS temp.receipt_child;
            DROP TABLE IF EXISTS temp.receipt_parent;`);
          },
          { path: lease.databasePath, env },
        );
      }
    });
  });
});
