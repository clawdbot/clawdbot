// Matrix plugin module implements storage behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { loadJsonFile } from "openclaw/plugin-sdk/json-store";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import {
  isMatrixActiveTokenRootDirectory,
  resolveMatrixAccountStorageRoot,
} from "../../storage-paths.js";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
  MATRIX_RECOVERY_KEY_FILENAME,
  migrateLegacyMatrixLegacyCryptoMigrationFileToStore,
  migrateLegacyMatrixRecoveryKeyFileToStore,
  scoreMatrixCryptoStateInStore,
} from "../crypto-state-store.js";
import {
  normalizeMatrixStorageMetadata,
  openMatrixStorageMetaStoreOptions,
  STORAGE_META_STATE_KEY,
  type MatrixStorageMetadata,
} from "./storage-metadata.js";
import type { MatrixAuth, MatrixStoragePaths } from "./types.js";

const DEFAULT_ACCOUNT_KEY = "default";
const STORAGE_META_FILENAME = "storage-meta.json";
const THREAD_BINDINGS_FILENAME = "thread-bindings.json";
type LegacyMoveRecord = {
  sourcePath: string;
  targetPath: string;
  label: string;
};

type LegacyArchiveRecord = {
  sourcePath: string;
  label: string;
};

function openStorageMetaStore(rootDir: string): PluginStateSyncKeyedStore<MatrixStorageMetadata> {
  return getMatrixRuntime().state.openSyncKeyedStore<MatrixStorageMetadata>(
    openMatrixStorageMetaStoreOptions(rootDir),
  );
}

function scoreStorageRoot(
  rootDir: string,
  metadata: MatrixStorageMetadata = readStoredRootMetadata(rootDir),
): number {
  let score = 0;
  if (Object.keys(metadata).length > 0) {
    score += 1;
  }
  if (metadata.currentTokenStateClaimed === true) {
    score += 8;
  }
  if (fs.existsSync(path.join(rootDir, "crypto"))) {
    score += 8;
  }
  if (fs.existsSync(path.join(rootDir, THREAD_BINDINGS_FILENAME))) {
    score += 4;
  }
  if (fs.existsSync(path.join(rootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME))) {
    score += 3;
  }
  if (fs.existsSync(path.join(rootDir, MATRIX_RECOVERY_KEY_FILENAME))) {
    score += 2;
  }
  if (fs.existsSync(path.join(rootDir, MATRIX_IDB_SNAPSHOT_FILENAME))) {
    score += 2;
  }
  score += scoreMatrixCryptoStateInStore(rootDir);
  return score;
}

function resolveStorageRootMtimeMs(rootDir: string): number {
  try {
    return fs.statSync(rootDir).mtimeMs;
  } catch {
    return 0;
  }
}

type PopulatedMatrixStorageRoot = {
  tokenHash: string;
  rootDir: string;
  score: number;
  mtimeMs: number;
};

function readStoredRootMetadata(rootDir: string): MatrixStorageMetadata {
  if (fs.existsSync(path.join(rootDir, "state", "openclaw.sqlite"))) {
    try {
      const stored = normalizeMatrixStorageMetadata(
        openStorageMetaStore(rootDir).lookup(STORAGE_META_STATE_KEY),
      );
      if (stored) {
        return stored;
      }
    } catch {
      // Root selection remains best-effort; a write path will surface SQLite failures.
    }
  }
  return (
    normalizeMatrixStorageMetadata(loadJsonFile(path.join(rootDir, STORAGE_META_FILENAME))) ?? {}
  );
}

function isCompatibleStorageRoot(params: {
  candidateRootDir: string;
  homeserver: string;
  userId: string;
  accountKey: string;
  deviceId?: string | null;
  requireExplicitDeviceMatch?: boolean;
}): boolean {
  const metadata = readStoredRootMetadata(params.candidateRootDir);
  if (metadata.homeserver && metadata.homeserver !== params.homeserver) {
    return false;
  }
  if (metadata.userId && metadata.userId !== params.userId) {
    return false;
  }
  if (
    metadata.accountId &&
    normalizeAccountId(metadata.accountId) !== normalizeAccountId(params.accountKey)
  ) {
    return false;
  }
  if (
    params.deviceId &&
    metadata.deviceId &&
    metadata.deviceId.trim() &&
    metadata.deviceId.trim() !== params.deviceId.trim()
  ) {
    return false;
  }
  if (
    params.requireExplicitDeviceMatch &&
    params.deviceId &&
    (!metadata.deviceId || metadata.deviceId.trim() !== params.deviceId.trim())
  ) {
    return false;
  }
  return true;
}

function resolvePreferredMatrixStorageRoot(params: {
  canonicalRootDir: string;
  canonicalTokenHash: string;
  homeserver: string;
  userId: string;
  accountKey: string;
  deviceId?: string | null;
}): {
  rootDir: string;
  tokenHash: string;
} {
  const canonical = {
    rootDir: params.canonicalRootDir,
    tokenHash: params.canonicalTokenHash,
  };
  const deviceId = params.deviceId?.trim();

  // Without a confirmed device identity, reusing a populated sibling root after
  // token rotation can silently bind this run to the wrong Matrix device state.
  if (!deviceId) {
    return canonical;
  }

  const canonicalMetadata = readStoredRootMetadata(params.canonicalRootDir);
  const canonicalRootOwnsCurrentToken =
    canonicalMetadata.accessTokenHash === params.canonicalTokenHash &&
    canonicalMetadata.deviceId?.trim() === deviceId &&
    canonicalMetadata.currentTokenStateClaimed === true;

  // A claimed canonical root is authoritative. Scanning token-history siblings
  // would synchronously open and retain every per-root SQLite store during startup.
  if (canonicalRootOwnsCurrentToken) {
    return canonical;
  }

  const parentDir = path.dirname(params.canonicalRootDir);
  const bestCurrentScore = scoreStorageRoot(params.canonicalRootDir, canonicalMetadata);
  const bestCurrentMtimeMs = resolveStorageRootMtimeMs(params.canonicalRootDir);
  let best = {
    rootDir: params.canonicalRootDir,
    tokenHash: params.canonicalTokenHash,
    score: bestCurrentScore,
    mtimeMs: bestCurrentMtimeMs,
  };

  let siblingEntries: fs.Dirent[];
  try {
    siblingEntries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return {
      rootDir: best.rootDir,
      tokenHash: best.tokenHash,
    };
  }

  const compatiblePopulatedSiblings: PopulatedMatrixStorageRoot[] = [];
  const populatedTokenHashes = bestCurrentScore > 0 ? [params.canonicalTokenHash] : [];
  for (const entry of siblingEntries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === params.canonicalTokenHash) {
      continue;
    }
    // Sibling reuse is only defined for exact token-hash roots. Filtering here
    // keeps archived SQLite state out of compatibility checks and scoring.
    if (!isMatrixActiveTokenRootDirectory(entry.name)) {
      continue;
    }
    const candidateRootDir = path.join(parentDir, entry.name);
    if (
      !isCompatibleStorageRoot({
        candidateRootDir,
        homeserver: params.homeserver,
        userId: params.userId,
        accountKey: params.accountKey,
        deviceId,
        // Once auth resolves a concrete device, only sibling roots that explicitly
        // declare that same device are safe to reuse across token rotations.
        requireExplicitDeviceMatch: true,
      })
    ) {
      continue;
    }
    const candidateScore = scoreStorageRoot(candidateRootDir);
    if (candidateScore <= 0) {
      continue;
    }
    populatedTokenHashes.push(entry.name);
    compatiblePopulatedSiblings.push({
      rootDir: candidateRootDir,
      tokenHash: entry.name,
      score: candidateScore,
      mtimeMs: resolveStorageRootMtimeMs(candidateRootDir),
    });
  }

  for (const candidate of compatiblePopulatedSiblings) {
    if (
      candidate.score > best.score ||
      (best.rootDir !== params.canonicalRootDir &&
        candidate.score === best.score &&
        candidate.mtimeMs > best.mtimeMs)
    ) {
      best = {
        rootDir: candidate.rootDir,
        tokenHash: candidate.tokenHash,
        score: candidate.score,
        mtimeMs: candidate.mtimeMs,
      };
    }
  }

  if (populatedTokenHashes.length > 1) {
    getMatrixRuntime()
      .logging.getChildLogger({ module: "matrix-storage" })
      .warn("matrix: multiple populated token-hash storage roots detected", {
        parentDir,
        canonicalTokenHash: params.canonicalTokenHash,
        selectedTokenHash: best.tokenHash,
        populatedTokenHashes,
        populatedSiblingTokenHashes: compatiblePopulatedSiblings.map((root) => root.tokenHash),
        populatedRootCount: populatedTokenHashes.length,
      });
  }

  return {
    rootDir: best.rootDir,
    tokenHash: best.tokenHash,
  };
}

export function resolveMatrixStoragePaths(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
  deviceId?: string | null;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): MatrixStoragePaths {
  const env = params.env ?? process.env;
  const stateDir = params.stateDir ?? getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  const canonical = resolveMatrixAccountStorageRoot({
    stateDir,
    homeserver: params.homeserver,
    userId: params.userId,
    accessToken: params.accessToken,
    accountId: params.accountId,
  });
  const { rootDir, tokenHash } = resolvePreferredMatrixStorageRoot({
    canonicalRootDir: canonical.rootDir,
    canonicalTokenHash: canonical.tokenHash,
    homeserver: params.homeserver,
    userId: params.userId,
    accountKey: canonical.accountKey,
    deviceId: params.deviceId,
  });
  return {
    rootDir,
    storagePath: path.join(rootDir, "bot-storage.json"),
    cryptoPath: path.join(rootDir, "crypto"),
    recoveryKeyPath: path.join(rootDir, MATRIX_RECOVERY_KEY_FILENAME),
    idbSnapshotPath: path.join(rootDir, MATRIX_IDB_SNAPSHOT_FILENAME),
    accountKey: canonical.accountKey,
    tokenHash,
  };
}

export function resolveMatrixStateFilePath(params: {
  auth: MatrixAuth;
  filename: string;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): string {
  const storagePaths = resolveMatrixStoragePaths({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    accountId: params.accountId ?? params.auth.accountId,
    deviceId: params.auth.deviceId,
    env: params.env,
    stateDir: params.stateDir,
  });
  return path.join(storagePaths.rootDir, params.filename);
}

export async function maybeMigrateLegacyStorage(params: {
  storagePaths: MatrixStoragePaths;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const hasAccountScopedLegacyStorageFile = fs.existsSync(params.storagePaths.storagePath);
  const syncCache = hasAccountScopedLegacyStorageFile
    ? await import("./sync-cache-state.js")
    : null;
  const hasAccountScopedLegacyStorage =
    hasAccountScopedLegacyStorageFile &&
    (await syncCache?.readLegacyMatrixSyncCacheState(params.storagePaths.rootDir)) !== null;
  const hasAccountScopedRecoveryKey = fs.existsSync(params.storagePaths.recoveryKeyPath);
  const hasAccountScopedLegacyCryptoMigration = fs.existsSync(
    path.join(params.storagePaths.rootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME),
  );
  if (
    !hasAccountScopedLegacyStorage &&
    !hasAccountScopedRecoveryKey &&
    !hasAccountScopedLegacyCryptoMigration
  ) {
    return;
  }

  const logger = getMatrixRuntime().logging.getChildLogger({ module: "matrix-storage" });
  fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
  const moved: LegacyMoveRecord[] = [];
  const pendingArchives: LegacyArchiveRecord[] = [];
  const skippedExistingTargets: string[] = [];
  try {
    if (hasAccountScopedLegacyStorage) {
      await migrateLegacySyncCacheToSqlite({
        sourceRootDir: params.storagePaths.rootDir,
        sourcePath: params.storagePaths.storagePath,
        targetRootDir: params.storagePaths.rootDir,
        label: "account sync cache",
        moved,
        pendingArchives,
      });
    }
    if (hasAccountScopedRecoveryKey) {
      migrateLegacyMatrixRecoveryKeyFileToStore(params.storagePaths.rootDir);
      moved.push({
        sourcePath: params.storagePaths.recoveryKeyPath,
        targetPath: `${params.storagePaths.rootDir} SQLite recovery key state`,
        label: "recovery key",
      });
    }
    if (hasAccountScopedLegacyCryptoMigration) {
      migrateLegacyMatrixLegacyCryptoMigrationFileToStore(params.storagePaths.rootDir);
      moved.push({
        sourcePath: path.join(params.storagePaths.rootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME),
        targetPath: `${params.storagePaths.rootDir} SQLite legacy crypto migration state`,
        label: "legacy crypto migration",
      });
    }
  } catch (err) {
    const rollbackError = rollbackLegacyMoves(moved);
    throw new Error(
      rollbackError
        ? `Failed migrating legacy Matrix client storage: ${String(err)}. Rollback also failed: ${rollbackError}`
        : `Failed migrating legacy Matrix client storage: ${String(err)}`,
      { cause: err },
    );
  }
  for (const archive of pendingArchives) {
    archiveLegacyStoragePath({
      ...archive,
      skippedExistingTargets,
    });
  }
  if (moved.length > 0) {
    logger.info(
      `matrix: migrated legacy client storage into ${params.storagePaths.rootDir}\n${moved
        .map((entry) => `- ${entry.label}: ${entry.sourcePath} -> ${entry.targetPath}`)
        .join("\n")}`,
    );
  }
  if (skippedExistingTargets.length > 0) {
    logger.warn?.(
      `matrix: legacy client storage files were left in place because their migrated targets already existed.\n${skippedExistingTargets.join("\n")}`,
    );
  }
}

async function migrateLegacySyncCacheToSqlite(params: {
  sourceRootDir: string;
  sourcePath: string;
  targetRootDir: string;
  label: string;
  moved: LegacyMoveRecord[];
  pendingArchives: LegacyArchiveRecord[];
}): Promise<void> {
  const syncCache = await import("./sync-cache-state.js");
  const persisted = await syncCache.readLegacyMatrixSyncCacheState(params.sourceRootDir);
  if (!persisted) {
    return;
  }
  const store = getMatrixRuntime().state.openKeyedStore<
    import("./sync-cache-state.js").MatrixSyncCacheRecord
  >(syncCache.openMatrixSyncCacheStoreOptions(params.targetRootDir));
  if (
    !(await syncCache.hasMatrixSyncCacheStateInStore({
      storageRootDir: params.targetRootDir,
      store,
    }))
  ) {
    await syncCache.writeMatrixSyncCacheStateToStore({
      storageRootDir: params.targetRootDir,
      payload: persisted,
      store,
    });
    claimCurrentTokenStorageState({
      rootDir: params.targetRootDir,
    });
    params.moved.push({
      sourcePath: params.sourcePath,
      targetPath: `${params.targetRootDir} SQLite sync cache`,
      label: params.label,
    });
  }
  params.pendingArchives.push({
    sourcePath: params.sourcePath,
    label: params.label,
  });
}

function archiveLegacyStoragePath(params: {
  sourcePath: string;
  label: string;
  skippedExistingTargets: string[];
}): void {
  const archivedLegacyStoragePath = `${params.sourcePath}.migrated`;
  if (fs.existsSync(archivedLegacyStoragePath)) {
    params.skippedExistingTargets.push(
      `- ${params.label} remains at ${params.sourcePath} because ${archivedLegacyStoragePath} already exists`,
    );
    return;
  }
  fs.renameSync(params.sourcePath, archivedLegacyStoragePath);
}

function rollbackLegacyMoves(moved: LegacyMoveRecord[]): string | null {
  for (const entry of moved.toReversed()) {
    try {
      if (!fs.existsSync(entry.targetPath) || fs.existsSync(entry.sourcePath)) {
        continue;
      }
      fs.renameSync(entry.targetPath, entry.sourcePath);
    } catch (err) {
      return `${entry.label} (${entry.targetPath} -> ${entry.sourcePath}): ${String(err)}`;
    }
  }
  return null;
}

function writeStoredRootMetadata(
  rootDir: string,
  payload: {
    homeserver?: string;
    userId?: string;
    accountId: string;
    accessTokenHash?: string;
    deviceId: string | null;
    currentTokenStateClaimed: boolean;
    createdAt: string;
  },
): boolean {
  try {
    const normalized = normalizeMatrixStorageMetadata(payload);
    if (!normalized) {
      return false;
    }
    openStorageMetaStore(rootDir).register(STORAGE_META_STATE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

export function writeStorageMeta(params: {
  storagePaths: MatrixStoragePaths;
  homeserver: string;
  userId: string;
  accountId?: string | null;
  deviceId?: string | null;
  currentTokenStateClaimed?: boolean;
}): boolean {
  const existing = readStoredRootMetadata(params.storagePaths.rootDir);
  return writeStoredRootMetadata(params.storagePaths.rootDir, {
    homeserver: params.homeserver,
    userId: params.userId,
    accountId: params.accountId ?? DEFAULT_ACCOUNT_KEY,
    accessTokenHash: params.storagePaths.tokenHash,
    deviceId: params.deviceId ?? null,
    currentTokenStateClaimed:
      params.currentTokenStateClaimed ?? existing.currentTokenStateClaimed === true,
    createdAt: existing.createdAt ?? new Date().toISOString(),
  });
}

export function claimCurrentTokenStorageState(params: { rootDir: string }): boolean {
  const metadata = readStoredRootMetadata(params.rootDir);
  if (!metadata.accessTokenHash?.trim()) {
    return false;
  }
  return writeStoredRootMetadata(params.rootDir, {
    homeserver: metadata.homeserver,
    userId: metadata.userId,
    accountId: metadata.accountId ?? DEFAULT_ACCOUNT_KEY,
    accessTokenHash: metadata.accessTokenHash,
    deviceId: metadata.deviceId ?? null,
    currentTokenStateClaimed: true,
    createdAt: metadata.createdAt ?? new Date().toISOString(),
  });
}

export function recordCurrentStorageMetaDeviceId(params: {
  rootDir: string;
  deviceId: string;
}): boolean {
  const deviceId = params.deviceId.trim();
  if (!deviceId) {
    return false;
  }
  const metadata = readStoredRootMetadata(params.rootDir);
  if (!metadata.accessTokenHash?.trim()) {
    return false;
  }
  return writeStoredRootMetadata(params.rootDir, {
    homeserver: metadata.homeserver,
    userId: metadata.userId,
    accountId: metadata.accountId ?? DEFAULT_ACCOUNT_KEY,
    accessTokenHash: metadata.accessTokenHash,
    deviceId,
    currentTokenStateClaimed: metadata.currentTokenStateClaimed === true,
    createdAt: metadata.createdAt ?? new Date().toISOString(),
  });
}

export function repairCurrentTokenStorageMetaDeviceId(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
  deviceId: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): boolean {
  const storagePaths = resolveMatrixStoragePaths({
    homeserver: params.homeserver,
    userId: params.userId,
    accessToken: params.accessToken,
    accountId: params.accountId,
    env: params.env,
    stateDir: params.stateDir,
  });
  return writeStorageMeta({
    storagePaths,
    homeserver: params.homeserver,
    userId: params.userId,
    accountId: params.accountId,
    deviceId: params.deviceId,
  });
}
