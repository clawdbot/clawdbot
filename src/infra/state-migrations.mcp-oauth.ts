// Doctor-only import for retired per-server MCP OAuth JSON stores.
import fs from "node:fs";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { mcpOAuthStoreKeyFromLegacyFileName } from "../agents/mcp-oauth-identity.js";
import { parseMcpOAuthStoreJson } from "../agents/mcp-oauth-store.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import { parseLegacyMcpOAuthStore } from "./state-migrations.mcp-oauth-format.js";
import { withRootBoundedLegacyFileLock } from "./state-migrations.mcp-oauth-lock.js";
import type { LegacyMcpOAuthDetection } from "./state-migrations.mcp-oauth.types.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceipt,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";
import {
  LegacyMigrationSourceClaim,
  legacyMigrationPathMayExist,
  legacyMigrationSourceSnapshotsMatch as snapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  resolveLegacyMigrationRelativePath,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const LEGACY_MCP_OAUTH_DIR = "mcp-oauth";
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const MIGRATION_KIND = "legacy-mcp-oauth-json";
const MAX_LEGACY_STORE_BYTES = 4 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type McpOAuthMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "mcp_oauth_stores">;

type LegacySourceSnapshot = LegacyMigrationSourceSnapshot & { store: Record<string, unknown> };

function parseLegacyMcpOAuthJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(utf8Decoder.decode(buffer));
  } catch {
    throw new Error("legacy MCP OAuth store contains invalid JSON");
  }
}

function exactLegacyBaseName(name: string): string | null {
  const baseName = name.endsWith(DOCTOR_CLAIM_SUFFIX)
    ? name.slice(0, -DOCTOR_CLAIM_SUFFIX.length)
    : name;
  return mcpOAuthStoreKeyFromLegacyFileName(baseName) ? baseName : null;
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
    return { sourceDir, sourcePaths: [], hasLegacy: legacyMigrationPathMayExist(sourceDir) };
  }
}

function relativeLegacyPath(stateDir: string, filePath: string): string {
  return resolveLegacyMigrationRelativePath(stateDir, filePath, "MCP OAuth", false);
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
  options: { parseStore?: boolean } = {},
): Promise<LegacySourceSnapshot> {
  const snapshot = await readLegacyMigrationSourceSnapshot({
    stateRoot,
    stateDir,
    sourcePath,
    maxBytes: MAX_LEGACY_STORE_BYTES,
    label: "MCP OAuth",
  });
  const parsed =
    options.parseStore === false
      ? {}
      : parseLegacyMcpOAuthStore(parseLegacyMcpOAuthJson(snapshot.buffer));
  return { ...snapshot, store: parsed };
}

function storeKeyForSource(sourcePath: string): string {
  const storeKey = mcpOAuthStoreKeyFromLegacyFileName(path.basename(sourcePath));
  if (!storeKey) {
    throw new Error("legacy MCP OAuth filename is invalid");
  }
  return storeKey;
}

function importAndRecordReceipt(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
}): { sourceKey: string; imported: boolean } {
  const sourceKey = resolveLegacyMigrationSourceKey("mcp-oauth-json", params.sourcePath);
  const storeKey = storeKeyForSource(params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<McpOAuthMigrationDatabase>(db);
      const existingReceipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
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
      recordLegacyMigrationReceipt(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: params.sourcePath,
        targetTable: "mcp_oauth_stores",
        sourceSha256: params.snapshot.sha256,
        sourceSizeBytes: params.snapshot.size,
        sourceRecordCount: 1,
        runId,
        now,
        reportJson,
      });
      return { sourceKey, imported: importedLegacyState };
    },
    { env: params.env },
  );
}

async function cleanupReceiptAuthoritativeSources(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  receipt: LegacyMigrationReceipt;
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
    if (params.removeSource) {
      await params.removeSource(candidate);
    } else {
      await params.stateRoot.remove(relativeLegacyPath(params.stateDir, candidate));
    }
    removed += 1;
  }
  if (!params.receipt.removedSource || removed > 0) {
    markLegacyMigrationSourceRemoved(params.receipt.sourceKey, params.env);
  }
  return removed;
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
  const receipt = readLegacyMigrationReceipt(
    resolveLegacyMigrationSourceKey("mcp-oauth-json", params.sourcePath),
    params.env,
  );
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

  const source = new LegacyMigrationSourceClaim<LegacySourceSnapshot>({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath: params.sourcePath,
    label: "MCP OAuth",
    includeFilePath: false,
    claimSuffix: DOCTOR_CLAIM_SUFFIX,
    readSnapshot: (snapshotPath) =>
      readLegacySourceSnapshot(params.stateRoot, params.stateDir, snapshotPath),
  });
  const hasSource = await source.exists();
  const hasClaim = await source.exists(true);
  if (hasSource && hasClaim) {
    return {
      changes,
      warnings: [
        `Failed migrating legacy MCP OAuth store ${path.basename(params.sourcePath)}: source and interrupted claim both exist.`,
      ],
    };
  }
  const activePath = hasSource ? params.sourcePath : hasClaim ? source.claimPath : null;
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
      snapshot = await source.claim({
        snapshot,
        mismatchMessage: "legacy MCP OAuth source changed before Doctor could claim it",
        beforeClaim: () => params.beforeClaim?.(params.sourcePath),
      });
    } catch (error) {
      const restoreError = await source.restore();
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
    const restoreError = await source.restore();
    warnings.push(
      `Failed migrating legacy MCP OAuth store ${path.basename(params.sourcePath)}: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  try {
    if (await source.exists()) {
      throw new Error("legacy MCP OAuth source reappeared during import");
    }
    const finalSnapshot = await source.read(true);
    if (!snapshotsMatch(snapshot, finalSnapshot)) {
      throw new Error("legacy MCP OAuth claim changed after SQLite import");
    }
    await source.remove({
      removeSource: params.removeSource,
      claimRemainingMessage: "legacy MCP OAuth Doctor claim remains after cleanup",
      skipSourceCheck: true,
    });
    markLegacyMigrationSourceRemoved(result.sourceKey, params.env);
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
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy MCP OAuth stores",
    releaseLabel: "MCP OAuth",
    errorLabel: "Failed reading legacy MCP OAuth state",
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_STORE_BYTES,
        symlinks: "reject",
      });
      return await migrateWithExclusiveStateOwnership({ ...params, env, stateRoot });
    },
  });
}
