/** Canonical shared-SQLite configuration for the node-host runner. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../config/paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { readConfigMachineStateWithMetadata } from "../state/config-machine-state.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  normalizeNodeHostCloudflareAccessConfig,
  type NodeHostCloudflareAccessConfig,
} from "./gateway-cloudflare-access.js";

/** Gateway endpoint metadata persisted with node-host config. */
export type NodeHostGatewayConfig = {
  host?: string;
  port?: number;
  tls?: boolean;
  tlsFingerprint?: string;
  /** Gateway WebSocket context path (e.g. "/openclaw-gw"). */
  contextPath?: string;
  /** Cloudflare Access service-token inputs bound to this exact Gateway origin. */
  cloudflareAccess?: NodeHostCloudflareAccessConfig;
};

export type NodeHostConfig = {
  version: 1;
  nodeId: string;
  displayName?: string;
  gateway?: NodeHostGatewayConfig;
  /** Share installed macOS applications through device.apps (default: false). */
  installedAppsSharing?: boolean;
};

export const NODE_HOST_CONFIG_KEY = "nodeHost.config";
export const LEGACY_NODE_HOST_CONFIG_FILE = "node.json";
export const LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX = ".doctor-importing";

type NodeHostConfigDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

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

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid node-host SQLite row: ${label} must be a string`);
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

function validatePort(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`invalid node-host ${label}: expected an integer between 1 and 65535`);
  }
  return value;
}

function normalizeStoredNodeHostConfig(value: unknown): NodeHostConfig {
  if (!isRecord(value)) {
    throw new Error("invalid node-host SQLite row: expected a configuration object");
  }
  if (value.version !== 1) {
    throw new Error(`invalid node-host SQLite row: unsupported version ${String(value.version)}`);
  }
  const nodeId = typeof value.nodeId === "string" ? value.nodeId.trim() : "";
  if (!nodeId) {
    throw new Error("invalid node-host SQLite row: node_id must not be empty");
  }
  const storedGateway = value.gateway;
  if (storedGateway !== undefined && !isRecord(storedGateway)) {
    throw new Error("invalid node-host SQLite row: gateway must be an object");
  }
  const gatewayTls = storedGateway?.tls;
  if (gatewayTls !== undefined && typeof gatewayTls !== "boolean") {
    throw new Error("invalid node-host SQLite row: gateway_tls must be a boolean");
  }
  if (value.installedAppsSharing !== undefined && typeof value.installedAppsSharing !== "boolean") {
    throw new Error("invalid node-host SQLite row: installed_apps_sharing must be a boolean");
  }
  const gateway = storedGateway
    ? normalizeGatewayConfig({
        host: optionalNonEmptyString(storedGateway.host, "gateway_host"),
        port: validatePort(storedGateway.port, "SQLite gateway_port"),
        tls: typeof gatewayTls === "boolean" ? gatewayTls : undefined,
        tlsFingerprint: optionalNonEmptyString(
          storedGateway.tlsFingerprint,
          "gateway_tls_fingerprint",
        ),
        contextPath: optionalNonEmptyString(storedGateway.contextPath, "gateway_context_path"),
        ...cloudflareAccessEntry(
          normalizeNodeHostCloudflareAccessConfig(storedGateway.cloudflareAccess),
        ),
      })
    : undefined;
  return {
    version: 1,
    nodeId,
    displayName: optionalNonEmptyString(value.displayName, "display_name"),
    gateway,
    installedAppsSharing: value.installedAppsSharing === true,
  };
}

// Own-property parity with the retired column reader: an absent Cloudflare
// Access config omits the key entirely so toStrictEqual consumers match.
function cloudflareAccessEntry(cloudflareAccess: NodeHostCloudflareAccessConfig | undefined): {
  cloudflareAccess?: NodeHostCloudflareAccessConfig;
} {
  return cloudflareAccess ? { cloudflareAccess } : {};
}

function normalizeGatewayConfig(gateway: NodeHostGatewayConfig): NodeHostGatewayConfig | undefined {
  const normalized: NodeHostGatewayConfig = {
    host: optionalInputString(gateway.host),
    port: validatePort(gateway.port, "gateway port"),
    tls: gateway.tls,
    tlsFingerprint: optionalInputString(gateway.tlsFingerprint),
    contextPath: optionalInputString(gateway.contextPath),
    ...cloudflareAccessEntry(normalizeNodeHostCloudflareAccessConfig(gateway.cloudflareAccess)),
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

function readNodeHostConfig(env: NodeJS.ProcessEnv): NodeHostConfig | null {
  const stored = readConfigMachineStateWithMetadata<unknown>(
    NODE_HOST_CONFIG_KEY,
    databaseOptions(env),
  );
  if (!stored) {
    return null;
  }
  if (!Number.isSafeInteger(stored.updatedAtMs) || stored.updatedAtMs < 0) {
    throw new Error("invalid node-host SQLite row: updated_at_ms must be a non-negative integer");
  }
  return normalizeStoredNodeHostConfig(stored.value);
}

/** Load canonical node-host state. Legacy files block the read until Doctor migrates them. */
export async function loadNodeHostConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeHostConfig | null> {
  assertNodeHostLegacyStateMigrated(env);
  return readNodeHostConfig(env);
}

/** Load existing node-host state without creating or joining the writable shared-state lifecycle. */
export async function loadNodeHostConfigReadOnly(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeHostConfig | null> {
  assertNodeHostLegacyStateMigrated(env);
  return readNodeHostConfig(env);
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
  installedAppsSharing?: boolean;
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

  const config = runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<NodeHostConfigDatabase>(db);
    const stored = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("config_machine_state")
        .select("value_json")
        .where("state_key", "=", NODE_HOST_CONFIG_KEY),
    );
    const existing = stored
      ? normalizeStoredNodeHostConfig(JSON.parse(stored.value_json) as unknown)
      : undefined;
    const next: NodeHostConfig = {
      version: 1,
      nodeId: explicitNodeId ?? existing?.nodeId ?? candidateNodeId,
      displayName: explicitDisplayName ?? existing?.displayName ?? fallbackDisplayName,
      gateway,
      installedAppsSharing: params.installedAppsSharing ?? existing?.installedAppsSharing ?? false,
    };
    const valueJson = JSON.stringify(next);
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("config_machine_state")
        .values({
          state_key: NODE_HOST_CONFIG_KEY,
          value_json: valueJson,
          updated_at_ms: updatedAtMs,
        })
        .onConflict((conflict) =>
          conflict
            .column("state_key")
            .doUpdateSet({ value_json: valueJson, updated_at_ms: updatedAtMs }),
        ),
    );
    return next;
  }, databaseOptions(env));

  // Detect a retired writer that recreated node.json while the transaction committed.
  assertNodeHostLegacyStateMigrated(env);
  return config;
}
