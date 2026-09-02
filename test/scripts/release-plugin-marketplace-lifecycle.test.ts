import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const HELPER = path.resolve("scripts/e2e/lib/release-plugin-marketplace/lifecycle-assertions.mjs");
const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writeIndex(
  stateDir: string,
  pluginId: string,
  record: Record<string, unknown>,
  packageVersion: string,
) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS config_machine_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    const valueJson = JSON.stringify({
      revision: now,
      index: {
        version: 1,
        hostContractVersion: "test",
        compatRegistryVersion: "test",
        migrationVersion: 1,
        policyHash: "test",
        generatedAtMs: now,
        refreshReason: "source-changed",
        installRecords: { [pluginId]: record },
        plugins: [{ pluginId, packageVersion }],
        diagnostics: [],
      },
    });
    db.prepare(
      `
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
        VALUES ('plugins.installedIndex', ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at_ms = excluded.updated_at_ms
      `,
    ).run(valueJson, now);
  } finally {
    db.close();
  }
}

function runHelper(home: string, args: string[]) {
  const stateDir = path.join(home, ".openclaw");
  return spawnSync(process.execPath, [HELPER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
  });
}

function writeMarketplaceState(home: string, version: string) {
  const pluginId = "release-marketplace-plugin";
  const stateDir = path.join(home, ".openclaw");
  const installPath = path.join(stateDir, "extensions", pluginId);
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(
    path.join(installPath, "package.json"),
    `${JSON.stringify({ name: `@openclaw/${pluginId}`, version })}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(stateDir, "openclaw.json"),
    `${JSON.stringify({
      plugins: { entries: { [pluginId]: { enabled: true } } },
    })}\n`,
    "utf8",
  );
  writeIndex(
    stateDir,
    pluginId,
    {
      source: "marketplace",
      installPath,
      version,
      marketplaceName: "Release Fixture Marketplace",
      marketplaceSource: "release-fixtures",
      marketplacePlugin: pluginId,
    },
    version,
  );
  return { installPath, pluginId };
}

function clearMarketplaceIndex(home: string) {
  const databasePath = path.join(home, ".openclaw", "state", "openclaw.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(
      `
        UPDATE config_machine_state
           SET value_json = json_set(
                 value_json,
                 '$.index.installRecords', json('{}'),
                 '$.index.plugins', json('[]')
               ),
               updated_at_ms = ?
         WHERE state_key = 'plugins.installedIndex'
      `,
    ).run(Date.now());
  } finally {
    db.close();
  }
}

describe("release plugin marketplace lifecycle assertions", () => {
  it("checks canonical marketplace metadata and stable managed install paths", () => {
    const home = makeTempDir(tempDirs, "openclaw-marketplace-lifecycle-");
    const { installPath, pluginId } = writeMarketplaceState(home, "0.0.1");
    const installPathFile = path.join(home, "install-path.txt");

    const initial = runHelper(home, [
      "assert-marketplace-state",
      pluginId,
      "0.0.1",
      "release-fixtures",
      pluginId,
      installPathFile,
    ]);
    expect(initial.stderr).toBe("");
    expect(initial.status).toBe(0);
    expect(fs.readFileSync(installPathFile, "utf8").trim()).toBe(installPath);

    writeMarketplaceState(home, "0.0.2");
    const updated = runHelper(home, [
      "assert-marketplace-state",
      pluginId,
      "0.0.2",
      "release-fixtures",
      pluginId,
      installPathFile,
    ]);
    expect(updated.stderr).toBe("");
    expect(updated.status).toBe(0);
  });

  it("rejects marketplace state with the wrong persisted version", () => {
    const home = makeTempDir(tempDirs, "openclaw-marketplace-lifecycle-");
    const { pluginId } = writeMarketplaceState(home, "0.0.1");

    const result = runHelper(home, [
      "assert-marketplace-state",
      pluginId,
      "0.0.2",
      "release-fixtures",
      pluginId,
      path.join(home, "install-path.txt"),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected install record version 0.0.2, got 0.0.1");
  });

  it("seeds uninstall state and verifies complete cleanup with sentinels preserved", () => {
    const home = makeTempDir(tempDirs, "openclaw-marketplace-lifecycle-");
    const { installPath, pluginId } = writeMarketplaceState(home, "0.0.2");
    const sentinelPluginId = "release-marketplace-other";
    const sentinelPath = path.join(home, "marketplace", sentinelPluginId);
    const installPathFile = path.join(home, "install-path.txt");
    fs.mkdirSync(sentinelPath, { recursive: true });

    const seeded = runHelper(home, [
      "seed-marketplace-uninstall-state",
      pluginId,
      sentinelPluginId,
      sentinelPath,
      installPathFile,
    ]);
    expect(seeded.stderr).toBe("");
    expect(seeded.status).toBe(0);

    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.plugins.allow).toEqual([pluginId, sentinelPluginId]);
    expect(config.plugins.deny).toEqual([pluginId, sentinelPluginId]);
    expect(config.plugins.load.paths).toEqual([installPath, sentinelPath]);

    config.plugins.entries[pluginId] = { enabled: false };
    config.plugins.allow = [sentinelPluginId];
    config.plugins.deny = [sentinelPluginId];
    config.plugins.load.paths = [sentinelPath];
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, "utf8");
    fs.rmSync(installPath, { recursive: true });
    clearMarketplaceIndex(home);

    const verified = runHelper(home, [
      "assert-marketplace-uninstalled",
      pluginId,
      sentinelPluginId,
      sentinelPath,
      installPathFile,
    ]);
    expect(verified.stderr).toBe("");
    expect(verified.status).toBe(0);
  });

  it("checks the exact dry-run and update outcome text", () => {
    const home = makeTempDir(tempDirs, "openclaw-marketplace-lifecycle-");
    const logPath = path.join(home, "update.log");
    fs.writeFileSync(logPath, "Would update release-marketplace-plugin: 0.0.1 -> 0.0.2.\n", "utf8");

    const result = runHelper(home, [
      "assert-update-log",
      logPath,
      "Would update release-marketplace-plugin: 0.0.1 -> 0.0.2.",
    ]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
