import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { readPersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeStateDir(): string {
  return makeTrackedTempDir("openclaw-installed-plugin-index-record-map", tempDirs);
}

function createIndex(installRecords: InstalledPluginIndex["installRecords"]): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords,
    plugins: [],
    diagnostics: [],
  };
}

function readInstallRecordRow(stateDir: string): {
  value_json: string;
  updated_at_ms: number | bigint;
} {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      db
        .prepare(
          `SELECT value_json, updated_at_ms
             FROM config_machine_state
            WHERE state_key = 'plugins.installedIndex'`,
        )
        .get() as { value_json: string; updated_at_ms: number | bigint },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

describe("installed plugin index install-record persistence", () => {
  it.each([
    { order: "records-first", validIndex: true },
    { order: "index-first", validIndex: true },
    { order: "records-first", validIndex: false },
    { order: "index-first", validIndex: false },
  ])(
    "reads one row for independent projections: $order, validIndex=$validIndex",
    async ({ order, validIndex }) => {
      const stateDir = makeStateDir();
      await withPluginLifecycleLease(
        { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
        async () => {
          expect(readPersistedInstalledPluginIndexInstallRecordsSync({ stateDir })).toBeNull();
          expect(readPersistedInstalledPluginIndexSync({ stateDir })).toBeNull();
          const records = { demo: { source: "npm" as const, spec: "demo@1.0.0" } };
          await writePersistedInstalledPluginIndex(createIndex(records), { stateDir });
          if (!validIndex) {
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                db.prepare(
                  `UPDATE config_machine_state
                  SET value_json = json_remove(value_json, '$.index.plugins')
                WHERE state_key = 'plugins.installedIndex'`,
                ).run();
              },
              { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
            );
          }
          const { StatementSync } = requireNodeSqlite();
          const iterate = vi.spyOn(StatementSync.prototype, "iterate");
          const readRecords = () =>
            expect(readPersistedInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual(
              records,
            );
          const readIndex = () => {
            const index = readPersistedInstalledPluginIndexSync({ stateDir });
            if (validIndex) {
              expect(index?.installRecords).toEqual(records);
            } else {
              expect(index).toBeNull();
            }
          };

          for (const read of order === "records-first"
            ? [readRecords, readIndex]
            : [readIndex, readRecords]) {
            read();
          }

          expect(
            iterate.mock.calls.filter((params, index) => {
              const statement = iterate.mock.contexts[index];
              return (
                statement instanceof StatementSync &&
                params.includes("plugins.installedIndex") &&
                /SELECT\s+"?value_json"?\s+FROM\s+"?config_machine_state"?\s+WHERE\s+"?state_key"?\s*=/i.test(
                  statement.sourceSQL,
                )
              );
            }),
          ).toHaveLength(1);
        },
      );
    },
  );

  it("round-trips artifact-anchored capability acceptance in the existing install-record JSON", async () => {
    const stateDir = makeStateDir();
    const acceptedSurface = {
      channels: [],
      providers: [],
      tools: ["read"],
      contracts: ["tools: read"],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    };
    const acceptedRecord = {
      source: "npm" as const,
      integrity: "sha512-artifact",
      acceptedSurface,
      acceptedSurfaceHash: "surface-hash",
      acceptedSurfaceAt: "2026-08-25T00:00:00.000Z",
      acceptedSurfaceIntegrity: "sha512-artifact",
    };

    await writePersistedInstalledPluginIndex(createIndex({ demo: acceptedRecord }), { stateDir });

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(getPluginInstallRecordMapEntry(persisted?.installRecords, "demo")).toEqual(
      acceptedRecord,
    );
    expect(JSON.parse(readInstallRecordRow(stateDir).value_json)).toMatchObject({
      index: { installRecords: { demo: acceptedRecord } },
    });
  });

  it("persists legal prototype-named plugin ids as inert own properties", async () => {
    const stateDir = makeStateDir();
    const installRecords =
      createPluginInstallRecordMap<InstalledPluginIndex["installRecords"][string]>();
    setPluginInstallRecordMapEntry(installRecords, "constructor", { source: "npm" });
    setPluginInstallRecordMapEntry(installRecords, "toString", { source: "path" });
    setPluginInstallRecordMapEntry(installRecords, "__proto__", { source: "git" });

    await writePersistedInstalledPluginIndex(createIndex(installRecords), { stateDir });

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("Expected persisted installed plugin index");
    }
    expect(Object.getPrototypeOf(persisted.installRecords)).toBeNull();
    expect(getPluginInstallRecordMapEntry(persisted.installRecords, "constructor")).toEqual({
      source: "npm",
    });
    expect(getPluginInstallRecordMapEntry(persisted.installRecords, "toString")).toEqual({
      source: "path",
    });
    expect(getPluginInstallRecordMapEntry(persisted.installRecords, "__proto__")).toEqual({
      source: "git",
    });
  });

  it.each(["constructor", "toString", "__proto__"])(
    "atomically rejects an invalid %s candidate record",
    async (pluginId) => {
      const stateDir = makeStateDir();
      await writePersistedInstalledPluginIndex(
        createIndex({ stable: { source: "npm", spec: "stable@1.0.0" } }),
        { stateDir },
      );
      const before = readInstallRecordRow(stateDir);
      const invalid = createPluginInstallRecordMap<unknown>();
      setPluginInstallRecordMapEntry(invalid, "stable", {
        source: "npm",
        spec: "stable@2.0.0",
      });
      setPluginInstallRecordMapEntry(invalid, pluginId, { source: "bogus" });

      await expect(
        writePersistedInstalledPluginIndex(
          createIndex(invalid as InstalledPluginIndex["installRecords"]),
          { stateDir },
        ),
      ).rejects.toThrow("Invalid plugin install record");

      expect(readInstallRecordRow(stateDir)).toEqual(before);
    },
  );

  it("preserves passthrough fields and serializes ids in UTF-8 byte order", async () => {
    const stateDir = makeStateDir();
    const installRecords =
      createPluginInstallRecordMap<InstalledPluginIndex["installRecords"][string]>();
    setPluginInstallRecordMapEntry(installRecords, "\u{10000}", { source: "git" });
    setPluginInstallRecordMapEntry(installRecords, "2", {
      source: "npm",
      futureMetadata: { retained: true },
    } as never);
    setPluginInstallRecordMapEntry(installRecords, "\uE000", { source: "path" });
    setPluginInstallRecordMapEntry(installRecords, "10", { source: "path" });
    setPluginInstallRecordMapEntry(installRecords, "1", { source: "archive" });

    await writePersistedInstalledPluginIndex(createIndex(installRecords), { stateDir });

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("Expected persisted installed plugin index");
    }
    expect(getPluginInstallRecordMapEntry(persisted.installRecords, "2")).toEqual({
      source: "npm",
      futureMetadata: { retained: true },
    });
    // The persisted value_json embeds the UTF-8 byte-order serialization as a
    // JSON object, so JS object semantics hoist integer-like ids numerically
    // while the remaining ids keep their byte-order position deterministically.
    expect(readInstallRecordRow(stateDir).value_json).toContain(
      '"installRecords":{"1":{"source":"archive"},"2":{"source":"npm","futureMetadata":{"retained":true}},"10":{"source":"path"},"\uE000":{"source":"path"},"\u{10000}":{"source":"git"}}',
    );
  });
});
