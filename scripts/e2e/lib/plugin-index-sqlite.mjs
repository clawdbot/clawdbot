// SQLite readers for plugin install indexes produced during E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readPositiveIntEnv } from "./env-limits.mjs";
import { readTextFileBounded } from "./text-file-utils.mjs";

const INDEX_KEY = "installed-plugin-index";
const ERROR_DETAIL_TAIL_BYTES = 16 * 1024;
const JSON_ARTIFACT_MAX_BYTES = readPositiveIntEnv(
  "OPENCLAW_PLUGIN_INDEX_JSON_MAX_BYTES",
  1024 * 1024,
);

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME, ".openclaw");
}

function configPath() {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir(), "openclaw.json");
}

function readJsonMaybe(file) {
  let text;
  try {
    text = readTextFileBounded(file, "plugin index JSON artifact", JSON_ARTIFACT_MAX_BYTES, {
      tailBytes: ERROR_DETAIL_TAIL_BYTES,
    });
  } catch (error) {
    if (error?.code === "ETOOBIG") {
      throw error;
    }
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function textTooLargeError(message) {
  return Object.assign(new Error(message), { code: "ETOOBIG" });
}

function parseIndexJsonText(text, label) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > JSON_ARTIFACT_MAX_BYTES) {
    throw textTooLargeError(`${label} exceeded ${JSON_ARTIFACT_MAX_BYTES} bytes (${bytes} bytes)`);
  }
  return JSON.parse(text);
}

function assertIndexJsonByteLength(bytesRaw, label) {
  const bytes = Number(bytesRaw);
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`${label} byte length was invalid: ${String(bytesRaw)}`);
  }
  if (bytes > JSON_ARTIFACT_MAX_BYTES) {
    throw textTooLargeError(`${label} exceeded ${JSON_ARTIFACT_MAX_BYTES} bytes (${bytes} bytes)`);
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
    const lengths = db
      .prepare(
        `
          SELECT octet_length(install_records_json) AS install_records_json_bytes,
                 octet_length(plugins_json) AS plugins_json_bytes,
                 octet_length(diagnostics_json) AS diagnostics_json_bytes
            FROM installed_plugin_index
           WHERE index_key = ?
        `,
      )
      .get(INDEX_KEY);
    if (!lengths) {
      return {};
    }
    assertIndexJsonByteLength(
      lengths.install_records_json_bytes,
      "plugin index install_records_json",
    );
    assertIndexJsonByteLength(lengths.plugins_json_bytes, "plugin index plugins_json");
    assertIndexJsonByteLength(lengths.diagnostics_json_bytes, "plugin index diagnostics_json");
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
      installRecords: parseIndexJsonText(
        row.install_records_json,
        "plugin index install_records_json",
      ),
      plugins: parseIndexJsonText(row.plugins_json, "plugin index plugins_json"),
      diagnostics: parseIndexJsonText(row.diagnostics_json, "plugin index diagnostics_json"),
    };
  } catch (error) {
    if (error?.code === "ETOOBIG") {
      throw error;
    }
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
