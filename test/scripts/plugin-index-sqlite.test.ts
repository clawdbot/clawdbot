// Plugin Index SQLite tests cover shared E2E install-index readers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../src/test-utils/env.js";

const MODULE_URL = pathToFileURL(path.resolve("scripts/e2e/lib/plugin-index-sqlite.mjs")).href;
let importCounter = 0;

async function loadPluginIndex(env: Record<string, string> = {}) {
  return await withEnvAsync(env, async () => {
    return await import(`${MODULE_URL}?case=${importCounter++}`);
  });
}

function sqlitePath(root: string) {
  return path.join(root, "state", "openclaw.sqlite");
}

function openSqlite(root: string) {
  const dbPath = sqlitePath(root);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  return new DatabaseSync(dbPath);
}

function writeLegacyIndex(root: string, text: string) {
  const file = path.join(root, "plugins", "installs.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function configPath(root: string) {
  return path.join(root, "openclaw.json");
}

function currentValueJson(installRecords: unknown) {
  return JSON.stringify({
    revision: Date.now(),
    index: {
      version: 1,
      hostContractVersion: "1",
      compatRegistryVersion: "1",
      migrationVersion: 1,
      policyHash: "hash",
      generatedAtMs: Date.now(),
      installRecords,
      plugins: [],
      diagnostics: [],
    },
  });
}

function writeCurrentSqliteIndex(root: string, valueJson: string, schemaVersion = 13) {
  const db = openSqlite(root);
  try {
    db.exec(`
      PRAGMA user_version = ${schemaVersion};
      CREATE TABLE IF NOT EXISTS config_machine_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json
      `,
    ).run("plugins.installedIndex", valueJson, Date.now());
  } finally {
    db.close();
  }
}

function writePreV13SqliteIndex(root: string, installRecordsJson: string, schemaVersion = 12) {
  const db = openSqlite(root);
  try {
    db.exec(`
      PRAGMA user_version = ${schemaVersion};
      CREATE TABLE IF NOT EXISTS installed_plugin_index (
        index_key TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL,
        host_contract_version TEXT NOT NULL,
        compat_registry_version TEXT NOT NULL,
        migration_version INTEGER NOT NULL,
        policy_hash TEXT NOT NULL,
        generated_at_ms INTEGER NOT NULL,
        refresh_reason TEXT,
        install_records_json TEXT NOT NULL,
        plugins_json TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        warning TEXT,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO installed_plugin_index (
          index_key, version, host_contract_version, compat_registry_version,
          migration_version, policy_hash, generated_at_ms, refresh_reason,
          install_records_json, plugins_json, diagnostics_json, warning, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(index_key) DO UPDATE SET
          install_records_json = excluded.install_records_json
      `,
    ).run(
      "installed-plugin-index",
      1,
      "1",
      "1",
      1,
      "hash",
      Date.now(),
      null,
      installRecordsJson,
      "[]",
      "[]",
      null,
      Date.now(),
    );
  } finally {
    db.close();
  }
}

function readTableNames(root: string) {
  const db = new DatabaseSync(sqlitePath(root), { readOnly: true });
  try {
    return (
      db
        .prepare(
          `
            SELECT name
              FROM sqlite_master
             WHERE type = 'table'
             ORDER BY name
          `,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

describe("plugin index SQLite E2E helpers", () => {
  it("reads legacy install records when SQLite index state is absent", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      writeLegacyIndex(
        root,
        JSON.stringify({ records: { demo: { installPath: "/tmp/demo", source: "npm" } } }),
      );

      const { readPluginInstallRecords } = await loadPluginIndex();

      expect(readPluginInstallRecords({ stateDir: root, configPath: configPath(root) })).toEqual({
        demo: { installPath: "/tmp/demo", source: "npm" },
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps malformed legacy install JSON as an empty fallback", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      writeLegacyIndex(root, "{not-json");

      const { readPluginInstallRecords } = await loadPluginIndex();

      expect(readPluginInstallRecords({ stateDir: root, configPath: configPath(root) })).toEqual(
        {},
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects oversized legacy install JSON before parsing it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      writeLegacyIndex(root, JSON.stringify({ records: {}, filler: "x".repeat(128) }));

      const { readPluginInstallRecords } = await loadPluginIndex({
        OPENCLAW_PLUGIN_INDEX_JSON_MAX_BYTES: "64",
      });

      expect(() =>
        readPluginInstallRecords({ stateDir: root, configPath: configPath(root) }),
      ).toThrow("plugin index JSON artifact exceeded 64 bytes");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reads the current index for schema v13", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      writeCurrentSqliteIndex(root, currentValueJson({ current: { source: "npm" } }));

      const { readPluginInstallRecords } = await loadPluginIndex();

      expect(readPluginInstallRecords({ stateDir: root, configPath: configPath(root) })).toEqual({
        current: { source: "npm" },
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reads the retired index for pre-v13 schemas", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      writePreV13SqliteIndex(root, JSON.stringify({ legacy: { source: "npm" } }));

      const { readPluginInstallIndex } = await loadPluginIndex();

      expect(
        readPluginInstallIndex({ stateDir: root, configPath: configPath(root) }),
      ).toMatchObject({
        installRecords: { legacy: { source: "npm" } },
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("prefers current state for unversioned databases", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      writePreV13SqliteIndex(root, JSON.stringify({ stale: { source: "npm" } }), 0);
      writeCurrentSqliteIndex(root, currentValueJson({ current: { source: "npm" } }), 0);

      const { readPluginInstallRecords } = await loadPluginIndex();

      expect(readPluginInstallRecords({ stateDir: root, configPath: configPath(root) })).toEqual({
        current: { source: "npm" },
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not fall back to a retired row for schema v13", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      writePreV13SqliteIndex(root, JSON.stringify({ stale: { source: "npm" } }), 13);

      const { readPluginInstallRecords } = await loadPluginIndex();

      expect(readPluginInstallRecords({ stateDir: root, configPath: configPath(root) })).toEqual(
        {},
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not read current state for pre-v13 schemas", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      writeCurrentSqliteIndex(root, currentValueJson({ future: { source: "npm" } }), 12);

      const { readPluginInstallRecords } = await loadPluginIndex();

      expect(readPluginInstallRecords({ stateDir: root, configPath: configPath(root) })).toEqual(
        {},
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    {
      name: "current",
      write: (root: string) => writeCurrentSqliteIndex(root, "{not-json"),
    },
    {
      name: "pre-v13",
      write: (root: string) => writePreV13SqliteIndex(root, "{not-json"),
    },
  ])("keeps malformed $name SQLite state as an empty fallback", async ({ write }) => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      write(root);

      const { readPluginInstallRecords } = await loadPluginIndex();

      expect(readPluginInstallRecords({ stateDir: root, configPath: configPath(root) })).toEqual(
        {},
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    {
      name: "current",
      expected: "plugin index value_json exceeded 64 bytes",
      write: (root: string) =>
        writeCurrentSqliteIndex(root, currentValueJson({ filler: "x".repeat(128) })),
    },
    {
      name: "pre-v13",
      expected: "plugin index install_records_json exceeded 64 bytes",
      write: (root: string) =>
        writePreV13SqliteIndex(root, JSON.stringify({ filler: "x".repeat(128) })),
    },
  ])("rejects oversized $name SQLite state before parsing it", async ({ expected, write }) => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      write(root);

      const { readPluginInstallIndex } = await loadPluginIndex({
        OPENCLAW_PLUGIN_INDEX_JSON_MAX_BYTES: "64",
      });

      expect(() =>
        readPluginInstallIndex({ stateDir: root, configPath: configPath(root) }),
      ).toThrow(expected);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    {
      mode: "current",
      schemaVersion: 0,
      options: {},
      expectedTable: "config_machine_state",
      absentTable: "installed_plugin_index",
    },
    {
      mode: "pre-v13",
      schemaVersion: 0,
      options: { storageMode: "pre-v13" },
      expectedTable: "installed_plugin_index",
      absentTable: "config_machine_state",
    },
    ...[0, 12, 13].map((schemaVersion) => ({
      mode: `existing schema v${schemaVersion}`,
      schemaVersion,
      options: { storageMode: "existing-schema" },
      expectedTable: schemaVersion >= 13 ? "config_machine_state" : "installed_plugin_index",
      absentTable: schemaVersion >= 13 ? "installed_plugin_index" : "config_machine_state",
    })),
  ])(
    "writes only the $mode storage contract",
    async ({ absentTable, expectedTable, options, schemaVersion }) => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
      try {
        const db = openSqlite(root);
        db.exec(`PRAGMA user_version = ${schemaVersion}`);
        db.close();
        const { readPluginInstallRecords, writePluginInstallIndexForE2E } = await loadPluginIndex();

        writePluginInstallIndexForE2E(
          { installRecords: { demo: { source: "npm" } } },
          { stateDir: root, ...options },
        );

        expect(readTableNames(root)).toContain(expectedTable);
        expect(readTableNames(root)).not.toContain(absentTable);
        expect(readPluginInstallRecords({ stateDir: root })).toEqual({ demo: { source: "npm" } });
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("rejects unknown writer storage modes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      const { writePluginInstallIndexForE2E } = await loadPluginIndex();

      expect(() =>
        writePluginInstallIndexForE2E(
          { installRecords: {} },
          { stateDir: root, storageMode: "future" },
        ),
      ).toThrow("Unknown plugin index storage mode: future");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
