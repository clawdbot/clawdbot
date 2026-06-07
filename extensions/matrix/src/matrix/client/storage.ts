// Matrix plugin module implements storage behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { loadJsonFile, saveJsonFile } from "openclaw/plugin-sdk/json-store";
import {
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../../account-selection.js";
import { getMatrixRuntime } from "../../runtime.js";
import {
  resolveMatrixAccountStorageRoot,
  resolveMatrixLegacyFlatStoragePaths,
} from "../../storage-paths.js";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
  MATRIX_RECOVERY_KEY_FILENAME,
  migrateLegacyMatrixLegacyCryptoMigrationFileToStore,
  migrateLegacyMatrixRecoveryKeyFileToStore,
  readMatrixIdbSnapshotJson,
  scoreMatrixCryptoStateInStore,
  writeMatrixIdbSnapshotJson,
} from "../crypto-state-store.js";
import type { MatrixAuth } from "./types.js";
import type { MatrixStoragePaths } from "./types.js";

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

type StoredRootMetadata = {
  homeserver?: string;
  userId?: string;
  accountId?: string;
  accessTokenHash?: string;
  deviceId?: string | null;
  currentTokenStateClaimed?: boolean;
  createdAt?: string;
};

function resolveLegacyStoragePaths(env: NodeJS.ProcessEnv = process.env): {
  rootDir: string;
  storagePath: string;
  cryptoPath: string;
} {
  const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  return resolveMatrixLegacyFlatStoragePaths(stateDir);
}

function assertLegacyMigrationAccountSelection(params: { accountKey: string }): void {
  const cfg = getMatrixRuntime().config.current() as OpenClawConfig;
  if (!cfg.channels?.matrix || typeof cfg.channels.matrix !== "object") {
    return;
  }
  if (requiresExplicitMatrixDefaultAccount(cfg)) {
    throw new Error(
      "Legacy Matrix client storage cannot be migrated automatically because multiple Matrix accounts are configured and channels.matrix.defaultAccount is not set.",
    );
  }

  const selectedAccountId = normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg));
  const currentAccountId = normalizeAccountId(params.accountKey);
  if (selectedAccountId !== currentAccountId) {
    throw new Error(
      `Legacy Matrix client storage targets account "${selectedAccountId}", but the current client is starting account "${currentAccountId}". Start the selected account first so flat legacy storage is not migrated into the wrong account directory.`,
    );
  }
}

function scoreStorageRoot(rootDir: string): number {
  let score = 0;
  if (readStoredRootMetadata(rootDir).currentTokenStateClaimed === true) {
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
  if (fs.existsSync(path.join(rootDir, STORAGE_META_FILENAME))) {
    score += 1;
  }
  return score;
}

function resolveStorageRootMtimeMs(rootDir: string): number {
  try {
    return fs.statSync(rootDir).mtimeMs;
  } catch {
    return 0;
  }
}

function readStoredRootMetadata(rootDir: string): StoredRootMetadata {
  const metadata: StoredRootMetadata = {};

  const parsed = loadJsonFile<Partial<StoredRootMetadata>>(
    path.join(rootDir, STORAGE_META_FILENAME),
  );
  if (parsed) {
    if (typeof parsed.homeserver === "string" && parsed.homeserver.trim()) {
      metadata.homeserver = parsed.homeserver.trim();
    }
    if (typeof parsed.userId === "string" && parsed.userId.trim()) {
      metadata.userId = parsed.userId.trim();
    }
    if (typeof parsed.accountId === "string" && parsed.accountId.trim()) {
      metadata.accountId = parsed.accountId.trim();
    }
    if (typeof parsed.accessTokenHash === "string" && parsed.accessTokenHash.trim()) {
      metadata.accessTokenHash = parsed.accessTokenHash.trim();
    }
    if (typeof parsed.deviceId === "string" && parsed.deviceId.trim()) {
      metadata.deviceId = parsed.deviceId.trim();
    }
    if (parsed.currentTokenStateClaimed === true) {
      metadata.currentTokenStateClaimed = true;
    }
    if (typeof parsed.createdAt === "string" && parsed.createdAt.trim()) {
      metadata.createdAt = parsed.createdAt.trim();
    }
  }

  return metadata;
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
  const parentDir = path.dirname(params.canonicalRootDir);
  const bestCurrentScore = scoreStorageRoot(params.canonicalRootDir);
  let best = {
    rootDir: params.canonicalRootDir,
    tokenHash: params.canonicalTokenHash,
    score: bestCurrentScore,
    mtimeMs: resolveStorageRootMtimeMs(params.canonicalRootDir),
  };

  // Without a confirmed device identity, reusing a populated sibling root after
  // token rotation can silently bind this run to the wrong Matrix device state.
  if (!params.deviceId?.trim()) {
    return {
      rootDir: best.rootDir,
      tokenHash: best.tokenHash,
    };
  }

  const canonicalMetadata = readStoredRootMetadata(params.canonicalRootDir);
  if (
    canonicalMetadata.accessTokenHash === params.canonicalTokenHash &&
    canonicalMetadata.deviceId?.trim() === params.deviceId.trim() &&
    canonicalMetadata.currentTokenStateClaimed === true
  ) {
    return {
      rootDir: best.rootDir,
      tokenHash: best.tokenHash,
    };
  }

  let siblingEntries: fs.Dirent[];
  try {
    siblingEntries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return {
      rootDir: best.rootDir,
      tokenHash: best.tokenHash,
    };
  }

  for (const entry of siblingEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === params.canonicalTokenHash) {
      continue;
    }
    const candidateRootDir = path.join(parentDir, entry.name);
    if (
      !isCompatibleStorageRoot({
        candidateRootDir,
        homeserver: params.homeserver,
        userId: params.userId,
        accountKey: params.accountKey,
        deviceId: params.deviceId,
        // Once auth resolves a concrete device, only sibling roots that explicitly
        // declare that same device are safe to reuse across token rotations.
        requireExplicitDeviceMatch: Boolean(params.deviceId),
      })
    ) {
      continue;
    }
    const candidateScore = scoreStorageRoot(candidateRootDir);
    if (candidateScore <= 0) {
      continue;
    }
    const candidateMtimeMs = resolveStorageRootMtimeMs(candidateRootDir);
    if (
      candidateScore > best.score ||
      (best.rootDir !== params.canonicalRootDir &&
        candidateScore === best.score &&
        candidateMtimeMs > best.mtimeMs)
    ) {
      best = {
        rootDir: candidateRootDir,
        tokenHash: entry.name,
        score: candidateScore,
        mtimeMs: candidateMtimeMs,
      };
    }
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
    metaPath: path.join(rootDir, STORAGE_META_FILENAME),
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
  const legacy = resolveLegacyStoragePaths(params.env);
  const hasFlatLegacyStorageFile = fs.existsSync(legacy.storagePath);
  const hasAccountScopedLegacyStorageFile = fs.existsSync(params.storagePaths.storagePath);
  const syncCache =
    hasFlatLegacyStorageFile || hasAccountScopedLegacyStorageFile
      ? await import("./file-sync-store.js")
      : null;
  const hasFlatLegacyStorage =
    hasFlatLegacyStorageFile &&
    (await syncCache?.readLegacyMatrixSyncCacheState(legacy.rootDir)) !== null;
  const hasAccountScopedLegacyStorage =
    hasAccountScopedLegacyStorageFile &&
    (await syncCache?.readLegacyMatrixSyncCacheState(params.storagePaths.rootDir)) !== null;
  const hasLegacyCrypto = fs.existsSync(legacy.cryptoPath);
  const hasAccountScopedRecoveryKey = fs.existsSync(params.storagePaths.recoveryKeyPath);
  const hasAccountScopedIdbSnapshot = fs.existsSync(params.storagePaths.idbSnapshotPath);
  const hasAccountScopedLegacyCryptoMigration = fs.existsSync(
    path.join(params.storagePaths.rootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME),
  );
  if (
    !hasFlatLegacyStorage &&
    !hasAccountScopedLegacyStorage &&
    !hasLegacyCrypto &&
    !hasAccountScopedRecoveryKey &&
    !hasAccountScopedIdbSnapshot &&
    !hasAccountScopedLegacyCryptoMigration
  ) {
    return;
  }
  const hasTargetCrypto = fs.existsSync(params.storagePaths.cryptoPath);
  const shouldMigrateCrypto = hasLegacyCrypto && !hasTargetCrypto;
  if (
    !hasFlatLegacyStorage &&
    !hasAccountScopedLegacyStorage &&
    !shouldMigrateCrypto &&
    !hasAccountScopedRecoveryKey &&
    !hasAccountScopedIdbSnapshot &&
    !hasAccountScopedLegacyCryptoMigration
  ) {
    return;
  }

  if (hasFlatLegacyStorage || hasLegacyCrypto) {
    assertLegacyMigrationAccountSelection({
      accountKey: params.storagePaths.accountKey,
    });
  }

  const logger = getMatrixRuntime().logging.getChildLogger({ module: "matrix-storage" });
  const { maybeCreateMatrixMigrationSnapshot } = await import("./migration-snapshot.runtime.js");
  await maybeCreateMatrixMigrationSnapshot({
    trigger: "matrix-client-fallback",
    env: params.env,
    log: logger,
  });
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
    if (hasFlatLegacyStorage) {
      await migrateLegacySyncCacheToSqlite({
        sourceRootDir: legacy.rootDir,
        sourcePath: legacy.storagePath,
        targetRootDir: params.storagePaths.rootDir,
        label: "flat sync cache",
        moved,
        pendingArchives,
      });
    }
    if (shouldMigrateCrypto) {
      moveLegacyStoragePathOrThrow({
        sourcePath: legacy.cryptoPath,
        targetPath: params.storagePaths.cryptoPath,
        label: "crypto store",
        moved,
      });
    } else if (hasLegacyCrypto) {
      skippedExistingTargets.push(
        `- crypto store remains at ${legacy.cryptoPath} because ${params.storagePaths.cryptoPath} already exists`,
      );
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
    if (hasAccountScopedIdbSnapshot) {
      await migrateLegacyIdbSnapshotToSqlite({
        storageRootDir: params.storagePaths.rootDir,
        snapshotPath: params.storagePaths.idbSnapshotPath,
        moved,
        pendingArchives,
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
      `matrix: legacy client storage still exists in the flat path because some account-scoped targets already existed.\n${skippedExistingTargets.join("\n")}`,
    );
  }
}

async function migrateLegacyIdbSnapshotToSqlite(params: {
  storageRootDir: string;
  snapshotPath: string;
  moved: LegacyMoveRecord[];
  pendingArchives: LegacyArchiveRecord[];
}): Promise<void> {
  if (readMatrixIdbSnapshotJson(params.storageRootDir)) {
    params.pendingArchives.push({
      sourcePath: params.snapshotPath,
      label: "IndexedDB snapshot",
    });
    return;
  }
  const { readLegacyMatrixIdbSnapshotState } = await import("../sdk/idb-persistence.js");
  const snapshot = await readLegacyMatrixIdbSnapshotState(params.storageRootDir);
  if (!snapshot) {
    return;
  }
  writeMatrixIdbSnapshotJson({
    storageRootDir: params.storageRootDir,
    snapshotJson: JSON.stringify(snapshot),
    databaseCount: snapshot.length,
  });
  params.moved.push({
    sourcePath: params.snapshotPath,
    targetPath: `${params.storageRootDir} SQLite IndexedDB snapshot state`,
    label: "IndexedDB snapshot",
  });
  params.pendingArchives.push({
    sourcePath: params.snapshotPath,
    label: "IndexedDB snapshot",
  });
}

async function migrateLegacySyncCacheToSqlite(params: {
  sourceRootDir: string;
  sourcePath: string;
  targetRootDir: string;
  label: string;
  moved: LegacyMoveRecord[];
  pendingArchives: LegacyArchiveRecord[];
}): Promise<void> {
  const syncCache = await import("./file-sync-store.js");
  const persisted = await syncCache.readLegacyMatrixSyncCacheState(params.sourceRootDir);
  if (!persisted) {
    return;
  }
  const store = getMatrixRuntime().state.openKeyedStore<
    import("./file-sync-store.js").MatrixSyncCacheRecord
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

function moveLegacyStoragePathOrThrow(params: {
  sourcePath: string;
  targetPath: string;
  label: string;
  moved: LegacyMoveRecord[];
}): void {
  if (!fs.existsSync(params.sourcePath)) {
    return;
  }
  if (fs.existsSync(params.targetPath)) {
    throw new Error(
      `legacy Matrix ${params.label} target already exists (${params.targetPath}); refusing to overwrite it automatically`,
    );
  }
  fs.renameSync(params.sourcePath, params.targetPath);
  params.moved.push({
    sourcePath: params.sourcePath,
    targetPath: params.targetPath,
    label: params.label,
  });
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
  metaPath: string,
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
    saveJsonFile(metaPath, payload);
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
  return writeStoredRootMetadata(params.storagePaths.metaPath, {
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
  return writeStoredRootMetadata(path.join(params.rootDir, STORAGE_META_FILENAME), {
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
  return writeStoredRootMetadata(path.join(params.rootDir, STORAGE_META_FILENAME), {
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
