// Doctor-only import for the retired node-host JSON config.
import { createHash } from "node:crypto";
import fs from "node:fs";
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
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { formatErrorMessage } from "./errors.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_NODE_HOST_MAX_BYTES = 64 * 1024;
const MIGRATION_LOCK_TIMEOUT_MS = 250;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 25;
const CONFIG_KEYS = new Set(["version", "nodeId", "token", "displayName", "gateway"]);
const GATEWAY_KEYS = new Set(["host", "port", "tls", "tlsFingerprint", "contextPath"]);

type NodeHostConfigDatabase = Pick<OpenClawStateKyselyDatabase, "node_host_config">;

type LegacySourceSnapshot = {
  sourcePath: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  raw: string;
  sha256: string;
  size: number;
};

type CanonicalNodeHostState = {
  config: NodeHostConfig;
  updatedAtMs: number;
};

function legacyPathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function sourceOrClaimMayExist(sourcePath: string): boolean {
  return (
    legacyPathMayExist(sourcePath) ||
    legacyPathMayExist(`${sourcePath}${LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX}`)
  );
}

/** Detect retired node-host state only when an explicit Doctor flow opts in. */
export function detectLegacyNodeHostConfig(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["nodeHost"] {
  const sourcePath = path.join(params.stateDir, LEGACY_NODE_HOST_CONFIG_FILE);
  return {
    sourcePath,
    hasLegacy: params.doctorOnlyStateMigrations === true && sourceOrClaimMayExist(sourcePath),
  };
}

function relativeLegacyPath(stateDir: string, filePath: string): string {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(filePath));
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`legacy node-host path is outside the state directory: ${filePath}`);
  }
  return relativePath;
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
): Promise<LegacySourceSnapshot> {
  const opened = await stateRoot.read(relativeLegacyPath(stateDir, sourcePath), {
    hardlinks: "reject",
    maxBytes: LEGACY_NODE_HOST_MAX_BYTES,
    symlinks: "reject",
  });
  const raw = opened.buffer.toString("utf8");
  return {
    sourcePath,
    dev: opened.stat.dev,
    ino: opened.stat.ino,
    mtimeMs: opened.stat.mtimeMs,
    raw,
    sha256: createHash("sha256").update(raw).digest("hex"),
    size: opened.stat.size,
  };
}

function sourceSnapshotsMatch(left: LegacySourceSnapshot, right: LegacySourceSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function contentSnapshotsMatch(left: LegacySourceSnapshot, right: LegacySourceSnapshot): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}

async function recoverInterruptedClaim(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
): Promise<void> {
  const claimPath = `${sourcePath}${LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX}`;
  const claimRelativePath = relativeLegacyPath(stateDir, claimPath);
  const sourceRelativePath = relativeLegacyPath(stateDir, sourcePath);
  if (!(await stateRoot.exists(claimRelativePath))) {
    return;
  }
  const claim = await readLegacySourceSnapshot(stateRoot, stateDir, claimPath);
  if (!(await stateRoot.exists(sourceRelativePath))) {
    await stateRoot.move(claimRelativePath, sourceRelativePath);
    return;
  }
  const source = await readLegacySourceSnapshot(stateRoot, stateDir, sourcePath);
  if (!contentSnapshotsMatch(claim, source)) {
    throw new Error("interrupted node-host Doctor claim conflicts with its source");
  }
  await stateRoot.remove(claimRelativePath);
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

function nullableNonEmptyString(value: string | null, label: string): string | undefined {
  if (value === null) {
    return undefined;
  }
  if (!value.trim()) {
    throw new Error(`invalid node-host SQLite row: ${label} must not be empty`);
  }
  return value.trim();
}

function rowToCanonicalState(row: {
  version: number;
  node_id: string;
  display_name: string | null;
  gateway_host: string | null;
  gateway_port: number | null;
  gateway_tls: number | null;
  gateway_tls_fingerprint: string | null;
  gateway_context_path: string | null;
  updated_at_ms: number;
}): CanonicalNodeHostState {
  if (row.version !== 1 || !row.node_id.trim()) {
    throw new Error("invalid canonical node-host SQLite identity");
  }
  if (!Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
    throw new Error("invalid canonical node-host SQLite timestamp");
  }
  if (
    row.gateway_port !== null &&
    (!Number.isSafeInteger(row.gateway_port) || row.gateway_port <= 0 || row.gateway_port > 65_535)
  ) {
    throw new Error("invalid canonical node-host SQLite gateway port");
  }
  if (row.gateway_tls !== null && row.gateway_tls !== 0 && row.gateway_tls !== 1) {
    throw new Error("invalid canonical node-host SQLite gateway tls");
  }
  const gateway: NodeHostGatewayConfig = {
    host: nullableNonEmptyString(row.gateway_host, "gateway_host"),
    port: row.gateway_port ?? undefined,
    tls: row.gateway_tls === null ? undefined : row.gateway_tls === 1,
    tlsFingerprint: nullableNonEmptyString(row.gateway_tls_fingerprint, "gateway_tls_fingerprint"),
    contextPath: nullableNonEmptyString(row.gateway_context_path, "gateway_context_path"),
  };
  return {
    config: {
      version: 1,
      nodeId: row.node_id.trim(),
      displayName: nullableNonEmptyString(row.display_name, "display_name"),
      gateway: Object.values(gateway).some((entry) => entry !== undefined) ? gateway : undefined,
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
    left.gateway?.contextPath === right.gateway?.contextPath
  );
}

function writeCanonicalState(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  state: CanonicalNodeHostState,
): void {
  const gateway = state.config.gateway;
  const row = {
    config_key: NODE_HOST_CONFIG_KEY,
    version: 1,
    node_id: state.config.nodeId,
    token: null,
    display_name: state.config.displayName ?? null,
    gateway_host: gateway?.host ?? null,
    gateway_port: gateway?.port ?? null,
    gateway_tls: gateway?.tls === undefined ? null : gateway.tls ? 1 : 0,
    gateway_tls_fingerprint: gateway?.tlsFingerprint ?? null,
    gateway_context_path: gateway?.contextPath ?? null,
    updated_at_ms: state.updatedAtMs,
  };
  const { config_key: _configKey, ...updates } = row;
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<NodeHostConfigDatabase>(db)
      .insertInto("node_host_config")
      .values(row)
      .onConflict((conflict) => conflict.column("config_key").doUpdateSet(updates)),
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
          .selectFrom("node_host_config")
          .selectAll()
          .where("config_key", "=", NODE_HOST_CONFIG_KEY),
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
        existing.updatedAtMs !== expected.updatedAtMs ||
        row?.token !== null
      ) {
        writeCanonicalState(db, expected);
        imported = expected === params.legacy;
      }

      const verifiedRow = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("node_host_config")
          .selectAll()
          .where("config_key", "=", NODE_HOST_CONFIG_KEY),
      );
      if (!verifiedRow || verifiedRow.token !== null) {
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

async function restoreClaim(params: {
  stateRoot: Root;
  stateDir: string;
  snapshot: LegacySourceSnapshot;
}): Promise<string | null> {
  const claimPath = `${params.snapshot.sourcePath}${LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX}`;
  try {
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, claimPath)))) {
      return null;
    }
    if (
      await params.stateRoot.exists(relativeLegacyPath(params.stateDir, params.snapshot.sourcePath))
    ) {
      return `source path already exists: ${params.snapshot.sourcePath}`;
    }
    await params.stateRoot.move(
      relativeLegacyPath(params.stateDir, claimPath),
      relativeLegacyPath(params.stateDir, params.snapshot.sourcePath),
    );
    return null;
  } catch (error) {
    return String(error);
  }
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

  let snapshot: LegacySourceSnapshot;
  let legacy: CanonicalNodeHostState;
  try {
    await recoverInterruptedClaim(params.stateRoot, params.stateDir, sourcePath);
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath)))) {
      return { changes, warnings };
    }
    snapshot = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, sourcePath);
    legacy = parseLegacyNodeHostConfig(snapshot);
    params.beforeVerify?.();
    const current = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, sourcePath);
    if (!sourceSnapshotsMatch(current, snapshot)) {
      throw new Error("legacy node-host source changed after Doctor loaded it");
    }
  } catch (error) {
    warnings.push(`Failed reading legacy node-host state: ${String(error)}`);
    return { changes, warnings };
  }

  const claimPath = `${sourcePath}${LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX}`;
  try {
    params.beforeClaim?.();
    await params.stateRoot.move(
      relativeLegacyPath(params.stateDir, sourcePath),
      relativeLegacyPath(params.stateDir, claimPath),
    );
    const claimed = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, claimPath);
    if (!sourceSnapshotsMatch(claimed, snapshot)) {
      throw new Error("legacy node-host source changed before Doctor could claim it");
    }
  } catch (error) {
    const restoreError = await restoreClaim({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      snapshot,
    });
    warnings.push(
      `Failed migrating legacy node-host state: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  let result: ReturnType<typeof migrateIntoDatabase>;
  try {
    result = migrateIntoDatabase({ env: params.env, legacy });
  } catch (error) {
    const restoreError = await restoreClaim({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      snapshot,
    });
    warnings.push(
      `Failed migrating legacy node-host state: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  try {
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath))) {
      throw new Error(`legacy node-host source reappeared during import: ${sourcePath}`);
    }
    if (params.removeSource) {
      await params.removeSource(claimPath);
    } else {
      await params.stateRoot.remove(relativeLegacyPath(params.stateDir, claimPath));
    }
    if (
      (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath))) ||
      (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, claimPath)))
    ) {
      throw new Error("legacy node-host source or Doctor claim remains after cleanup");
    }
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
  const env = { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: MIGRATION_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    const detail =
      error instanceof GatewayLockError
        ? "the Gateway or another SQLite maintenance command owns this state directory"
        : String(error);
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy node-host state: ${detail}. Stop the Gateway and node host, then run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: ["Failed migrating legacy node-host state: exclusive state ownership unavailable."],
    };
  }

  let result: MigrationMessages = { changes: [], warnings: [] };
  let releaseError: unknown;
  try {
    try {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: LEGACY_NODE_HOST_MAX_BYTES,
        symlinks: "reject",
      });
      result = await migrateWithExclusiveStateOwnership({
        ...params,
        env,
        stateRoot,
      });
    } catch (error) {
      result.warnings.push(`Failed reading legacy node-host state: ${String(error)}`);
    }
  } finally {
    try {
      await lock.release();
    } catch (error) {
      releaseError = error;
    }
  }
  if (releaseError) {
    result.warnings.push(
      `Node-host migration lock release failed: ${formatErrorMessage(releaseError)}`,
    );
  }
  return result;
}
