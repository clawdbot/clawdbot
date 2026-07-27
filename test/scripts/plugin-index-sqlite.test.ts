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

function writeLegacyIndex(root: string, text: string) {
  const file = path.join(root, "plugins", "installs.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function configPath(root: string) {
  return path.join(root, "openclaw.json");
}

function writeSqliteIndex(root: string, installRecordsJson: string) {
  const dbPath = path.join(root, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE installed_plugin_index (
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
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      "{}",
      "{}",
      null,
      Date.now(),
    );
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

  it("rejects oversized SQLite install index JSON before parsing it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-index-"));
    try {
      writeSqliteIndex(root, JSON.stringify({ filler: "x".repeat(128) }));

      const { readPluginInstallIndex } = await loadPluginIndex({
        OPENCLAW_PLUGIN_INDEX_JSON_MAX_BYTES: "64",
      });

      expect(() =>
        readPluginInstallIndex({ stateDir: root, configPath: configPath(root) }),
      ).toThrow("plugin index install_records_json exceeded 64 bytes");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
