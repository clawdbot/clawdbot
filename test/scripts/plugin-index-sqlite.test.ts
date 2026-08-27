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
      CREATE TABLE config_machine_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    ).run(
      "plugins.installedIndex",
      JSON.stringify({
        revision: Date.now(),
        index: {
          version: 1,
          hostContractVersion: "1",
          compatRegistryVersion: "1",
          migrationVersion: 1,
          policyHash: "hash",
          generatedAtMs: Date.now(),
          installRecords: JSON.parse(installRecordsJson) as unknown,
          plugins: [],
          diagnostics: [],
        },
      }),
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
      ).toThrow("plugin index value_json exceeded 64 bytes");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
