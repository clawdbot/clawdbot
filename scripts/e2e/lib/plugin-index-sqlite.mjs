// SQLite readers for plugin install indexes produced during E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const INDEX_KEY = "installed-plugin-index";

export function stateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME, ".openclaw");
}

export function configPath() {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir(), "openclaw.json");
}

function readJsonMaybe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function sqlitePath(root = stateDir()) {
  return path.join(root, "state", "openclaw.sqlite");
}

function legacyIndexPath(root = stateDir()) {
  return path.join(root, "plugins", "installs.json");
}

function readSqlitePluginIndex(root = stateDir()) {
  const dbPath = sqlitePath(root);
  if (!fs.existsSync(dbPath)) {
    return {};
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `
          SELECT version, warning, host_contract_version, compat_registry_version,
                 migration_version, policy_hash, generated_at_ms, refresh_reason,
                 install_records_json, plugins_json, diagnostics_json
            FROM installed_plugin_index
           WHERE index_key = ?
        `,
      )
      .get(INDEX_KEY);
    if (!row) {
      return {};
    }
    return {
      version: Number(row.version),
      ...(row.warning ? { warning: row.warning } : {}),
      hostContractVersion: row.host_contract_version,
      compatRegistryVersion: row.compat_registry_version,
      migrationVersion: Number(row.migration_version),
      policyHash: row.policy_hash,
      generatedAtMs: Number(row.generated_at_ms),
      ...(row.refresh_reason ? { refreshReason: row.refresh_reason } : {}),
      installRecords: JSON.parse(row.install_records_json),
      plugins: JSON.parse(row.plugins_json),
      diagnostics: JSON.parse(row.diagnostics_json),
    };
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

export function readPluginInstallIndex(options = {}) {
  const root = options.stateDir ?? stateDir();
  const config = readJsonMaybe(options.configPath ?? configPath());
  const sqliteIndex = readSqlitePluginIndex(root);
  if (sqliteIndex.installRecords) {
    return sqliteIndex;
  }
  const legacyIndex = readJsonMaybe(legacyIndexPath(root));
  const installRecords =
    legacyIndex.installRecords ??
    legacyIndex.records ??
    options.fallbackRecords ??
    config.plugins?.installs ??
    {};
  return {
    ...legacyIndex,
    installRecords,
  };
}

export function readPluginInstallRecords(options = {}) {
  return readPluginInstallIndex(options).installRecords ?? {};
}

export function writePluginInstallIndexForE2E(index, options = {}) {
  const root = options.stateDir ?? stateDir();
  const dbPath = sqlitePath(root);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
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
    const now = Date.now();
    db.prepare(
      `
        INSERT INTO installed_plugin_index (
          index_key, version, host_contract_version, compat_registry_version,
          migration_version, policy_hash, generated_at_ms, refresh_reason,
          install_records_json, plugins_json, diagnostics_json, warning, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(index_key) DO UPDATE SET
          version = excluded.version,
          host_contract_version = excluded.host_contract_version,
          compat_registry_version = excluded.compat_registry_version,
          migration_version = excluded.migration_version,
          policy_hash = excluded.policy_hash,
          generated_at_ms = excluded.generated_at_ms,
          refresh_reason = excluded.refresh_reason,
          install_records_json = excluded.install_records_json,
          plugins_json = excluded.plugins_json,
          diagnostics_json = excluded.diagnostics_json,
          warning = excluded.warning,
          updated_at_ms = excluded.updated_at_ms
      `,
    ).run(
      INDEX_KEY,
      index.version ?? 1,
      index.hostContractVersion ?? "docker-e2e",
      index.compatRegistryVersion ?? "docker-e2e",
      index.migrationVersion ?? 1,
      index.policyHash ?? "docker-e2e",
      index.generatedAtMs ?? now,
      index.refreshReason ?? null,
      JSON.stringify(index.installRecords ?? {}),
      JSON.stringify(index.plugins ?? []),
      JSON.stringify(index.diagnostics ?? []),
      index.warning ?? "DO NOT EDIT. This row is generated by OpenClaw plugin registry commands.",
      now,
    );
  } finally {
    db.close();
  }
}
