// Preserves read failures separately from absent or malformed plugin index state.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as stateDbReadOnly from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-state.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import {
  refreshPersistedInstalledPluginIndex,
  refreshPersistedInstalledPluginIndexWithLeaseSync,
} from "./installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
} from "./installed-plugin-index-store.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});
function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-plugin-index-read-state", tempDirs);
}

function insertPersistedIndexRow(stateDir: string, valueJson: string): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('plugins.installedIndex', ?, 123)",
      ).run(valueJson);
    },
    { env: { OPENCLAW_STATE_DIR: stateDir } },
  );
}

function readPersistedIndexRow(filePath: string): { value_json: string; updated_at_ms: number } {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
      )
      .get() as { value_json: string; updated_at_ms: number };
  } finally {
    db.close();
  }
}

describe("installed plugin index read state", () => {
  it("preserves the original read error through both full-index readers", async () => {
    const stateDir = makeTempDir();
    const error = Object.assign(new Error("plugin index read denied"), { code: "EACCES" });
    const readSpy = vi.spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly");
    for (const read of [readPersistedInstalledPluginIndexSync, readPersistedInstalledPluginIndex]) {
      readSpy.mockImplementationOnce(() => {
        throw error;
      });
      await expect
        .soft(
          Promise.resolve().then(() => read({ stateDir })),
          read.name,
        )
        .rejects.toBe(error);
    }
    readSpy.mockRestore();
  });

  it.each(["database", "table", "row"])(
    "preserves genuine missing %s without creating state",
    async (missing) => {
      const stateDir = makeTempDir();
      const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
      if (missing !== "database") {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(filePath);
        if (missing === "row") {
          db.exec(
            "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
          );
        }
        db.close();
      }
      const before = missing === "database" ? undefined : fs.readFileSync(filePath);
      expect(inspectPersistedInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual({
        status: "missing",
      });
      await expect(
        readPersistedInstalledPluginIndexInstallRecords({ stateDir }),
      ).resolves.toBeNull();
      await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
      expect(missing === "database" ? fs.existsSync(filePath) : fs.readFileSync(filePath)).toEqual(
        before ?? false,
      );
    },
  );

  it.each([
    { reason: "manual", leased: false },
    { reason: "manual", leased: true },
    { reason: "policy-changed", leased: false },
    { reason: "policy-changed", leased: true },
  ] as const)(
    "stops $reason refresh before mutation after one failed read (leased=$leased)",
    async ({ reason, leased }) => {
      const stateDir = makeTempDir();
      const installRecords = {
        authoritative: { source: "npm", spec: "authoritative@1.0.0" },
      } as const;
      const valueJson = JSON.stringify({
        revision: 123,
        index: {
          version: 1,
          hostContractVersion: "2026.4.25",
          compatRegistryVersion: "compat-v1",
          migrationVersion: 1,
          policyHash: "policy-hash",
          generatedAtMs: 123,
          installRecords,
          plugins: [],
          diagnostics: [],
        },
      });
      insertPersistedIndexRow(stateDir, valueJson);
      const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
      closeOpenClawStateDatabaseForTest();
      const error = Object.assign(new Error("plugin index read denied"), { code: "EACCES" });
      const readSpy = vi
        .spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly")
        .mockImplementationOnce(() => {
          throw error;
        });
      const lease = { assertOwnedInTransaction: vi.fn() };
      const params = {
        reason,
        stateDir,
        candidates: [],
        env: { OPENCLAW_VERSION: "2026.4.25", VITEST: "true" },
        ...(reason === "policy-changed" ? { installRecords } : {}),
      };
      const refresh = async () =>
        leased
          ? refreshPersistedInstalledPluginIndexWithLeaseSync({ ...params, lease })
          : refreshPersistedInstalledPluginIndex(params);
      await expect.soft(Promise.resolve().then(refresh)).rejects.toBe(error);
      expect.soft(lease.assertOwnedInTransaction).not.toHaveBeenCalled();
      expect
        .soft(readPersistedIndexRow(filePath))
        .toEqual({ value_json: valueJson, updated_at_ms: 123 });
      readSpy.mockRestore();
      await refresh();
      expect((await readPersistedInstalledPluginIndex({ stateDir }))?.installRecords).toEqual(
        installRecords,
      );
      const persisted = JSON.parse(readPersistedIndexRow(filePath).value_json) as {
        revision: number;
      };
      expect(persisted.revision).toBeGreaterThan(123);
    },
  );

  it.each([
    { label: "malformed JSON", valueJson: "{", recordStatus: "invalid" },
    { label: "missing records", valueJson: '{"revision":123,"index":{}}', recordStatus: "invalid" },
    {
      label: "malformed records",
      valueJson: '{"revision":123,"index":{"installRecords":{"demo":{"source":"bogus"}}}}',
      recordStatus: "invalid",
    },
    {
      label: "invalid index metadata",
      valueJson:
        '{"revision":123,"index":{"version":999,"installRecords":{"demo":{"source":"npm"}}}}',
      recordStatus: "valid",
    },
    {
      label: "missing revision",
      valueJson: '{"index":{"installRecords":{"demo":{"source":"npm"}}}}',
      recordStatus: "valid",
    },
  ] as const)(
    "keeps record parsing independent of full-index parsing: $label",
    async ({ valueJson, recordStatus }) => {
      const stateDir = makeTempDir();
      insertPersistedIndexRow(stateDir, valueJson);
      const records = recordStatus === "valid" ? { demo: { source: "npm" } } : null;
      expect(inspectPersistedInstalledPluginIndexInstallRecordsSync({ stateDir }).status).toBe(
        recordStatus,
      );
      await expect(readPersistedInstalledPluginIndexInstallRecords({ stateDir })).resolves.toEqual(
        records,
      );
      await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
    },
  );
});
