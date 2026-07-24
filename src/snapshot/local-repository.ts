import { randomUUID } from "node:crypto";
import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
import {
  canonicalPathFromExistingAncestor,
  ensureAbsoluteDirectory,
  isPathInside,
} from "../infra/fs-safe.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import {
  createPrivateSqliteDirectory,
  createPrivateSqliteTempDirectory,
  createVerifiedSqliteSnapshot,
  publishVerifiedSqliteFile,
  syncDirectoryBestEffort,
  type SqliteSnapshotValidator,
} from "../infra/sqlite-snapshot.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { runExec } from "../process/exec.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db.js";
import { assertOpenClawStateDatabaseForMaintenance } from "../state/openclaw-state-db.js";
import {
  sanitizeOpenClawGlobalStateSnapshot,
  sanitizeOpenClawStateLeaseRows,
} from "../state/openclaw-state-snapshot-sanitizer.js";
import {
  containsAsciiControlCharacter,
  copySnapshotArtifact,
  hashSnapshotArtifact,
  readSnapshotManifest,
  type SnapshotArtifactDigest,
  writeSnapshotManifest,
} from "./manifest.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotDatabaseIdentity,
  type SnapshotDatabaseManifest,
  type SnapshotDatabaseRef,
  type SnapshotManifest,
  type SnapshotRef,
  type SnapshotResult,
  type SnapshotSummary,
  type SnapshotVerificationResult,
  type SqliteSnapshotProvider,
} from "./snapshot-provider.js";

const SNAPSHOT_DIRECTORY_MODE = 0o700;
const SNAPSHOT_FILE_MODE = 0o600;
const SNAPSHOT_PENDING_FILENAME = ".pending";
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const SNAPSHOT_ARTIFACT_ENTRIES = new Set([
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_PENDING_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
]);
const RESTORE_STAGING_ENTRIES = new Set([SNAPSHOT_SQLITE_FILENAME]);
const VALIDATION_STAGING_ENTRIES = new Set([
  SNAPSHOT_SQLITE_FILENAME,
  ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${SNAPSHOT_SQLITE_FILENAME}${suffix}`),
]);
const MACOS_REPLACEMENT_ACL_PERMISSIONS = new Set([
  "add_file",
  "add_subdirectory",
  "chown",
  "delete",
  "delete_child",
  "writesecurity",
]);
const WINDOWS_STAGING_ACCESS_RIGHTS = new Set([
  "F",
  "M",
  "RX",
  "R",
  "W",
  "D",
  "DE",
  "RC",
  "WDAC",
  "WO",
  "AS",
  "MA",
  "GR",
  "GW",
  "GE",
  "GA",
  "RD",
  "WD",
  "AD",
  "REA",
  "WEA",
  "X",
  "DC",
  "RA",
  "WA",
  "UNKNOWN",
]);
const WINDOWS_STAGING_REPLACEMENT_RIGHTS = new Set([
  "F",
  "M",
  "D",
  "DE",
  "WDAC",
  "WO",
  "MA",
  "GA",
  "DC",
  "UNKNOWN",
]);
const WINDOWS_TRUSTED_OWNER_SIDS = new Set([
  "S-1-5-18", // LocalSystem
  "S-1-5-32-544", // Builtin Administrators
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", // TrustedInstaller
]);
const WINDOWS_TRUSTED_ACCESS_SIDS = new Set([
  ...WINDOWS_TRUSTED_OWNER_SIDS,
  "S-1-3-0", // Creator Owner resolves to the trusted creator on inherited ACEs.
]);
// Windows descriptors can approach 64 KiB each; batched JSON and base64 need
// bounded aggregate headroom across every ancestor.
const WINDOWS_ACL_METADATA_MAX_BUFFER = 16 * 1024 * 1024;
const WINDOWS_SID_PATTERN = /^S-\d+-\d+(?:-\d+)+$/iu;
const WINDOWS_SID_SCHEMA = z
  .string()
  .regex(WINDOWS_SID_PATTERN)
  .transform((value) => value.toUpperCase());
const WINDOWS_PRINCIPAL_SCHEMA = z
  .string()
  .min(1)
  .transform((value) => value.toUpperCase());
const WINDOWS_ACCESS_ENTRY_SCHEMA = z
  .object({
    principal: WINDOWS_PRINCIPAL_SCHEMA,
    accessType: z.enum(["Allow", "Deny"]),
    rightsMask: z.number().int().nonnegative().max(0xffffffff),
    inheritanceFlags: z.string(),
    propagationFlags: z.string(),
  })
  .strict();
const WINDOWS_PATH_SECURITY_SCHEMA = z
  .object({
    currentUserSid: WINDOWS_SID_SCHEMA,
    paths: z
      .array(
        z
          .object({
            path: z.string().min(1),
            ownerSid: WINDOWS_SID_SCHEMA,
            entries: z.array(WINDOWS_ACCESS_ENTRY_SCHEMA).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const WINDOWS_FILE_RIGHTS = [
  [0x000001, "RD"],
  [0x000002, "WD"],
  [0x000004, "AD"],
  [0x000008, "REA"],
  [0x000010, "WEA"],
  [0x000020, "X"],
  [0x000040, "DC"],
  [0x000080, "RA"],
  [0x000100, "WA"],
  [0x010000, "D"],
  [0x020000, "RC"],
  [0x040000, "WDAC"],
  [0x080000, "WO"],
  [0x100000, "S"],
  [0x02000000, "MA"],
  [0x10000000, "GA"],
  [0x20000000, "GE"],
  [0x40000000, "GW"],
  [0x80000000, "GR"],
] as const;
const WINDOWS_KNOWN_FILE_RIGHTS_MASK = WINDOWS_FILE_RIGHTS.reduce(
  (mask, [right]) => mask | right,
  0,
);
const WINDOWS_READ_RIGHTS_MASK =
  0x000001 | 0x000008 | 0x000020 | 0x000080 | 0x020000 | 0x10000000 | 0x20000000 | 0x80000000;
const WINDOWS_WRITE_RIGHTS_MASK =
  0x000002 |
  0x000004 |
  0x000010 |
  0x000040 |
  0x000100 |
  0x010000 |
  0x040000 |
  0x080000 |
  0x10000000 |
  0x40000000;
let macosTrustedAclPrincipalsPromise: Promise<ReadonlySet<string>> | undefined;

type WindowsAclEntry = {
  readonly principal: string;
  readonly rights: string[];
  readonly rawRights: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
};

type LocalSqliteSnapshotProviderOptions = {
  readonly allowedDatabaseRoles?: readonly SnapshotDatabaseIdentity["role"][];
  readonly repositoryPath: string;
  readonly validationRootPath?: string;
  readonly now?: () => Date;
};

export function createLocalSqliteSnapshotProvider(
  options: LocalSqliteSnapshotProviderOptions,
): SqliteSnapshotProvider {
  return new LocalSqliteSnapshotProvider(options);
}

class LocalSqliteSnapshotProvider implements SqliteSnapshotProvider {
  readonly #allowedDatabaseRoles: readonly SnapshotDatabaseIdentity["role"][] | undefined;
  readonly #repositoryPath: string;
  readonly #validationRootPath: string;
  readonly #now: () => Date;

  constructor(options: LocalSqliteSnapshotProviderOptions) {
    this.#allowedDatabaseRoles = options.allowedDatabaseRoles;
    this.#repositoryPath = path.resolve(options.repositoryPath);
    this.#validationRootPath = path.resolve(
      options.validationRootPath ?? path.dirname(this.#repositoryPath),
    );
    this.#now = options.now ?? (() => new Date());
  }

  async create(database: SnapshotDatabaseRef): Promise<SnapshotResult> {
    await ensurePrivateDirectory(this.#repositoryPath, "SQLite snapshot repository");
    const repositoryIdentity = await fs.lstat(this.#repositoryPath);
    const trustedRepositoryPath = await assertTrustedStagingRoot(
      repositoryIdentity,
      this.#repositoryPath,
    );
    const sourcePath = path.resolve(database.path);
    const identity = normalizeSnapshotIdentity(database.identity);
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("SQLite snapshot timestamp is invalid.");
    }
    const snapshotId = buildSnapshotId(now);
    const snapshotRefPath = path.join(this.#repositoryPath, snapshotId);
    const snapshotDir = path.join(trustedRepositoryPath, snapshotId);
    const stagingDir = path.join(trustedRepositoryPath, `.tmp-${randomUUID()}`);
    const artifactPath = path.join(stagingDir, SNAPSHOT_SQLITE_FILENAME);
    await assertDirectoryIdentity(trustedRepositoryPath, repositoryIdentity);
    await createPrivateSqliteDirectory(stagingDir);

    let stagingIdentity: Stats | undefined;
    let publishedDirectory: FileHandle | undefined;
    let publishedIdentity: Stats | undefined;
    const publishedEntries = new Map<string, Stats>();
    let snapshotDirectoryCreated = false;
    try {
      await assertDirectoryIdentity(trustedRepositoryPath, repositoryIdentity);
      stagingIdentity = await fs.lstat(stagingDir);
      applyPrivateModeSync(stagingDir, SNAPSHOT_DIRECTORY_MODE);
      await assertPrivateStagingDirectory(stagingIdentity, stagingDir);
      await assertDirectoryIdentity(trustedRepositoryPath, repositoryIdentity);
      const result = await createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath: artifactPath,
        requireNonEmptySource: identity.role !== "generic",
        transform:
          identity.role === "global"
            ? sanitizeOpenClawGlobalStateSnapshot
            : identity.role === "agent"
              ? sanitizeOpenClawStateLeaseRows
              : undefined,
        validate: buildDatabaseValidator(identity),
      });
      applyPrivateModeSync(artifactPath, SNAPSHOT_FILE_MODE);
      const artifact = await hashSnapshotArtifact(stagingDir);
      const manifest: SnapshotManifest = {
        schemaVersion: 1,
        snapshotId,
        createdAt: now.toISOString(),
        database: buildDatabaseManifest(identity, sourcePath, result.userVersion),
        artifact: {
          path: SNAPSHOT_SQLITE_FILENAME,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
        },
      };
      await writeSnapshotManifest(stagingDir, manifest);
      applyPrivateModeSync(path.join(stagingDir, SNAPSHOT_MANIFEST_FILENAME), SNAPSHOT_FILE_MODE);
      await readSnapshotManifest(stagingDir, snapshotId);
      await syncDirectoryBestEffort(stagingDir);

      await assertDirectoryIdentity(trustedRepositoryPath, repositoryIdentity);
      try {
        await createPrivateSqliteDirectory(snapshotDir);
        snapshotDirectoryCreated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`SQLite snapshot directory already exists: ${snapshotDir}`, {
            cause: error,
          });
        }
        throw error;
      }
      await assertDirectoryIdentity(trustedRepositoryPath, repositoryIdentity);
      publishedIdentity = await fs.lstat(snapshotDir);
      applyPrivateModeSync(snapshotDir, SNAPSHOT_DIRECTORY_MODE);
      await assertPrivateStagingDirectory(publishedIdentity, snapshotDir);
      publishedDirectory = await fs.open(snapshotDir, "r");
      await assertOpenDirectoryIdentity(publishedDirectory, snapshotDir, publishedIdentity);
      const pendingPath = path.join(snapshotDir, SNAPSHOT_PENDING_FILENAME);
      await fs.writeFile(pendingPath, "", {
        flag: "wx",
        mode: SNAPSHOT_FILE_MODE,
      });
      publishedEntries.set(SNAPSHOT_PENDING_FILENAME, await fs.lstat(pendingPath));
      await assertOpenDirectoryIdentity(publishedDirectory, snapshotDir, publishedIdentity);
      await publishSnapshotEntryNoOverwrite(
        path.join(stagingDir, SNAPSHOT_SQLITE_FILENAME),
        path.join(snapshotDir, SNAPSHOT_SQLITE_FILENAME),
        SNAPSHOT_SQLITE_FILENAME,
        publishedEntries,
      );
      await assertOpenDirectoryIdentity(publishedDirectory, snapshotDir, publishedIdentity);
      await publishSnapshotEntryNoOverwrite(
        path.join(stagingDir, SNAPSHOT_MANIFEST_FILENAME),
        path.join(snapshotDir, SNAPSHOT_MANIFEST_FILENAME),
        SNAPSHOT_MANIFEST_FILENAME,
        publishedEntries,
      );
      await assertOpenDirectoryIdentity(publishedDirectory, snapshotDir, publishedIdentity);
      await syncDirectoryBestEffort(snapshotDir);
      await assertPendingSnapshotContents(snapshotDir);
      const publishedManifest = await readSnapshotManifest(snapshotDir, snapshotId);
      if (!isDeepStrictEqual(publishedManifest, manifest)) {
        throw new Error(`SQLite snapshot manifest changed during publication: ${snapshotDir}`);
      }
      const publishedArtifact = await hashSnapshotArtifact(snapshotDir);
      const publishedArtifactPath = path.join(snapshotDir, SNAPSHOT_SQLITE_FILENAME);
      assertArtifactMatchesManifest(publishedArtifactPath, publishedArtifact, publishedManifest);
      await verifySnapshotDatabaseFile(
        publishedArtifactPath,
        publishedArtifact.stat,
        publishedManifest,
        trustedRepositoryPath,
      );
      const expectedPendingIdentity = publishedEntries.get(SNAPSHOT_PENDING_FILENAME);
      const currentPendingIdentity = fsSync.lstatSync(pendingPath);
      if (
        !expectedPendingIdentity ||
        !sameFileIdentity(expectedPendingIdentity, currentPendingIdentity)
      ) {
        throw new Error(`SQLite snapshot pending marker changed: ${pendingPath}`);
      }
      fsSync.unlinkSync(pendingPath);
      publishedEntries.delete(SNAPSHOT_PENDING_FILENAME);
      await syncDirectoryBestEffort(snapshotDir);
      await publishedDirectory.close();
      publishedDirectory = undefined;
      const committedManifest = await readSnapshotManifest(snapshotDir, snapshotId);
      if (!isDeepStrictEqual(committedManifest, manifest)) {
        throw new Error(`SQLite snapshot manifest changed after commit: ${snapshotDir}`);
      }
      const committedArtifact = await hashSnapshotArtifact(snapshotDir);
      assertArtifactMatchesManifest(
        path.join(snapshotDir, SNAPSHOT_SQLITE_FILENAME),
        committedArtifact,
        committedManifest,
      );
      const currentIdentity = await fs.lstat(snapshotDir);
      if (!sameFileIdentity(publishedIdentity, currentIdentity)) {
        throw new Error(`SQLite snapshot directory changed during publication: ${snapshotDir}`);
      }
      await assertExactSnapshotContents(snapshotDir);
      await assertDirectoryIdentity(trustedRepositoryPath, repositoryIdentity);
      await syncDirectoryBestEffort(trustedRepositoryPath);
      return { ref: { path: snapshotRefPath }, manifest };
    } catch (error) {
      await publishedDirectory?.close().catch(() => undefined);
      publishedDirectory = undefined;
      if (snapshotDirectoryCreated) {
        publishedIdentity ??= await fs.lstat(snapshotDir).catch(() => undefined);
      }
      if (publishedIdentity) {
        const removed = await removePublishedSnapshotDirectoryIfOwned(
          snapshotDir,
          publishedIdentity,
          publishedEntries,
        );
        if (removed) {
          await syncDirectoryBestEffort(trustedRepositoryPath);
        }
      }
      throw error;
    } finally {
      const removed = stagingIdentity
        ? await removePrivateDirectoryIfOwned(
            stagingDir,
            stagingIdentity,
            SNAPSHOT_ARTIFACT_ENTRIES,
          ).catch(() => false)
        : await fs
            .rmdir(stagingDir)
            .then(() => true)
            .catch(() => false);
      if (removed) {
        await syncDirectoryBestEffort(trustedRepositoryPath).catch(() => undefined);
      }
    }
  }

  async verify(snapshot: SnapshotRef): Promise<SnapshotVerificationResult> {
    const snapshotDir = await this.#resolveSnapshotDirectory(snapshot);
    const manifest = await readVerifiedSnapshotManifest(snapshotDir);
    assertAllowedDatabaseRole(manifest, this.#allowedDatabaseRoles);
    const artifact = await hashSnapshotArtifact(snapshotDir);
    const artifactPath = path.join(snapshotDir, SNAPSHOT_SQLITE_FILENAME);
    assertArtifactMatchesManifest(artifactPath, artifact, manifest);
    await verifySnapshotDatabaseFile(
      artifactPath,
      artifact.stat,
      manifest,
      this.#validationRootPath,
    );
    await assertExactSnapshotContents(snapshotDir);
    return { ok: true, manifest };
  }

  async restoreFresh(
    snapshot: SnapshotRef,
    targetPath: string,
  ): Promise<SnapshotVerificationResult> {
    const snapshotDir = await this.#resolveSnapshotDirectory(snapshot);
    const manifest = await readVerifiedSnapshotManifest(snapshotDir);
    assertAllowedDatabaseRole(manifest, this.#allowedDatabaseRoles);
    const resolvedTargetPath = path.resolve(targetPath);
    await assertFreshRestorePathsAbsent(resolvedTargetPath);
    const canonicalRepositoryPath = await fs.realpath(this.#repositoryPath);
    const canonicalRestoreParentPath = await canonicalPathFromExistingAncestor(
      path.dirname(resolvedTargetPath),
    );
    const canonicalTargetPath = path.join(
      canonicalRestoreParentPath,
      path.basename(resolvedTargetPath),
    );
    if (isPathInside(canonicalRepositoryPath, canonicalTargetPath)) {
      throw new Error(
        `SQLite restore target must be outside snapshot repository ${this.#repositoryPath}: ${resolvedTargetPath}`,
      );
    }
    const restoreParentPath = path.dirname(canonicalTargetPath);
    await ensureRestoreParentDirectory(restoreParentPath);
    const trustedRestoreParentPath = await fs.realpath(restoreParentPath);
    const trustedTargetPath = path.join(
      trustedRestoreParentPath,
      path.basename(resolvedTargetPath),
    );
    const targetPathChanged =
      !isPathInside(canonicalTargetPath, trustedTargetPath) ||
      !isPathInside(trustedTargetPath, canonicalTargetPath);
    if (targetPathChanged) {
      throw new Error(
        `SQLite restore target changed while creating its parent: ${resolvedTargetPath}`,
      );
    }
    if (isPathInside(canonicalRepositoryPath, trustedTargetPath)) {
      throw new Error(
        `SQLite restore target must be outside snapshot repository ${this.#repositoryPath}: ${resolvedTargetPath}`,
      );
    }
    const restoreParentIdentity = await fs.lstat(trustedRestoreParentPath);
    // Existing databases need a crash-recoverable main/WAL/SHM swap protocol.
    // This path is deliberately fresh-only and refuses every preexisting sidecar.
    await assertFreshRestorePathsAbsent(trustedTargetPath);

    return await withPrivateSqliteStagingDirectory({
      rootPath: trustedRestoreParentPath,
      expectedRootIdentity: restoreParentIdentity,
      prefix: ".tmp-restore-",
      allowedEntries: RESTORE_STAGING_ENTRIES,
      operation: async (stagingDir, stagingIdentity) => {
        const stagedSourcePath = path.join(stagingDir, SNAPSHOT_SQLITE_FILENAME);
        const stagedArtifact = await copySnapshotArtifact(snapshotDir, stagedSourcePath);
        await assertDirectoryIdentity(stagingDir, stagingIdentity);
        assertArtifactMatchesManifest(stagedSourcePath, stagedArtifact, manifest);
        await assertExactSnapshotContents(snapshotDir);
        await verifySnapshotDatabaseFile(
          stagedSourcePath,
          stagedArtifact.stat,
          manifest,
          trustedRestoreParentPath,
        );
        await publishVerifiedSqliteFile({
          sourceIdentity: stagedArtifact.stat,
          sourcePath: stagedSourcePath,
          targetPath: trustedTargetPath,
          expectedContent: manifest.artifact,
          requireAtomicPublication: true,
          beforePublish: async () => {
            await assertDirectoryIdentity(trustedRestoreParentPath, restoreParentIdentity);
            await assertFreshRestorePathsAbsent(trustedTargetPath);
          },
          afterPublish: (guard) => {
            guard.assertTargetMatchesExpectedContent(() => {
              assertDirectoryIdentitySync(trustedRestoreParentPath, restoreParentIdentity);
              assertNoSqliteSidecarsSync(trustedTargetPath);
            });
          },
        });
        return { ok: true, manifest };
      },
    });
  }

  async list(): Promise<SnapshotSummary[]> {
    const repositoryStat = await lstatIfExists(this.#repositoryPath);
    if (!repositoryStat) {
      return [];
    }
    assertDirectory(repositoryStat, this.#repositoryPath, "SQLite snapshot repository");

    const entries = await fs.readdir(this.#repositoryPath, { withFileTypes: true });
    const snapshots: SnapshotSummary[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".tmp-")) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new Error(
            `SQLite snapshot repository contains unsafe staging entry: ${path.join(this.#repositoryPath, entry.name)}`,
          );
        }
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(
          `SQLite snapshot repository contains unexpected entry: ${path.join(this.#repositoryPath, entry.name)}`,
        );
      }
      const snapshotPath = path.join(this.#repositoryPath, entry.name);
      if (await isIncompleteSnapshotDirectory(snapshotPath)) {
        continue;
      }
      await assertExactSnapshotContents(snapshotPath);
      const manifest = await readSnapshotManifest(snapshotPath);
      assertAllowedDatabaseRole(manifest, this.#allowedDatabaseRoles);
      snapshots.push({
        ref: { path: snapshotPath },
        manifest,
      });
    }
    return snapshots.toSorted(
      (left, right) =>
        right.manifest.createdAt.localeCompare(left.manifest.createdAt) ||
        right.manifest.snapshotId.localeCompare(left.manifest.snapshotId),
    );
  }

  async #resolveSnapshotDirectory(snapshot: SnapshotRef): Promise<string> {
    const snapshotDir = path.resolve(snapshot.path);
    if (path.dirname(snapshotDir) !== this.#repositoryPath) {
      throw new Error(
        `SQLite snapshot must be an immediate child of repository ${this.#repositoryPath}: ${snapshotDir}`,
      );
    }
    const repositoryStat = await fs.lstat(this.#repositoryPath);
    assertDirectory(repositoryStat, this.#repositoryPath, "SQLite snapshot repository");
    const snapshotStat = await fs.lstat(snapshotDir);
    assertDirectory(snapshotStat, snapshotDir, "SQLite snapshot");
    return snapshotDir;
  }
}

async function readVerifiedSnapshotManifest(snapshotDir: string): Promise<SnapshotManifest> {
  await assertExactSnapshotContents(snapshotDir);
  return await readSnapshotManifest(snapshotDir);
}

function assertArtifactMatchesManifest(
  artifactPath: string,
  artifact: SnapshotArtifactDigest,
  manifest: SnapshotManifest,
): void {
  if (artifact.sizeBytes !== manifest.artifact.sizeBytes) {
    throw new Error(
      `Snapshot artifact size mismatch for ${artifactPath}: expected ${manifest.artifact.sizeBytes}, got ${artifact.sizeBytes}`,
    );
  }
  if (artifact.sha256 !== manifest.artifact.sha256) {
    throw new Error(
      `Snapshot artifact hash mismatch for ${artifactPath}: expected ${manifest.artifact.sha256}, got ${artifact.sha256}`,
    );
  }
}

function assertAllowedDatabaseRole(
  manifest: SnapshotManifest,
  allowedRoles: readonly SnapshotDatabaseIdentity["role"][] | undefined,
): void {
  if (!allowedRoles || allowedRoles.includes(manifest.database.role)) {
    return;
  }
  throw new Error(
    `SQLite snapshot database role ${manifest.database.role} is not allowed for this operation.`,
  );
}

async function verifySnapshotDatabaseFile(
  artifactPath: string,
  expectedIdentity: Stats,
  manifest: SnapshotManifest,
  validationRootPath: string,
): Promise<void> {
  const beforeOpen = await fs.lstat(artifactPath);
  if (
    beforeOpen.isSymbolicLink() ||
    !beforeOpen.isFile() ||
    beforeOpen.nlink > 1 ||
    !sameFileIdentity(expectedIdentity, beforeOpen)
  ) {
    throw new Error(`Snapshot artifact changed before SQLite verification: ${artifactPath}`);
  }

  const validationRootIdentity = await fs.lstat(validationRootPath);
  assertDirectory(validationRootIdentity, validationRootPath, "SQLite validation root");
  await withPrivateSqliteStagingDirectory({
    rootPath: validationRootPath,
    expectedRootIdentity: validationRootIdentity,
    prefix: ".tmp-verify-",
    allowedEntries: VALIDATION_STAGING_ENTRIES,
    operation: async (validationDir) => {
      const validationPath = path.join(validationDir, SNAPSHOT_SQLITE_FILENAME);
      const validationArtifact = await copySnapshotArtifact(
        path.dirname(artifactPath),
        validationPath,
      );
      assertArtifactMatchesManifest(validationPath, validationArtifact, manifest);
      const sqlite = requireNodeSqlite();
      const database = new sqlite.DatabaseSync(validationPath, {
        allowExtension: true,
        readOnly: true,
      });
      try {
        database.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
        await loadSqliteVecExtension({ db: database });
        assertSqliteIntegrity(database, artifactPath);
        buildManifestDatabaseValidator(manifest.database)(database, artifactPath);
      } finally {
        database.close();
      }
      const validatedArtifact = await hashSnapshotArtifact(validationDir);
      if (!sameFileIdentity(validationArtifact.stat, validatedArtifact.stat)) {
        throw new Error(`Snapshot validation copy changed: ${validationPath}`);
      }
      assertArtifactMatchesManifest(validationPath, validatedArtifact, manifest);
    },
  });
  const afterOpen = await fs.lstat(artifactPath);
  if (
    afterOpen.isSymbolicLink() ||
    !afterOpen.isFile() ||
    afterOpen.nlink > 1 ||
    !sameFileIdentity(expectedIdentity, afterOpen)
  ) {
    throw new Error(`Snapshot artifact changed during SQLite verification: ${artifactPath}`);
  }
  const verifiedArtifact = await hashSnapshotArtifact(path.dirname(artifactPath));
  if (!sameFileIdentity(expectedIdentity, verifiedArtifact.stat)) {
    throw new Error(`Snapshot artifact changed after SQLite verification: ${artifactPath}`);
  }
  assertArtifactMatchesManifest(artifactPath, verifiedArtifact, manifest);
}

function normalizeSnapshotIdentity(identity: SnapshotDatabaseIdentity): SnapshotDatabaseIdentity {
  if (identity.role === "global") {
    return identity;
  }
  if (identity.role === "agent") {
    const agentId = normalizeAgentId(identity.agentId);
    if (!isValidAgentId(identity.agentId) || agentId !== identity.agentId) {
      throw new Error(`SQLite snapshot agent id must be canonical: ${identity.agentId}`);
    }
    return { role: "agent", agentId };
  }
  const id = identity.id.trim();
  if (!id || id !== identity.id || id.length > 256 || containsAsciiControlCharacter(id)) {
    throw new Error("SQLite snapshot generic database id is invalid.");
  }
  return { role: "generic", id };
}

function buildDatabaseManifest(
  identity: SnapshotDatabaseIdentity,
  sourcePath: string,
  userVersion: number,
): SnapshotDatabaseManifest {
  const basename = path.basename(sourcePath);
  if (identity.role === "global") {
    return { role: "global", basename, userVersion };
  }
  if (identity.role === "agent") {
    return { role: "agent", agentId: identity.agentId, basename, userVersion };
  }
  return { role: "generic", id: identity.id, basename, userVersion };
}

function buildDatabaseValidator(
  identity: SnapshotDatabaseIdentity | SnapshotDatabaseManifest,
): SqliteSnapshotValidator {
  if (identity.role === "global") {
    return (database, pathname) =>
      assertOpenClawStateDatabaseForMaintenance(database, { pathname });
  }
  if (identity.role === "agent") {
    return (database, pathname) =>
      assertOpenClawAgentDatabaseForMaintenance(database, {
        agentId: identity.agentId,
        pathname,
      });
  }
  return () => undefined;
}

function buildManifestDatabaseValidator(
  manifest: SnapshotDatabaseManifest,
): SqliteSnapshotValidator {
  const validateOwner = buildDatabaseValidator(manifest);
  return (database, pathname) => {
    validateOwner(database, pathname);
    const userVersion = readSqliteUserVersion(database);
    if (userVersion !== manifest.userVersion) {
      throw new Error(
        `Snapshot database user_version mismatch for ${pathname}: expected ${manifest.userVersion}, got ${userVersion}`,
      );
    }
  };
}

function buildSnapshotId(now: Date): string {
  const timestamp = now.toISOString().replaceAll(/[:.]/g, "-");
  return `${timestamp}-${randomUUID()}`;
}

async function ensurePrivateDirectory(directoryPath: string, scopeLabel: string): Promise<void> {
  if (process.platform === "win32") {
    const parentResult = await ensureAbsoluteDirectory(path.dirname(directoryPath), {
      mode: SNAPSHOT_DIRECTORY_MODE,
      scopeLabel,
    });
    if (!parentResult.ok) {
      throw parentResult.error;
    }
    try {
      await createPrivateSqliteDirectory(directoryPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  const result = await ensureAbsoluteDirectory(directoryPath, {
    mode: SNAPSHOT_DIRECTORY_MODE,
    scopeLabel,
  });
  if (!result.ok) {
    throw result.error;
  }
  applyPrivateModeSync(result.path, SNAPSHOT_DIRECTORY_MODE);
}

async function ensureRestoreParentDirectory(directoryPath: string): Promise<void> {
  const result = await ensureAbsoluteDirectory(directoryPath, {
    mode: SNAPSHOT_DIRECTORY_MODE,
    scopeLabel: "SQLite restore target",
  });
  if (!result.ok) {
    throw result.error;
  }
}

function assertDirectory(stat: Stats, pathname: string, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${pathname}`);
  }
}

async function assertDirectoryIdentity(
  directoryPath: string,
  expectedIdentity: Stats,
): Promise<void> {
  const currentIdentity = await fs.lstat(directoryPath);
  assertDirectory(currentIdentity, directoryPath, "SQLite staging directory");
  if (!sameFileIdentity(currentIdentity, expectedIdentity)) {
    throw new Error(`SQLite staging directory changed during operation: ${directoryPath}`);
  }
}

async function assertOpenDirectoryIdentity(
  handle: FileHandle,
  directoryPath: string,
  expectedIdentity: Stats,
): Promise<void> {
  const openedIdentity = await handle.stat();
  const currentIdentity = await fs.lstat(directoryPath);
  assertDirectory(openedIdentity, directoryPath, "SQLite snapshot directory");
  assertDirectory(currentIdentity, directoryPath, "SQLite snapshot directory");
  if (
    !sameFileIdentity(openedIdentity, expectedIdentity) ||
    !sameFileIdentity(currentIdentity, expectedIdentity)
  ) {
    throw new Error(`SQLite snapshot directory changed during publication: ${directoryPath}`);
  }
}

function assertDirectoryIdentitySync(directoryPath: string, expectedIdentity: Stats): void {
  const currentIdentity = fsSync.lstatSync(directoryPath);
  assertDirectory(currentIdentity, directoryPath, "SQLite staging directory");
  if (!sameFileIdentity(currentIdentity, expectedIdentity)) {
    throw new Error(`SQLite staging directory changed during operation: ${directoryPath}`);
  }
}

function isSnapshotEntryLinkFallbackError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EPERM" ||
    code === "EXDEV" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS"
  );
}

async function publishSnapshotEntryNoOverwrite(
  sourcePath: string,
  targetPath: string,
  entryName: string,
  publishedEntries: Map<string, Stats>,
): Promise<void> {
  let linked = false;
  let linkedSourceIdentity: Stats | undefined;
  try {
    linkedSourceIdentity = await fs.lstat(sourcePath);
    await fs.link(sourcePath, targetPath);
    publishedEntries.set(entryName, linkedSourceIdentity);
    linked = true;
  } catch (error) {
    if (!isSnapshotEntryLinkFallbackError(error)) {
      throw error;
    }
    const copiedIdentity = await copySnapshotEntryExclusive(sourcePath, targetPath);
    publishedEntries.set(entryName, copiedIdentity);
  }
  const expectedTargetIdentity = publishedEntries.get(entryName);
  const initialTargetIdentity = await fs.lstat(targetPath);
  if (!expectedTargetIdentity || !sameFileIdentity(expectedTargetIdentity, initialTargetIdentity)) {
    throw new Error(`SQLite snapshot entry changed during publication: ${targetPath}`);
  }
  if (linked) {
    if (!linkedSourceIdentity || !sameFileIdentity(linkedSourceIdentity, initialTargetIdentity)) {
      throw new Error(`SQLite snapshot entry changed during publication: ${targetPath}`);
    }
    const sourceIdentity = await fs.lstat(sourcePath);
    if (!sameFileIdentity(sourceIdentity, initialTargetIdentity)) {
      throw new Error(`SQLite snapshot entry changed during publication: ${targetPath}`);
    }
  }
  await fs.unlink(sourcePath);
  const finalTargetIdentity = await fs.lstat(targetPath);
  if (!sameFileIdentity(initialTargetIdentity, finalTargetIdentity)) {
    throw new Error(`SQLite snapshot entry changed after publication: ${targetPath}`);
  }
  publishedEntries.set(entryName, finalTargetIdentity);
}

async function copySnapshotEntryExclusive(sourcePath: string, targetPath: string): Promise<Stats> {
  const source = await fs.open(sourcePath, "r");
  let target: FileHandle | undefined;
  let targetIdentity: Stats | undefined;
  try {
    target = await fs.open(targetPath, "wx+", SNAPSHOT_FILE_MODE);
    targetIdentity = await target.stat();
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        const result = await target.write(
          buffer,
          bytesWritten,
          bytesRead - bytesWritten,
          offset + bytesWritten,
        );
        if (result.bytesWritten === 0) {
          throw new Error(`SQLite snapshot entry copy made no progress: ${targetPath}`);
        }
        bytesWritten += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await target.sync();
    const finalIdentity = await target.stat();
    const currentIdentity = await fs.lstat(targetPath);
    if (
      !sameFileIdentity(targetIdentity, finalIdentity) ||
      !sameFileIdentity(targetIdentity, currentIdentity)
    ) {
      throw new Error(`SQLite snapshot entry changed during copy: ${targetPath}`);
    }
    return finalIdentity;
  } catch (error) {
    if (targetIdentity) {
      const currentIdentity = await fs.lstat(targetPath).catch(() => undefined);
      if (currentIdentity && sameFileIdentity(currentIdentity, targetIdentity)) {
        await fs.unlink(targetPath).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function assertExactSnapshotContents(snapshotDir: string): Promise<void> {
  await assertSnapshotContents(
    snapshotDir,
    new Set([SNAPSHOT_MANIFEST_FILENAME, SNAPSHOT_SQLITE_FILENAME]),
  );
}

async function assertPendingSnapshotContents(snapshotDir: string): Promise<void> {
  await assertSnapshotContents(
    snapshotDir,
    new Set([SNAPSHOT_MANIFEST_FILENAME, SNAPSHOT_PENDING_FILENAME, SNAPSHOT_SQLITE_FILENAME]),
  );
}

async function assertSnapshotContents(snapshotDir: string, expected: Set<string>): Promise<void> {
  const entries = await fs.readdir(snapshotDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!expected.delete(entry.name)) {
      throw new Error(
        `SQLite snapshot contains unexpected entry: ${path.join(snapshotDir, entry.name)}`,
      );
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        `SQLite snapshot entry must be a regular file: ${path.join(snapshotDir, entry.name)}`,
      );
    }
    const stat = await fs.lstat(path.join(snapshotDir, entry.name));
    if (stat.nlink > 1) {
      throw new Error(
        `SQLite snapshot entry must not be hardlinked: ${path.join(snapshotDir, entry.name)}`,
      );
    }
  }
  if (expected.size > 0) {
    throw new Error(`SQLite snapshot is missing ${[...expected].join(", ")}: ${snapshotDir}`);
  }
}

async function isIncompleteSnapshotDirectory(snapshotDir: string): Promise<boolean> {
  const entries = await fs.readdir(snapshotDir, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has(SNAPSHOT_PENDING_FILENAME)) {
    return true;
  }
  if (names.has(SNAPSHOT_MANIFEST_FILENAME)) {
    return false;
  }
  return entries.length === 0;
}

async function assertFreshRestorePathsAbsent(databasePath: string): Promise<void> {
  for (const candidate of [
    databasePath,
    ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${databasePath}${suffix}`),
  ]) {
    if (await lstatIfExists(candidate)) {
      throw new Error(`Fresh SQLite restore path already exists: ${candidate}`);
    }
  }
}

function assertNoSqliteSidecarsSync(databasePath: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${databasePath}${suffix}`;
    try {
      fsSync.lstatSync(sidecarPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    throw new Error(`Restored SQLite database has unexpected sidecar: ${sidecarPath}`);
  }
}

async function lstatIfExists(pathname: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function removePrivateDirectoryIfOwned(
  directoryPath: string,
  expectedIdentity: Stats,
  allowedEntries: ReadonlySet<string>,
): Promise<boolean> {
  const currentIdentity = await lstatIfExists(directoryPath);
  if (!currentIdentity) {
    return false;
  }
  if (
    currentIdentity.isSymbolicLink() ||
    !currentIdentity.isDirectory() ||
    !sameFileIdentity(currentIdentity, expectedIdentity)
  ) {
    throw new Error(`Private SQLite staging directory changed before cleanup: ${directoryPath}`);
  }
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const verifiedPaths: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (!allowedEntries.has(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Private SQLite staging directory has unexpected entry: ${entryPath}`);
    }
    const stat = await fs.lstat(entryPath);
    if (stat.nlink > 1) {
      throw new Error(`Private SQLite staging file must not be hardlinked: ${entryPath}`);
    }
    verifiedPaths.push(entryPath);
  }
  await Promise.all(verifiedPaths.map(async (entryPath) => await fs.unlink(entryPath)));
  await fs.rmdir(directoryPath);
  return true;
}

async function withPrivateSqliteStagingDirectory<T>(options: {
  rootPath: string;
  expectedRootIdentity: Stats;
  prefix: string;
  allowedEntries: ReadonlySet<string>;
  operation: (directoryPath: string, directoryIdentity: Stats) => Promise<T>;
}): Promise<T> {
  const trustedRootPath = await assertTrustedStagingRoot(
    options.expectedRootIdentity,
    options.rootPath,
  );
  await assertDirectoryIdentity(trustedRootPath, options.expectedRootIdentity);
  const directoryPath = await createPrivateSqliteTempDirectory(trustedRootPath, options.prefix);
  const directoryIdentity = await fs.lstat(directoryPath);

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    applyPrivateModeSync(directoryPath, SNAPSHOT_DIRECTORY_MODE);
    await assertPrivateStagingDirectory(directoryIdentity, directoryPath);
    await assertDirectoryIdentity(trustedRootPath, options.expectedRootIdentity);
    outcome = {
      ok: true,
      value: await options.operation(directoryPath, directoryIdentity),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let cleanupOutcome: { ok: true } | { ok: false; error: unknown };
  try {
    const removed = await removePrivateDirectoryIfOwned(
      directoryPath,
      directoryIdentity,
      options.allowedEntries,
    );
    if (!removed) {
      throw new Error(`Private SQLite staging directory disappeared: ${directoryPath}`);
    }
    cleanupOutcome = { ok: true };
  } catch (error) {
    cleanupOutcome = { ok: false, error };
  }

  if (!cleanupOutcome.ok) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, cleanupOutcome.error],
        `SQLite staging operation and cleanup both failed: ${directoryPath}`,
      );
    }
    throw new Error(`Failed to clean private SQLite staging directory: ${directoryPath}`, {
      cause: cleanupOutcome.error,
    });
  }
  await syncDirectoryBestEffort(trustedRootPath).catch(() => undefined);
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

async function assertTrustedStagingRoot(
  expectedIdentity: Stats,
  rootPath: string,
): Promise<string> {
  const resolvedRootPath = path.resolve(rootPath);
  const trustedRootPath = await fs.realpath(resolvedRootPath);
  const rootIdentity = await fs.lstat(trustedRootPath);
  assertDirectory(rootIdentity, trustedRootPath, "Private SQLite staging root");
  if (!sameFileIdentity(rootIdentity, expectedIdentity)) {
    throw new Error(`Private SQLite staging root changed during operation: ${resolvedRootPath}`);
  }
  if (process.platform === "win32") {
    await assertTrustedWindowsStagingPath(trustedRootPath);
    return trustedRootPath;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined || rootIdentity.uid !== uid || (rootIdentity.mode & 0o022) !== 0) {
    throw new Error(
      `Private SQLite staging root must be owned by the current user and not writable by other users: ${resolvedRootPath}`,
    );
  }
  if (process.platform === "darwin") {
    await assertTrustedMacosAcl(trustedRootPath, true);
  }
  await assertTrustedPosixStagingAncestors(trustedRootPath, rootIdentity, uid);
  return trustedRootPath;
}

async function assertPrivateStagingDirectory(
  expectedIdentity: Stats,
  directoryPath: string,
): Promise<void> {
  const currentIdentity = await fs.lstat(directoryPath);
  assertDirectory(currentIdentity, directoryPath, "Private SQLite staging directory");
  if (!sameFileIdentity(currentIdentity, expectedIdentity)) {
    throw new Error(`Private SQLite staging directory changed during operation: ${directoryPath}`);
  }
  if (process.platform === "win32") {
    // The parent root was already checked for private and inherit-only ACEs.
    // An untrusted principal cannot alter or replace children beneath that root.
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined || currentIdentity.uid !== uid || (currentIdentity.mode & 0o077) !== 0) {
    throw new Error(`Private SQLite staging directory permissions are unsafe: ${directoryPath}`);
  }
  if (process.platform === "darwin") {
    await assertTrustedMacosAcl(directoryPath, true);
  }
}

async function assertTrustedPosixStagingAncestors(
  rootPath: string,
  rootIdentity: Stats,
  uid: number,
): Promise<void> {
  // A private root is still replaceable when one of its ancestors is writable
  // by another user. Sticky directories are safe only for user-owned children.
  let childIdentity = rootIdentity;
  let currentPath = path.dirname(rootPath);
  while (currentPath !== rootPath) {
    const currentIdentity = await fs.lstat(currentPath);
    assertDirectory(currentIdentity, currentPath, "SQLite staging ancestor");
    const writableByOtherUsers = (currentIdentity.mode & 0o022) !== 0;
    const ownerCanReplaceChild = currentIdentity.uid !== uid && currentIdentity.uid !== 0;
    const stickyOwnerIsTrusted = currentIdentity.uid === uid || currentIdentity.uid === 0;
    const stickyProtectsChild =
      (currentIdentity.mode & 0o1000) !== 0 && stickyOwnerIsTrusted && childIdentity.uid === uid;
    if (ownerCanReplaceChild || (writableByOtherUsers && !stickyProtectsChild)) {
      throw new Error(
        `SQLite staging ancestor must not allow another user to replace its child: ${currentPath}`,
      );
    }
    if (process.platform === "darwin") {
      await assertTrustedMacosAcl(currentPath, false);
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return;
    }
    childIdentity = currentIdentity;
    currentPath = parentPath;
  }
}

type MacosAclEntry = {
  effect: "allow" | "deny";
  permissions: ReadonlySet<string>;
  principal: string;
};

function parseMacosAclEntries(output: string, pathname: string): MacosAclEntry[] {
  const lines = output.split(/\r?\n/u);
  const header = lines.shift();
  if (!header) {
    throw new Error(`Unable to inspect macOS ACL for SQLite staging: ${pathname}`);
  }
  const entries: MacosAclEntry[] = [];
  for (const line of lines) {
    if (!/^\s*\d+:\s/u.test(line)) {
      continue;
    }
    const match = line.match(/^\s*\d+:\s+(.+?)\s+(?:inherited\s+)?(allow|deny)\s+([a-z_,]+)\s*$/u);
    if (!match) {
      throw new Error(`Unable to parse macOS ACL for SQLite staging: ${pathname}`);
    }
    const [, principal, effect, permissions] = match;
    if (!principal || !permissions || (effect !== "allow" && effect !== "deny")) {
      throw new Error(`Unable to parse macOS ACL for SQLite staging: ${pathname}`);
    }
    entries.push({
      principal: normalizeAclPrincipal(principal),
      effect,
      permissions: new Set(permissions.split(",")),
    });
  }
  if (/^[^\s]{10}\+/u.test(header) && entries.length === 0) {
    throw new Error(`Unable to parse macOS ACL for SQLite staging: ${pathname}`);
  }
  return entries;
}

function normalizeAclPrincipal(principal: string): string {
  return principal.trim().toLowerCase();
}

async function resolveTrustedMacosAclPrincipals(): Promise<ReadonlySet<string>> {
  macosTrustedAclPrincipalsPromise ??= (async () => {
    const dsmemberutil = resolveSystemBin("dsmemberutil");
    if (!dsmemberutil) {
      throw new Error("Unable to resolve dsmemberutil for macOS ACL verification.");
    }
    const currentUsername = os.userInfo().username;
    const usernames = new Set([currentUsername, "root"]);
    const trusted = new Set<string>();
    for (const username of usernames) {
      const { stdout } = await runExec(dsmemberutil, ["getuuid", "-U", username], {
        timeoutMs: 5_000,
        maxBuffer: 64 * 1024,
      });
      const uuid = stdout.trim();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(uuid)) {
        throw new Error(`Unable to resolve trusted macOS ACL principal for ${username}.`);
      }
      trusted.add(normalizeAclPrincipal(uuid));
      trusted.add(normalizeAclPrincipal(username));
      trusted.add(normalizeAclPrincipal(`user:${username}`));
    }
    return trusted;
  })();
  return await macosTrustedAclPrincipalsPromise;
}

async function assertTrustedMacosAcl(pathname: string, requirePrivate: boolean): Promise<void> {
  const ls = resolveSystemBin("ls");
  if (!ls) {
    throw new Error(`Unable to verify macOS ACL for SQLite staging: ${pathname}`);
  }
  let entries: MacosAclEntry[];
  try {
    const [result, trustedPrincipals] = await Promise.all([
      runExec(ls, ["-lden", "--", pathname], {
        timeoutMs: 5_000,
        maxBuffer: 1024 * 1024,
      }),
      resolveTrustedMacosAclPrincipals(),
    ]);
    entries = parseMacosAclEntries(result.stdout, pathname).filter(
      (entry) => !trustedPrincipals.has(entry.principal),
    );
  } catch (error) {
    throw new Error(`Unable to verify macOS ACL for SQLite staging: ${pathname}`, {
      cause: error,
    });
  }
  const unsafeEntry = entries.find(
    (entry) =>
      entry.effect === "allow" &&
      (requirePrivate ||
        [...entry.permissions].some((permission) =>
          MACOS_REPLACEMENT_ACL_PERMISSIONS.has(permission),
        )),
  );
  if (unsafeEntry) {
    throw new Error(`macOS ACL permits untrusted SQLite staging access: ${pathname}`);
  }
}

async function assertTrustedWindowsStagingPath(rootPath: string): Promise<void> {
  const paths = [rootPath];
  let currentPath = path.dirname(rootPath);
  while (currentPath !== rootPath) {
    paths.push(currentPath);
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }
  let security: z.infer<typeof WINDOWS_PATH_SECURITY_SCHEMA>;
  try {
    security = await inspectWindowsPathSecurity(paths);
  } catch {
    throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${rootPath}`);
  }
  if (security.paths.length !== paths.length) {
    throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${rootPath}`);
  }
  for (const [index, pathname] of paths.entries()) {
    const pathSecurity = security.paths[index];
    if (!pathSecurity || path.resolve(pathSecurity.path) !== path.resolve(pathname)) {
      throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${pathname}`);
    }
    assertTrustedWindowsAcl(pathname, index === 0, security.currentUserSid, pathSecurity);
  }
}

function assertTrustedWindowsAcl(
  pathname: string,
  requirePrivate: boolean,
  currentUserSid: string,
  security: z.infer<typeof WINDOWS_PATH_SECURITY_SCHEMA>["paths"][number],
): void {
  if (security.ownerSid !== currentUserSid && !WINDOWS_TRUSTED_OWNER_SIDS.has(security.ownerSid)) {
    throw new Error(`Windows staging path is owned by an untrusted principal: ${pathname}`);
  }
  const allowedEntries = security.entries.filter((entry) => entry.accessType === "Allow");
  if (allowedEntries.length === 0) {
    throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${pathname}`);
  }
  const unsafeEntries = allowedEntries
    .filter(
      (entry) =>
        entry.principal !== currentUserSid && !WINDOWS_TRUSTED_ACCESS_SIDS.has(entry.principal),
    )
    .map(windowsSecurityEntryToAclEntry)
    .filter((entry) => windowsAclEntryPermitsUnsafeStagingAccess(entry, requirePrivate));
  if (unsafeEntries.length > 0) {
    throw new Error(`Windows ACL permits untrusted SQLite staging access: ${pathname}`);
  }
}

function windowsSecurityEntryToAclEntry(
  entry: z.infer<typeof WINDOWS_ACCESS_ENTRY_SCHEMA>,
): WindowsAclEntry {
  const rights: string[] = WINDOWS_FILE_RIGHTS.filter(
    ([right]) => (entry.rightsMask & right) !== 0,
  ).map(([, name]) => name);
  if ((entry.rightsMask & ~WINDOWS_KNOWN_FILE_RIGHTS_MASK) !== 0) {
    rights.push("UNKNOWN");
  }
  const inheritanceFlags = new Set(entry.inheritanceFlags.split(",").map((flag) => flag.trim()));
  const propagationFlags = new Set(entry.propagationFlags.split(",").map((flag) => flag.trim()));
  const rawFlags = [
    inheritanceFlags.has("ObjectInherit") ? "(OI)" : "",
    inheritanceFlags.has("ContainerInherit") ? "(CI)" : "",
    propagationFlags.has("NoPropagateInherit") ? "(NP)" : "",
    propagationFlags.has("InheritOnly") ? "(IO)" : "",
  ].join("");
  return {
    principal: entry.principal,
    rights,
    rawRights: `${rawFlags}(${rights.join(",")})`,
    canRead: (entry.rightsMask & WINDOWS_READ_RIGHTS_MASK) !== 0,
    canWrite: (entry.rightsMask & WINDOWS_WRITE_RIGHTS_MASK) !== 0,
  };
}

function windowsAclEntryPermitsUnsafeStagingAccess(
  entry: WindowsAclEntry,
  requirePrivate: boolean,
): boolean {
  // Inherit-only ACEs on ordinary ancestors are covered when the protected
  // root is inspected. Private roots must also reject rights inherited by files.
  if (!requirePrivate && /\(IO\)/iu.test(entry.rawRights)) {
    return false;
  }
  const rights = entry.rights.map((right) => right.toUpperCase());
  const unsafeRights = requirePrivate
    ? WINDOWS_STAGING_ACCESS_RIGHTS
    : WINDOWS_STAGING_REPLACEMENT_RIGHTS;
  return (
    (requirePrivate && (entry.canWrite || entry.canRead)) ||
    rights.some((right) => unsafeRights.has(right))
  );
}

async function inspectWindowsPathSecurity(
  pathnames: readonly string[],
): Promise<z.infer<typeof WINDOWS_PATH_SECURITY_SCHEMA>> {
  const encodedPaths = Buffer.from(JSON.stringify(pathnames), "utf8").toString("base64");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$paths = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}')))`,
    "$pathSecurity = @($paths | ForEach-Object { $path = [string]$_; $acl = Get-Acl -LiteralPath $path; $entries = @($acl.Access | ForEach-Object { $identity = $_.IdentityReference; try { $principal = $identity.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $principal = [string]$identity.Value }; $rightsMask = ([int64][int32]$_.FileSystemRights) -band 0xffffffffL; [pscustomobject]@{ principal = $principal; accessType = [string]$_.AccessControlType; rightsMask = $rightsMask; inheritanceFlags = [string]$_.InheritanceFlags; propagationFlags = [string]$_.PropagationFlags } }); [pscustomobject]@{ path = $path; ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; entries = $entries } })",
    "$payload = [pscustomobject]@{ currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; paths = $pathSecurity }",
    "$json = ConvertTo-Json -InputObject $payload -Compress -Depth 4",
    "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))",
  ].join("; ");
  const stdout = await runEncodedWindowsPowerShell(command, WINDOWS_ACL_METADATA_MAX_BUFFER);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(stdout.trim(), "base64").toString("utf8"));
  } catch (error) {
    throw new Error("Unable to parse Windows ACL metadata.", { cause: error });
  }
  const result = WINDOWS_PATH_SECURITY_SCHEMA.safeParse(parsed);
  if (!result.success) {
    throw new Error("Invalid Windows ACL metadata.", { cause: result.error });
  }
  return result.data;
}

async function runEncodedWindowsPowerShell(command: string, maxBuffer: number): Promise<string> {
  const powershell = resolveSystemBin("powershell");
  if (!powershell) {
    throw new Error("Unable to resolve PowerShell for Windows SQLite path security.");
  }
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  const { stdout } = await runExec(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    {
      timeoutMs: 10_000,
      maxBuffer,
    },
  );
  return stdout;
}

async function removePublishedSnapshotDirectoryIfOwned(
  directoryPath: string,
  expectedIdentity: Stats,
  publishedEntries: ReadonlyMap<string, Stats>,
): Promise<boolean> {
  const currentIdentity = await lstatIfExists(directoryPath);
  if (
    !currentIdentity ||
    currentIdentity.isSymbolicLink() ||
    !currentIdentity.isDirectory() ||
    !sameFileIdentity(currentIdentity, expectedIdentity)
  ) {
    return false;
  }
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const expectedEntryIdentity = publishedEntries.get(entry.name);
    if (!expectedEntryIdentity || entry.isSymbolicLink() || !entry.isFile()) {
      continue;
    }
    const entryPath = path.join(directoryPath, entry.name);
    const currentEntryIdentity = await fs.lstat(entryPath);
    if (sameFileIdentity(currentEntryIdentity, expectedEntryIdentity)) {
      await fs.unlink(entryPath);
    }
  }
  if ((await fs.readdir(directoryPath)).length > 0) {
    return false;
  }
  await fs.rmdir(directoryPath);
  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
