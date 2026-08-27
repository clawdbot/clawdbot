import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
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
