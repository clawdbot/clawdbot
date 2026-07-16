/** Canonical shared-SQLite configuration for the node-host runner. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Insertable, Selectable } from "kysely";
import { resolveStateDir } from "../config/paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

/** Gateway endpoint metadata persisted with node-host config. */
export type NodeHostGatewayConfig = {
  host?: string;
  port?: number;
  tls?: boolean;
  tlsFingerprint?: string;
  /** Gateway WebSocket context path (e.g. "/openclaw-gw"). */
  contextPath?: string;
};

export type NodeHostConfig = {
  version: 1;
  nodeId: string;
  displayName?: string;
  gateway?: NodeHostGatewayConfig;
};

export const NODE_HOST_CONFIG_KEY = "current";
export const LEGACY_NODE_HOST_CONFIG_FILE = "node.json";
export const LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX = ".doctor-importing";

type NodeHostConfigDatabase = Pick<OpenClawStateKyselyDatabase, "node_host_config">;
type NodeHostConfigRow = Selectable<NodeHostConfigDatabase["node_host_config"]>;
type NodeHostConfigRuntimeRow = Omit<NodeHostConfigRow, "token">;
type NodeHostConfigInsert = Insertable<NodeHostConfigDatabase["node_host_config"]>;

function databaseOptions(env: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return { env };
}

function resolveLegacyNodeHostConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), LEGACY_NODE_HOST_CONFIG_FILE);
}

function resolveLegacyNodeHostConfigClaimPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveLegacyNodeHostConfigPath(env)}${LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX}`;
}

function legacyPathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new Error(`unable to verify retired node-host state path ${filePath}`, {
      cause: error,
    });
  }
}

/** Runtime must not choose between canonical SQLite state and a retired file store. */
function assertNodeHostLegacyStateMigrated(env: NodeJS.ProcessEnv = process.env): void {
  const sourcePath = resolveLegacyNodeHostConfigPath(env);
  const claimPath = resolveLegacyNodeHostConfigClaimPath(env);
  if (!legacyPathMayExist(sourcePath) && !legacyPathMayExist(claimPath)) {
    return;
  }
  throw new Error(
    `retired node-host state remains at ${sourcePath}; stop the node host and run \`openclaw doctor --fix\``,
  );
}

function optionalNonEmptyString(value: string | null, label: string): string | undefined {
  if (value === null) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`invalid node-host SQLite row: ${label} must not be empty`);
  }
  return normalized;
}

function optionalInputString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function validatePort(value: number | null | undefined, label: string): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`invalid node-host ${label}: expected an integer between 1 and 65535`);
  }
  return value;
}

function rowToNodeHostConfig(row: NodeHostConfigRuntimeRow): NodeHostConfig {
  if (row.version !== 1) {
    throw new Error(`invalid node-host SQLite row: unsupported version ${String(row.version)}`);
  }
  const nodeId = row.node_id.trim();
  if (!nodeId) {
    throw new Error("invalid node-host SQLite row: node_id must not be empty");
  }
  if (!Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
    throw new Error("invalid node-host SQLite row: updated_at_ms must be a non-negative integer");
  }
  if (row.gateway_tls !== null && row.gateway_tls !== 0 && row.gateway_tls !== 1) {
    throw new Error("invalid node-host SQLite row: gateway_tls must be 0, 1, or null");
  }
  const gateway: NodeHostGatewayConfig = {
    host: optionalNonEmptyString(row.gateway_host, "gateway_host"),
    port: validatePort(row.gateway_port, "SQLite gateway_port"),
    tls: row.gateway_tls === null ? undefined : row.gateway_tls === 1,
    tlsFingerprint: optionalNonEmptyString(row.gateway_tls_fingerprint, "gateway_tls_fingerprint"),
    contextPath: optionalNonEmptyString(row.gateway_context_path, "gateway_context_path"),
  };
  const hasGateway = Object.values(gateway).some((value) => value !== undefined);
  return {
    version: 1,
    nodeId,
    displayName: optionalNonEmptyString(row.display_name, "display_name"),
    gateway: hasGateway ? gateway : undefined,
  };
}

function normalizeGatewayConfig(gateway: NodeHostGatewayConfig): NodeHostGatewayConfig | undefined {
  const normalized: NodeHostGatewayConfig = {
    host: optionalInputString(gateway.host),
    port: validatePort(gateway.port, "gateway port"),
    tls: gateway.tls,
    tlsFingerprint: optionalInputString(gateway.tlsFingerprint),
    contextPath: optionalInputString(gateway.contextPath),
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

function configToRow(params: {
  config: NodeHostConfig;
  updatedAtMs: number;
}): NodeHostConfigInsert {
  const gateway = params.config.gateway;
  return {
    config_key: NODE_HOST_CONFIG_KEY,
    version: 1,
    node_id: params.config.nodeId,
    token: null,
    display_name: params.config.displayName ?? null,
    gateway_host: gateway?.host ?? null,
    gateway_port: gateway?.port ?? null,
    gateway_tls: gateway?.tls === undefined ? null : gateway.tls ? 1 : 0,
    gateway_tls_fingerprint: gateway?.tlsFingerprint ?? null,
    gateway_context_path: gateway?.contextPath ?? null,
    updated_at_ms: params.updatedAtMs,
  };
}

function readNodeHostConfigRow(
  database: ReturnType<typeof openOpenClawStateDatabase>,
): NodeHostConfigRuntimeRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<NodeHostConfigDatabase>(database.db)
      .selectFrom("node_host_config")
      .select([
        "config_key",
        "version",
        "node_id",
        "display_name",
        "gateway_host",
        "gateway_port",
        "gateway_tls",
        "gateway_tls_fingerprint",
        "gateway_context_path",
        "updated_at_ms",
      ])
      .where("config_key", "=", NODE_HOST_CONFIG_KEY),
  );
}

/** Load canonical node-host state. Legacy files block the read until Doctor migrates them. */
export async function loadNodeHostConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeHostConfig | null> {
  assertNodeHostLegacyStateMigrated(env);
  const database = openOpenClawStateDatabase(databaseOptions(env));
  const row = readNodeHostConfigRow(database);
  return row ? rowToNodeHostConfig(row) : null;
}

/**
 * Atomically create or replace the complete node-host snapshot.
 * Candidate facts are prepared before BEGIN; the transaction rereads the authoritative row.
 */
export async function configureNodeHost(params: {
  nodeId?: string;
  displayName?: string;
  fallbackDisplayName: string;
  gateway: NodeHostGatewayConfig;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  candidateNodeId?: string;
}): Promise<NodeHostConfig> {
  const env = params.env ?? process.env;
  assertNodeHostLegacyStateMigrated(env);
  const explicitNodeId = optionalInputString(params.nodeId);
  const explicitDisplayName = optionalInputString(params.displayName);
  const fallbackDisplayName = optionalInputString(params.fallbackDisplayName);
  const candidateNodeId = params.candidateNodeId?.trim() || crypto.randomUUID();
  const gateway = normalizeGatewayConfig(params.gateway);
  const updatedAtMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
    throw new Error("invalid node-host updatedAtMs: expected a non-negative integer");
  }

  const config = runOpenClawStateWriteTransaction((database) => {
    const { db } = database;
    const existingRow = readNodeHostConfigRow(database);
    const existing = existingRow ? rowToNodeHostConfig(existingRow) : null;
    const nodeId = explicitNodeId ?? existing?.nodeId ?? candidateNodeId;
    const displayName = explicitDisplayName ?? existing?.displayName ?? fallbackDisplayName;
    const next: NodeHostConfig = {
      version: 1,
      nodeId,
      displayName,
      gateway,
    };
    const row = configToRow({ config: next, updatedAtMs });
    const { config_key: _configKey, ...updates } = row;
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<NodeHostConfigDatabase>(db)
        .insertInto("node_host_config")
        .values(row)
        .onConflict((conflict) => conflict.column("config_key").doUpdateSet(updates)),
    );
    return next;
  }, databaseOptions(env));

  // Detect a retired writer that recreated node.json while the transaction committed.
  assertNodeHostLegacyStateMigrated(env);
  return config;
}
