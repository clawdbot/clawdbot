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
import type { MatrixAuth } from "./types.js";
import type { MatrixStoragePaths } from "./types.js";

const DEFAULT_ACCOUNT_KEY = "default";
const STORAGE_META_FILENAME = "storage-meta.json";
const THREAD_BINDINGS_FILENAME = "thread-bindings.json";
const LEGACY_CRYPTO_MIGRATION_FILENAME = "legacy-crypto-migration.json";
const RECOVERY_KEY_FILENAME = "recovery-key.json";
const IDB_SNAPSHOT_FILENAME = "crypto-idb-snapshot.json";
const STARTUP_VERIFICATION_FILENAME = "startup-verification.json";

type LegacyMoveRecord = {
  sourcePath: string;
  targetPath: string;
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
  storagePath: string;
  cryptoPath: string;
} {
  const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  const legacy = resolveMatrixLegacyFlatStoragePaths(stateDir);
  return { storagePath: legacy.storagePath, cryptoPath: legacy.cryptoPath };
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
  if (fs.existsSync(path.join(rootDir, "bot-storage.json"))) {
    score += 8;
  }
  if (fs.existsSync(path.join(rootDir, "crypto"))) {
    score += 8;
  }
  if (fs.existsSync(path.join(rootDir, THREAD_BINDINGS_FILENAME))) {
    score += 4;
  }
  if (fs.existsSync(path.join(rootDir, LEGACY_CRYPTO_MIGRATION_FILENAME))) {
    score += 3;
  }
  if (fs.existsSync(path.join(rootDir, RECOVERY_KEY_FILENAME))) {
    score += 2;
  }
  if (fs.existsSync(path.join(rootDir, IDB_SNAPSHOT_FILENAME))) {
    score += 2;
  }
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

  const verification = loadJsonFile<{ deviceId?: unknown }>(
    path.join(rootDir, STARTUP_VERIFICATION_FILENAME),
  );
  if (
    !metadata.deviceId &&
    typeof verification?.deviceId === "string" &&
    verification.deviceId.trim()
  ) {
    metadata.deviceId = verification.deviceId.trim();
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

  let siblingEntries: fs.Dirent[] = [];
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
    recoveryKeyPath: path.join(rootDir, "recovery-key.json"),
    idbSnapshotPath: path.join(rootDir, IDB_SNAPSHOT_FILENAME),
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
  const hasLegacyStorage = fs.existsSync(legacy.storagePath);
  const hasLegacyCrypto = fs.existsSync(legacy.cryptoPath);
  if (!hasLegacyStorage && !hasLegacyCrypto) {
    return;
  }
  const hasTargetStorage = fs.existsSync(params.storagePaths.storagePath);
  const hasTargetCrypto = fs.existsSync(params.storagePaths.cryptoPath);
  // Continue partial migrations one artifact at a time; only skip items whose targets already exist.
  const shouldMigrateStorage = hasLegacyStorage && !hasTargetStorage;
  const shouldMigrateCrypto = hasLegacyCrypto && !hasTargetCrypto;
  if (!shouldMigrateStorage && !shouldMigrateCrypto) {
    return;
  }

  assertLegacyMigrationAccountSelection({
    accountKey: params.storagePaths.accountKey,
  });

  const logger = getMatrixRuntime().logging.getChildLogger({ module: "matrix-storage" });
  const { maybeCreateMatrixMigrationSnapshot } = await import("./migration-snapshot.runtime.js");
  await maybeCreateMatrixMigrationSnapshot({
    trigger: "matrix-client-fallback",
    env: params.env,
    log: logger,
  });
  fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
  const moved: LegacyMoveRecord[] = [];
  const skippedExistingTargets: string[] = [];
  try {
    if (shouldMigrateStorage) {
      moveLegacyStoragePathOrThrow({
        sourcePath: legacy.storagePath,
        targetPath: params.storagePaths.storagePath,
        label: "sync store",
        moved,
      });
    } else if (hasLegacyStorage) {
      skippedExistingTargets.push(
        `- sync store remains at ${legacy.storagePath} because ${params.storagePaths.storagePath} already exists`,
      );
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
  } catch (err) {
    const rollbackError = rollbackLegacyMoves(moved);
    throw new Error(
      rollbackError
        ? `Failed migrating legacy Matrix client storage: ${String(err)}. Rollback also failed: ${rollbackError}`
        : `Failed migrating legacy Matrix client storage: ${String(err)}`,
      { cause: err },
    );
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
