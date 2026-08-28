// Doctor-only import for the retired node-host JSON config.
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX,
  LEGACY_NODE_HOST_CONFIG_FILE,
  NODE_HOST_CONFIG_KEY,
  type NodeHostConfig,
  type NodeHostGatewayConfig,
} from "../node-host/config.js";
import { normalizeNodeHostCloudflareAccessConfig } from "../node-host/gateway-cloudflare-access.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import {
  LegacyMigrationSourceClaim,
  legacyMigrationSourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch as sourceSnapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  type LegacyMigrationSourceSnapshot as LegacySourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_NODE_HOST_MAX_BYTES = 64 * 1024;
const CONFIG_KEYS = new Set(["version", "nodeId", "token", "displayName", "gateway"]);
const GATEWAY_KEYS = new Set(["host", "port", "tls", "tlsFingerprint", "contextPath"]);

type NodeHostConfigDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

type CanonicalNodeHostState = {
  config: NodeHostConfig;
  updatedAtMs: number;
};

/** Detect retired node-host state only when an explicit Doctor flow opts in. */
export function detectLegacyNodeHostConfig(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["nodeHost"] {
  const sourcePath = path.join(params.stateDir, LEGACY_NODE_HOST_CONFIG_FILE);
  return {
    sourcePath,
    hasLegacy:
      params.doctorOnlyStateMigrations === true &&
      legacyMigrationSourceOrClaimMayExist(sourcePath, LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX),
  };
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`${label} has unexpected field ${unexpected}`);
  }
}

function optionalLegacyString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalLegacyContextPath(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("legacy node-host gateway contextPath must be a string");
  }
  return value.trim() || undefined;
}

function parseLegacyGateway(value: unknown): NodeHostGatewayConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("legacy node-host gateway must be an object");
  }
  assertOnlyKeys(value, GATEWAY_KEYS, "legacy node-host gateway");
  const port = value.port;
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isSafeInteger(port) || port <= 0 || port > 65_535)
  ) {
    throw new Error("legacy node-host gateway port is invalid");
  }
  if (value.tls !== undefined && typeof value.tls !== "boolean") {
    throw new Error("legacy node-host gateway tls must be a boolean");
  }
  const gateway: NodeHostGatewayConfig = {
    host: optionalLegacyString(value.host, "legacy node-host gateway host"),
    port: port as number | undefined,
    tls: value.tls as boolean | undefined,
    tlsFingerprint: optionalLegacyString(
      value.tlsFingerprint,
      "legacy node-host gateway tlsFingerprint",
    ),
    // The retired runner persisted an empty string when operators cleared this option.
    contextPath: optionalLegacyContextPath(value.contextPath),
  };
  return Object.values(gateway).some((entry) => entry !== undefined) ? gateway : undefined;
}

function parseLegacyNodeHostConfig(snapshot: LegacySourceSnapshot): CanonicalNodeHostState {
  const parsed = JSON.parse(snapshot.raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("legacy node-host config must be an object");
  }
  assertOnlyKeys(parsed, CONFIG_KEYS, "legacy node-host config");
  if (parsed.version !== 1) {
    throw new Error("legacy node-host config version must be 1");
  }
  if (typeof parsed.nodeId !== "string" || !parsed.nodeId.trim()) {
    throw new Error("legacy node-host nodeId must be a non-empty string");
  }
  if (parsed.token !== undefined && typeof parsed.token !== "string") {
    throw new Error("legacy node-host token must be a string when present");
  }
  return {
    config: {
      version: 1,
      nodeId: parsed.nodeId.trim(),
      displayName: optionalLegacyString(parsed.displayName, "legacy node-host displayName"),
      gateway: parseLegacyGateway(parsed.gateway),
    },
    updatedAtMs: Math.max(0, Math.floor(snapshot.mtimeMs)),
  };
}

function nullableNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`invalid node-host SQLite row: ${label} must not be empty`);
  }
  return value.trim();
}

function rowToCanonicalState(row: {
  value_json: string;
  updated_at_ms: number;
}): CanonicalNodeHostState {
  const value = JSON.parse(row.value_json) as unknown;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.nodeId !== "string" ||
    !value.nodeId.trim()
  ) {
    throw new Error("invalid canonical node-host SQLite identity");
  }
  if (!Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
    throw new Error("invalid canonical node-host SQLite timestamp");
  }
  const storedGateway = value.gateway;
  if (storedGateway !== undefined && !isRecord(storedGateway)) {
    throw new Error("invalid canonical node-host SQLite gateway");
  }
  const gatewayPort = storedGateway?.port;
  if (
    gatewayPort !== undefined &&
    (typeof gatewayPort !== "number" ||
      !Number.isSafeInteger(gatewayPort) ||
      gatewayPort <= 0 ||
      gatewayPort > 65_535)
  ) {
    throw new Error("invalid canonical node-host SQLite gateway port");
  }
  const gatewayTls = storedGateway?.tls;
  if (gatewayTls !== undefined && typeof gatewayTls !== "boolean") {
    throw new Error("invalid canonical node-host SQLite gateway tls");
  }
  if (value.installedAppsSharing !== undefined && typeof value.installedAppsSharing !== "boolean") {
    throw new Error("invalid canonical node-host SQLite installed-app sharing");
  }
  const cloudflareAccess = normalizeNodeHostCloudflareAccessConfig(storedGateway?.cloudflareAccess);
  const gateway: NodeHostGatewayConfig = {
    host: nullableNonEmptyString(storedGateway?.host, "gateway_host"),
    port: typeof gatewayPort === "number" ? gatewayPort : undefined,
    tls: typeof gatewayTls === "boolean" ? gatewayTls : undefined,
    tlsFingerprint: nullableNonEmptyString(
      storedGateway?.tlsFingerprint,
      "gateway_tls_fingerprint",
    ),
    contextPath: nullableNonEmptyString(storedGateway?.contextPath, "gateway_context_path"),
    ...(cloudflareAccess ? { cloudflareAccess } : {}),
  };
  return {
    config: {
      version: 1,
      nodeId: value.nodeId.trim(),
      displayName: nullableNonEmptyString(value.displayName, "display_name"),
      gateway: Object.values(gateway).some((entry) => entry !== undefined) ? gateway : undefined,
      installedAppsSharing: value.installedAppsSharing === true,
    },
    updatedAtMs: row.updated_at_ms,
  };
}

function configsEqual(left: NodeHostConfig, right: NodeHostConfig): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.displayName === right.displayName &&
    left.gateway?.host === right.gateway?.host &&
    left.gateway?.port === right.gateway?.port &&
    left.gateway?.tls === right.gateway?.tls &&
    left.gateway?.tlsFingerprint === right.gateway?.tlsFingerprint &&
    left.gateway?.contextPath === right.gateway?.contextPath &&
    JSON.stringify(left.gateway?.cloudflareAccess) ===
      JSON.stringify(right.gateway?.cloudflareAccess)
  );
}

function writeCanonicalState(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  state: CanonicalNodeHostState,
): void {
  const row = {
    state_key: NODE_HOST_CONFIG_KEY,
    value_json: JSON.stringify({
      ...state.config,
      installedAppsSharing: state.config.installedAppsSharing ?? false,
    }),
    updated_at_ms: state.updatedAtMs,
  };
  const { state_key: _stateKey, ...updates } = row;
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<NodeHostConfigDatabase>(db)
      .insertInto("config_machine_state")
      .values(row)
      .onConflict((conflict) => conflict.column("state_key").doUpdateSet(updates)),
  );
}

function migrateIntoDatabase(params: { env: NodeJS.ProcessEnv; legacy: CanonicalNodeHostState }): {
  imported: boolean;
  preservedCanonical: boolean;
} {
  let imported = false;
  let preservedCanonical = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<NodeHostConfigDatabase>(db);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("config_machine_state")
          .selectAll()
          .where("state_key", "=", NODE_HOST_CONFIG_KEY),
      );
      const existing = row ? rowToCanonicalState(row) : null;
      if (existing && existing.config.nodeId !== params.legacy.config.nodeId) {
        throw new Error("legacy node-host nodeId conflicts with canonical SQLite identity");
      }

      let expected = params.legacy;
      if (existing) {
        if (configsEqual(existing.config, params.legacy.config)) {
          expected = existing.updatedAtMs >= params.legacy.updatedAtMs ? existing : params.legacy;
        } else if (existing.updatedAtMs === params.legacy.updatedAtMs) {
          throw new Error("legacy node-host config diverges at the same timestamp");
        } else if (existing.updatedAtMs > params.legacy.updatedAtMs) {
          expected = existing;
          preservedCanonical = true;
        }
      }
      if (
        !existing ||
        !configsEqual(existing.config, expected.config) ||
        existing.updatedAtMs !== expected.updatedAtMs
      ) {
        if (expected === params.legacy && existing?.config.installedAppsSharing) {
          expected = {
            ...expected,
            config: { ...expected.config, installedAppsSharing: true },
          };
        }
        writeCanonicalState(db, expected);
        imported = expected.updatedAtMs === params.legacy.updatedAtMs;
      }

      const verifiedRow = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("config_machine_state")
          .selectAll()
          .where("state_key", "=", NODE_HOST_CONFIG_KEY),
      );
      if (!verifiedRow) {
        throw new Error("SQLite verification failed for node-host config");
      }
      const verified = rowToCanonicalState(verifiedRow);
      if (
        !configsEqual(verified.config, expected.config) ||
        verified.updatedAtMs !== expected.updatedAtMs
      ) {
        throw new Error("SQLite verification failed for node-host config");
      }
    },
    { env: params.env },
  );
  return { imported, preservedCanonical };
}

async function migrateWithExclusiveStateOwnership(params: {
  stateRoot: Root;
  detected: LegacyStateDetection["nodeHost"];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const sourcePath = params.detected.sourcePath;
  const source = new LegacyMigrationSourceClaim({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath,
    label: "node-host",
    claimSuffix: LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX,
    readSnapshot: (snapshotPath) =>
      readLegacyMigrationSourceSnapshot({
        stateRoot: params.stateRoot,
        stateDir: params.stateDir,
        sourcePath: snapshotPath,
        maxBytes: LEGACY_NODE_HOST_MAX_BYTES,
        label: "node-host",
        hashDecodedText: true,
      }),
  });

  let snapshot: LegacySourceSnapshot;
  let legacy: CanonicalNodeHostState;
  try {
    await source.recover("interrupted node-host Doctor claim conflicts with its source");
    if (!(await source.exists())) {
      return { changes, warnings };
    }
    snapshot = await source.read();
    legacy = parseLegacyNodeHostConfig(snapshot);
    params.beforeVerify?.();
    if (!sourceSnapshotsMatch(await source.read(), snapshot)) {
      throw new Error("legacy node-host source changed after Doctor loaded it");
    }
  } catch (error) {
    warnings.push(`Failed reading legacy node-host state: ${String(error)}`);
    return { changes, warnings };
  }

  try {
    await source.claim({
      snapshot,
      mismatchMessage: "legacy node-host source changed before Doctor could claim it",
      beforeClaim: params.beforeClaim,
    });
  } catch (error) {
    const restoreError = await source.restore();
    warnings.push(
      `Failed migrating legacy node-host state: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  let result: ReturnType<typeof migrateIntoDatabase>;
  try {
    result = migrateIntoDatabase({ env: params.env, legacy });
  } catch (error) {
    const restoreError = await source.restore();
    warnings.push(
      `Failed migrating legacy node-host state: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  try {
    await source.remove({
      removeSource: params.removeSource,
      sourceReappearedMessage: `legacy node-host source reappeared during import: ${sourcePath}`,
      remainingMessage: "legacy node-host source or Doctor claim remains after cleanup",
    });
  } catch (error) {
    warnings.push(`Node-host state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  changes.push(
    result.preservedCanonical
      ? "Kept newer canonical node-host SQLite state."
      : result.imported
        ? "Migrated node-host config to shared SQLite state."
        : "Verified node-host config in shared SQLite state.",
  );
  notices.push("Removed retired node.json after verified SQLite import.");
  return { changes, warnings, notices };
}

/** Import retired node-host state while excluding active Gateway/state maintenance owners. */
export async function migrateLegacyNodeHostConfig(params: {
  detected: LegacyStateDetection["nodeHost"];
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy node-host state",
    releaseLabel: "Node-host",
    errorLabel: "Failed reading legacy node-host state",
    retryGuidance: "Stop the Gateway and node host, then run `openclaw doctor --fix` again.",
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: LEGACY_NODE_HOST_MAX_BYTES,
        symlinks: "reject",
      });
      return await migrateWithExclusiveStateOwnership({
        ...params,
        env,
        stateRoot,
      });
    },
  });
}
