// Doctor-only import for retired per-server MCP OAuth JSON stores.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { parseMcpOAuthStoreJson } from "../agents/mcp-oauth-store.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { formatErrorMessage } from "./errors.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { parseLegacyMcpOAuthStore } from "./state-migrations.mcp-oauth-format.js";
import { withRootBoundedLegacyFileLock } from "./state-migrations.mcp-oauth-lock.js";
import type { LegacyMcpOAuthDetection } from "./state-migrations.mcp-oauth.types.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const LEGACY_MCP_OAUTH_DIR = "mcp-oauth";
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const MIGRATION_KIND = "legacy-mcp-oauth-json";
const MIGRATION_LOCK_TIMEOUT_MS = 250;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 25;
const MAX_LEGACY_STORE_BYTES = 4 * 1024 * 1024;
const LEGACY_STORE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,29}-[0-9a-f]{16}\.json$/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type McpOAuthMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "mcp_oauth_stores" | "migration_runs" | "migration_sources"
>;

type LegacySourceSnapshot = {
  sourcePath: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  size: number;
  store: Record<string, unknown>;
};

type MigrationReceipt = {
  sourceKey: string;
  removedSource: boolean;
};

function exactLegacyBaseName(name: string): string | null {
  const baseName = name.endsWith(DOCTOR_CLAIM_SUFFIX)
    ? name.slice(0, -DOCTOR_CLAIM_SUFFIX.length)
    : name;
  return LEGACY_STORE_NAME_RE.test(baseName) ? baseName : null;
}

function exactLegacyBaseNames(entries: Iterable<{ name: string }>): string[] {
  const baseNames = new Set<string>();
  for (const entry of entries) {
    const baseName = exactLegacyBaseName(entry.name);
    if (baseName) {
      baseNames.add(baseName);
    }
  }
  return Array.from(baseNames).toSorted();
}

function listLegacySourcePaths(sourceDir: string): string[] {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  return exactLegacyBaseNames(entries).map((baseName) => path.join(sourceDir, baseName));
}

async function listLegacySourcePathsFromRoot(params: {
  stateRoot: Root;
  stateDir: string;
}): Promise<string[]> {
  // Validate the legacy directory through the pinned root before creating any
  // retired-runtime lock sidecars. A symlinked directory must never escape stateDir.
  const entries = await params.stateRoot.list(LEGACY_MCP_OAUTH_DIR, {
    withFileTypes: true,
  });
  return exactLegacyBaseNames(entries).map((baseName) =>
    path.join(params.stateDir, LEGACY_MCP_OAUTH_DIR, baseName),
  );
}

function pathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Detect exact retired MCP OAuth filenames only for an explicit Doctor flow. */
export function detectLegacyMcpOAuthStores(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyMcpOAuthDetection {
  const sourceDir = path.join(params.stateDir, LEGACY_MCP_OAUTH_DIR);
  if (params.doctorOnlyStateMigrations !== true) {
    return { sourceDir, sourcePaths: [], hasLegacy: false };
  }
  try {
    const sourcePaths = listLegacySourcePaths(sourceDir);
    return { sourceDir, sourcePaths, hasLegacy: sourcePaths.length > 0 };
  } catch {
    return { sourceDir, sourcePaths: [], hasLegacy: pathMayExist(sourceDir) };
  }
}

function relativeLegacyPath(stateDir: string, filePath: string): string {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(filePath));
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("legacy MCP OAuth path is outside the state directory");
  }
  return relativePath;
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
  options: { parseStore?: boolean } = {},
): Promise<LegacySourceSnapshot> {
  const opened = await stateRoot.read(relativeLegacyPath(stateDir, sourcePath), {
    hardlinks: "reject",
    maxBytes: MAX_LEGACY_STORE_BYTES,
    symlinks: "reject",
  });
  if (opened.stat.size !== opened.buffer.byteLength) {
    throw new Error("legacy MCP OAuth store changed while it was being read");
  }
  const parsed =
    options.parseStore === false
      ? {}
      : parseLegacyMcpOAuthStore(JSON.parse(utf8Decoder.decode(opened.buffer)));
  return {
    sourcePath,
    dev: opened.stat.dev,
    ino: opened.stat.ino,
    mtimeMs: opened.stat.mtimeMs,
    sha256: createHash("sha256").update(opened.buffer).digest("hex"),
    size: opened.stat.size,
    store: parsed,
  };
}

function snapshotsMatch(left: LegacySourceSnapshot, right: LegacySourceSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function storeKeyForSource(sourcePath: string): string {
  const fileName = path.basename(sourcePath);
  if (!LEGACY_STORE_NAME_RE.test(fileName)) {
    throw new Error("legacy MCP OAuth filename is invalid");
  }
  return fileName.slice(0, -".json".length);
}

function receiptSourceKey(sourcePath: string): string {
  return `mcp-oauth-json:${createHash("sha256").update(path.resolve(sourcePath)).digest("hex")}`;
}

function readMigrationReceipt(sourcePath: string, env: NodeJS.ProcessEnv): MigrationReceipt | null {
  const sourceKey = receiptSourceKey(sourcePath);
  const { db } = openOpenClawStateDatabase({ env });
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<McpOAuthMigrationDatabase>(db)
      .selectFrom("migration_sources")
      .select("removed_source")
      .where("source_key", "=", sourceKey),
  );
  return row ? { sourceKey, removedSource: row.removed_source === 1 } : null;
}

function importAndRecordReceipt(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
}): { sourceKey: string; imported: boolean } {
  const sourceKey = receiptSourceKey(params.sourcePath);
  const storeKey = storeKeyForSource(params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<McpOAuthMigrationDatabase>(db);
      const existingReceipt = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("migration_sources")
          .select("source_key")
          .where("source_key", "=", sourceKey),
      );
      if (existingReceipt) {
        return { sourceKey, imported: false };
      }

      const existingStore = executeSqliteQueryTakeFirstSync(
        db,
        stateDb.selectFrom("mcp_oauth_stores").selectAll().where("store_key", "=", storeKey),
      );
      let importedLegacyState: boolean;
      if (existingStore) {
        if (existingStore.format_version !== 1) {
          throw new Error("canonical MCP OAuth store has an unsupported format version");
        }
        const canonicalStore = parseMcpOAuthStoreJson(storeKey, existingStore.store_json);
        const canMergeLegacyState = canonicalStore.credentialState === "uninitialized";
        const legacyStore = { ...params.snapshot.store };
        if (canonicalStore.pendingAuthorizationChallenge?.resourceMetadataUrl) {
          delete legacyStore.discoveryState;
        }
        importedLegacyState =
          canMergeLegacyState &&
          Object.keys(legacyStore).some((key) => !Object.hasOwn(canonicalStore, key));
        if (importedLegacyState) {
          const mergedStore = { ...legacyStore, ...canonicalStore };
          delete mergedStore.credentialState;
          executeSqliteQuerySync(
            db,
            stateDb
              .updateTable("mcp_oauth_stores")
              .set({
                store_json: JSON.stringify(mergedStore),
                updated_at: now,
              })
              .where("store_key", "=", storeKey),
          );
        }
      } else {
        importedLegacyState = true;
        executeSqliteQuerySync(
          db,
          stateDb.insertInto("mcp_oauth_stores").values({
            store_key: storeKey,
            format_version: 1,
            store_json: JSON.stringify(params.snapshot.store),
            updated_at: now,
          }),
        );
      }

      const verified = executeSqliteQueryTakeFirstSync(
        db,
        stateDb.selectFrom("mcp_oauth_stores").selectAll().where("store_key", "=", storeKey),
      );
      if (!verified || verified.format_version !== 1) {
        throw new Error("SQLite verification failed for an MCP OAuth store");
      }
      parseMcpOAuthStoreJson(storeKey, verified.store_json);

      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: "mcp_oauth_stores",
        storeKey,
        sourceSha256: params.snapshot.sha256,
        importedRecordCount: importedLegacyState ? 1 : 0,
        preservedSqliteRecordCount: existingStore ? 1 : 0,
      });
      executeSqliteQuerySync(
        db,
        stateDb.insertInto("migration_runs").values({
          id: runId,
          started_at: now,
          finished_at: now,
          status: "completed",
          report_json: reportJson,
        }),
      );
      executeSqliteQuerySync(
        db,
        stateDb.insertInto("migration_sources").values({
          source_key: sourceKey,
          migration_kind: MIGRATION_KIND,
          source_path: params.sourcePath,
          target_table: "mcp_oauth_stores",
          source_sha256: params.snapshot.sha256,
          source_size_bytes: params.snapshot.size,
          source_record_count: 1,
          last_run_id: runId,
          status: "completed",
          imported_at: now,
          removed_source: 0,
          report_json: reportJson,
        }),
      );
      return { sourceKey, imported: importedLegacyState };
    },
    { env: params.env },
  );
}

function markSourceRemoved(sourceKey: string, env: NodeJS.ProcessEnv): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<McpOAuthMigrationDatabase>(db)
          .updateTable("migration_sources")
          .set({ removed_source: 1 })
          .where("source_key", "=", sourceKey),
      );
    },
    { env },
  );
}

async function removePath(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<void> {
  if (params.removeSource) {
    await params.removeSource(params.sourcePath);
    return;
  }
  await params.stateRoot.remove(relativeLegacyPath(params.stateDir, params.sourcePath));
}

async function cleanupReceiptAuthoritativeSources(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  receipt: MigrationReceipt;
  env: NodeJS.ProcessEnv;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<number> {
  let removed = 0;
  for (const candidate of [params.sourcePath, `${params.sourcePath}${DOCTOR_CLAIM_SUFFIX}`]) {
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, candidate)))) {
      continue;
    }
    await readLegacySourceSnapshot(params.stateRoot, params.stateDir, candidate, {
      parseStore: false,
    });
    await removePath({ ...params, sourcePath: candidate });
    removed += 1;
  }
  if (!params.receipt.removedSource || removed > 0) {
    markSourceRemoved(params.receipt.sourceKey, params.env);
  }
  return removed;
}

async function restoreClaim(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
}): Promise<string | null> {
  const claimPath = `${params.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  try {
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, claimPath)))) {
      return null;
    }
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, params.sourcePath))) {
      return `source path already exists: ${params.sourcePath}`;
    }
    await params.stateRoot.move(
      relativeLegacyPath(params.stateDir, claimPath),
      relativeLegacyPath(params.stateDir, params.sourcePath),
    );
    return null;
  } catch (error) {
    return String(error);
  }
}

async function migrateOneStore(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: (sourcePath: string) => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const receipt = readMigrationReceipt(params.sourcePath, params.env);
  if (receipt) {
    try {
      const removed = await cleanupReceiptAuthoritativeSources({ ...params, receipt });
      if (removed > 0) {
        changes.push("Discarded recreated retired MCP OAuth JSON without importing it.");
      }
    } catch (error) {
      warnings.push(`MCP OAuth state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    }
    return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
  }

  const claimPath = `${params.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  const hasSource = await params.stateRoot.exists(
    relativeLegacyPath(params.stateDir, params.sourcePath),
  );
  const hasClaim = await params.stateRoot.exists(relativeLegacyPath(params.stateDir, claimPath));
  if (hasSource && hasClaim) {
    return {
      changes,
      warnings: [
        `Failed migrating legacy MCP OAuth store ${path.basename(params.sourcePath)}: source and interrupted claim both exist.`,
      ],
    };
  }
  const activePath = hasSource ? params.sourcePath : hasClaim ? claimPath : null;
  if (!activePath) {
    return { changes, warnings };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    snapshot = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, activePath);
  } catch (error) {
    warnings.push(
      `Failed reading legacy MCP OAuth store ${path.basename(params.sourcePath)}: ${String(error)}`,
    );
    return { changes, warnings };
  }

  if (activePath === params.sourcePath) {
    try {
      params.beforeClaim?.(params.sourcePath);
      await params.stateRoot.move(
        relativeLegacyPath(params.stateDir, params.sourcePath),
        relativeLegacyPath(params.stateDir, claimPath),
      );
      const claimed = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, claimPath);
      if (!snapshotsMatch(snapshot, claimed)) {
        throw new Error("legacy MCP OAuth source changed before Doctor could claim it");
      }
      snapshot = claimed;
    } catch (error) {
      const restoreError = await restoreClaim(params);
      warnings.push(
        `Failed migrating legacy MCP OAuth store ${path.basename(params.sourcePath)}: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      );
      return { changes, warnings };
    }
  }

  let result: ReturnType<typeof importAndRecordReceipt>;
  try {
    result = importAndRecordReceipt({
      env: params.env,
      sourcePath: params.sourcePath,
      snapshot,
    });
  } catch (error) {
    const restoreError = await restoreClaim(params);
    warnings.push(
      `Failed migrating legacy MCP OAuth store ${path.basename(params.sourcePath)}: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  try {
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, params.sourcePath))) {
      throw new Error("legacy MCP OAuth source reappeared during import");
    }
    const finalSnapshot = await readLegacySourceSnapshot(
      params.stateRoot,
      params.stateDir,
      claimPath,
    );
    if (!snapshotsMatch(snapshot, finalSnapshot)) {
      throw new Error("legacy MCP OAuth claim changed after SQLite import");
    }
    await removePath({ ...params, sourcePath: claimPath });
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, claimPath))) {
      throw new Error("legacy MCP OAuth Doctor claim remains after cleanup");
    }
    markSourceRemoved(result.sourceKey, params.env);
  } catch (error) {
    warnings.push(`MCP OAuth state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  changes.push(
    result.imported
      ? `Migrated MCP OAuth store ${path.basename(params.sourcePath)} to SQLite.`
      : `Preserved canonical SQLite MCP OAuth store for ${path.basename(params.sourcePath)}.`,
  );
  notices.push("Removed retired MCP OAuth JSON after verified SQLite import.");
  return { changes, warnings, notices };
}

async function migrateWithExclusiveStateOwnership(params: {
  stateRoot: Root;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeLegacyLock?: (sourcePath: string) => void;
  beforeClaim?: (sourcePath: string) => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  let sourcePaths: string[];
  try {
    sourcePaths = await listLegacySourcePathsFromRoot(params);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "not-found") {
      return { changes, warnings };
    }
    return { changes, warnings: [`Failed reading legacy MCP OAuth directory: ${String(error)}`] };
  }
  for (const sourcePath of sourcePaths) {
    try {
      // Retired releases serialize complete refresh/login flows on this exact
      // path. Hold their lock while claiming bytes so an old CLI cannot race Doctor.
      params.beforeLegacyLock?.(sourcePath);
      const result = await withRootBoundedLegacyFileLock(
        {
          stateRoot: params.stateRoot,
          targetRelativePath: relativeLegacyPath(params.stateDir, sourcePath),
        },
        async () => await migrateOneStore({ ...params, sourcePath }),
      );
      changes.push(...result.changes);
      warnings.push(...result.warnings);
      notices.push(...(result.notices ?? []));
    } catch (error) {
      const staleGuidance =
        (error as { code?: unknown }).code === "file_lock_stale"
          ? " Verify no older OpenClaw process is running, remove the retired .lock sidecar, and rerun Doctor."
          : "";
      warnings.push(
        `Failed locking legacy MCP OAuth store ${path.basename(sourcePath)}: ${String(error)}.${staleGuidance}`,
      );
    }
  }
  return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
}

/** Import retired MCP OAuth stores while excluding old Gateways that can recreate them. */
export async function migrateLegacyMcpOAuthStores(params: {
  detected: LegacyMcpOAuthDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeLegacyLock?: (sourcePath: string) => void;
  beforeClaim?: (sourcePath: string) => void;
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
        `Failed migrating legacy MCP OAuth stores: ${detail}. Stop the Gateway and run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: [
        "Failed migrating legacy MCP OAuth stores: exclusive state ownership unavailable.",
      ],
    };
  }

  let result: MigrationMessages = { changes: [], warnings: [] };
  let releaseError: unknown;
  try {
    try {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_STORE_BYTES,
        symlinks: "reject",
      });
      result = await migrateWithExclusiveStateOwnership({ ...params, env, stateRoot });
    } catch (error) {
      result.warnings.push(`Failed reading legacy MCP OAuth state: ${String(error)}`);
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
      `MCP OAuth migration lock release failed: ${formatErrorMessage(releaseError)}`,
    );
  }
  return result;
}
