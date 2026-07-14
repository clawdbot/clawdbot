import { randomUUID } from "node:crypto";
import { constants as fsConstants, createWriteStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import {
  cellAuthSecretDir,
  cellNetworkName,
  FLEET_ATTEMPT_LABEL,
  validateCellContainerProfile,
  type CellContainerProfile,
} from "./cell-profile.js";
import type { FleetContainerRuntime } from "./containers.runtime.js";
import type { FleetCellRecord } from "./registry.js";
import {
  assertManagedInspection,
  assertManagedNetwork,
  buildProfileBaseFromInspection,
  prepareCellConfig,
  prepareCellDirectories,
  requireInspectedAttemptId,
  requireInspectedGatewayToken,
  resolveContainerUser,
  resolvePurgeTarget,
  verifyReplacementHealthy,
  type HostIdentity,
} from "./service-support.runtime.js";

const DEFAULT_FLEET_BACKUP_MAX_BYTES = 16 * 1024 ** 3;
// Byte caps alone do not stop metadata-only archive bombs: millions of empty
// files stay under --max-bytes but can exhaust host inodes during extraction.
const FLEET_BACKUP_MAX_ENTRIES = 1_000_000;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
// Well under the 5-minute lease TTL so a stalled archive stream cannot outlive
// the lease by more than one probe interval before the backup aborts.
const BACKUP_LEASE_PROBE_INTERVAL_MS = 30_000;
const RESTORE_VERIFY_TIMEOUT_MS = 60_000;
const RESTORE_VERIFY_POLL_MS = 1_000;

type BackupLinkCacheKey = `${number}:${number}`;

class BackupLinkCache extends Map<BackupLinkCacheKey, string> {
  override get(_key: BackupLinkCacheKey): undefined {
    return undefined;
  }

  override set(_key: BackupLinkCacheKey, _value: string): this {
    return this;
  }
}

type FleetBackupManifest = {
  schemaVersion: 1;
  kind: "openclaw-fleet-cell-backup";
  tenant: string;
  createdAt: string;
  hostPort: number;
  image: string;
  runtime: "docker" | "podman";
};

type FleetBackupResult = {
  tenant: string;
  archivePath: string;
  fileCount: number;
  skippedSymlinks: number;
  skippedSpecial: number;
  note: string;
};

type FleetRestoreResult = {
  tenant: string;
  archivePath: string;
  token: string;
  tokenNote: string;
  started: boolean;
  url: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampBasename(tenant: string, nowMs: number): string {
  const stamp = new Date(nowMs)
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/u, "Z");
  return `openclaw-fleet-backup-${tenant}-${stamp}.tgz`;
}

async function resolveOutputPath(out: string | undefined, basename: string): Promise<string> {
  if (!out) {
    return path.resolve(process.cwd(), basename);
  }
  const resolved = path.resolve(out);
  if (out.endsWith(path.sep) || out.endsWith("/") || out.endsWith("\\")) {
    return path.join(resolved, basename);
  }
  try {
    return (await fs.stat(resolved)).isDirectory() ? path.join(resolved, basename) : resolved;
  } catch {
    return resolved;
  }
}

async function canonicalizeForContainment(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let probe = resolved;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      return path.join(real, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function remapArchivePath(
  entryPath: string,
  manifestPath: string,
  dataTarget: string,
  authTarget: string,
): string {
  const resolved = path.resolve(entryPath);
  if (resolved === manifestPath) {
    return "manifest.json";
  }
  if (isWithin(resolved, dataTarget)) {
    const relative = path.relative(dataTarget, resolved).split(path.sep).join(path.posix.sep);
    return relative ? path.posix.join("data", relative) : "data";
  }
  if (isWithin(resolved, authTarget)) {
    const relative = path.relative(authTarget, resolved).split(path.sep).join(path.posix.sep);
    return relative ? path.posix.join("auth", relative) : "auth";
  }
  throw new Error(`Fleet backup encountered a path outside the cell roots: ${entryPath}`);
}

export async function backupFleetCell(params: {
  record: FleetCellRecord;
  stateDir: string;
  containers: FleetContainerRuntime;
  now: () => number;
  checkpoint: () => void;
  out?: string;
  maxBytes?: number;
  maxEntries?: number;
}): Promise<FleetBackupResult> {
  await params.containers.assertLocal(params.record.runtime);
  const inspection = await params.containers.inspect(
    params.record.runtime,
    params.record.containerName,
  );
  if (inspection.kind === "unavailable") {
    throw new Error(
      `Cannot inspect ${params.record.runtime} container for tenant ${params.record.tenantId}: ${inspection.error}`,
    );
  }
  if (inspection.kind === "ok") {
    assertManagedInspection(params.record, inspection);
    if (inspection.running) {
      throw new Error(
        `Fleet cell ${params.record.tenantId} is running; stop it first (openclaw fleet stop ${params.record.tenantId}) so SQLite state is captured consistently.`,
      );
    }
  }

  const dataTarget = await resolvePurgeTarget(
    path.join(params.stateDir, "fleet", "cells"),
    params.record.dataDir,
    params.record.tenantId,
  );
  if (!dataTarget) {
    throw new Error(`Fleet cell ${params.record.tenantId} has no cell data to back up.`);
  }
  const authTarget = await resolvePurgeTarget(
    path.join(params.stateDir, "fleet", "auth-profile-secrets"),
    cellAuthSecretDir(params.stateDir, params.record.tenantId),
    params.record.tenantId,
  );
  // Refuse auth-less backups: restore requires the auth tree, and an archive
  // without it could later replace a cell's auth-profile encryption keys with
  // an empty directory.
  if (!authTarget) {
    throw new Error(
      `Fleet cell ${params.record.tenantId} has no auth-secret directory to back up.`,
    );
  }
  const nowMs = params.now();
  const archivePath = await resolveOutputPath(
    params.out,
    timestampBasename(params.record.tenantId, nowMs),
  );
  const canonicalOutput = await canonicalizeForContainment(archivePath);
  const roots = [dataTarget, authTarget];
  if (roots.some((root) => isWithin(canonicalOutput, root))) {
    throw new Error(
      "Fleet backup output must not be written inside the cell data or auth directory.",
    );
  }
  try {
    await fs.lstat(archivePath);
    throw new Error(`Refusing to overwrite existing fleet backup archive: ${archivePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  const tempArchivePath = `${archivePath}.${randomUUID()}.tmp`;
  const tempRoot = await fs.realpath(os.tmpdir());
  const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-fleet-backup-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const manifest: FleetBackupManifest = {
    schemaVersion: 1,
    kind: "openclaw-fleet-cell-backup",
    tenant: params.record.tenantId,
    createdAt: new Date(nowMs).toISOString(),
    hostPort: params.record.hostPort,
    image: params.record.image,
    runtime: params.record.runtime,
  };
  let fileCount = 0;
  let skippedSymlinks = 0;
  let skippedSpecial = 0;
  let totalBytes = 0;
  let totalEntries = 0;
  let exceeded = false;
  let tooManyEntries = false;
  let leaseLost = false;
  let unrestorablePath: string | undefined;
  let lastLeaseProbeMs = params.now();
  const maxBytes = params.maxBytes ?? DEFAULT_FLEET_BACKUP_MAX_BYTES;
  const maxEntries = params.maxEntries ?? FLEET_BACKUP_MAX_ENTRIES;
  try {
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const filter = (entryPath: string, stat: Stats | tar.ReadEntry): boolean => {
      if (exceeded || tooManyEntries || leaseLost) {
        return false;
      }
      // Probe the mutation lease during long archive streams so a lost lease
      // (another operation could start the cell mid-read) aborts the backup
      // instead of publishing a possibly-torn archive. node-tar filters run
      // from async callbacks, so record the loss and throw after tar settles.
      if (params.now() - lastLeaseProbeMs >= BACKUP_LEASE_PROBE_INTERVAL_MS) {
        lastLeaseProbeMs = params.now();
        try {
          params.checkpoint();
        } catch {
          leaseLost = true;
          return false;
        }
      }
      const type = "type" in stat ? stat.type : undefined;
      const isSymlink = "isSymbolicLink" in stat ? stat.isSymbolicLink() : type === "SymbolicLink";
      if (isSymlink) {
        skippedSymlinks += 1;
        return false;
      }
      const isFile = "isFile" in stat ? stat.isFile() : type === "File";
      const isDirectory = "isDirectory" in stat ? stat.isDirectory() : type === "Directory";
      if (!isFile && !isDirectory) {
        skippedSpecial += 1;
        return false;
      }
      // Validate and budget with the same path rules restore applies, so every
      // archive backup accepts stays restorable: same segment accounting, and
      // no names (e.g. literal backslashes) restore would reject as traversal.
      const archivedPath = remapArchivePath(entryPath, manifestPath, dataTarget, authTarget);
      if (!isAllowedRestorePath(archivedPath)) {
        unrestorablePath = unrestorablePath ?? entryPath;
        return false;
      }
      totalEntries += archivedPath.split("/").filter(Boolean).length;
      if (totalEntries > maxEntries) {
        tooManyEntries = true;
        return false;
      }
      if (isFile) {
        totalBytes += stat.size;
        fileCount += 1;
        if (totalBytes > maxBytes) {
          exceeded = true;
          return false;
        }
      }
      return true;
    };
    await pipeline(
      tar.c(
        {
          gzip: true,
          portable: true,
          preservePaths: true,
          linkCache: new BackupLinkCache(),
          filter,
          onWriteEntry: (entry) => {
            entry.path = remapArchivePath(entry.path, manifestPath, dataTarget, authTarget);
          },
        },
        [manifestPath, dataTarget, authTarget],
      ),
      // Stream to a same-directory temp path first: a killed process must not
      // leave a truncated file under the final archive name.
      createWriteStream(tempArchivePath, { flags: "wx", mode: 0o600 }),
    );
    // A single large file can stream past the lease TTL without a filter
    // callback, so validate lease ownership once more before the archive is
    // declared good; a lost lease means the cell may have run mid-read.
    try {
      params.checkpoint();
    } catch {
      leaseLost = true;
    }
    if (leaseLost) {
      throw new Error(
        `Fleet backup for ${params.record.tenantId} lost its operation lease; the partial archive was discarded. Retry the backup.`,
      );
    }
    if (exceeded) {
      throw new Error(
        `Fleet backup exceeds the ${maxBytes}-byte limit; raise --max-bytes or reduce the cell data.`,
      );
    }
    if (tooManyEntries) {
      throw new Error(
        `Fleet backup exceeds the ${maxEntries}-entry limit; reduce the number of files in the cell data.`,
      );
    }
    if (unrestorablePath !== undefined) {
      throw new Error(
        `Fleet backup refuses a file name its restore path rules would reject: ${unrestorablePath}. Rename the file inside the cell and retry.`,
      );
    }
    await publishArchive(tempArchivePath, archivePath);
    return {
      tenant: params.record.tenantId,
      archivePath,
      fileCount,
      skippedSymlinks,
      skippedSpecial,
      note: "Archive contains tenant state and auth secrets; store it like a credential.",
    };
  } finally {
    await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Publish with no-overwrite semantics after every check passed: hard-link the
// temp file to the final name when supported, else exclusive copy. EEXIST from
// either path means another process owns the destination.
async function publishArchive(tempArchivePath: string, archivePath: string): Promise<void> {
  try {
    await fs.link(tempArchivePath, archivePath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing fleet backup archive: ${archivePath}`, {
        cause: error,
      });
    }
    if (code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EPERM") {
      throw error;
    }
  }
  try {
    await fs.copyFile(tempArchivePath, archivePath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing fleet backup archive: ${archivePath}`, {
        cause: error,
      });
    }
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isAllowedRestorePath(rawPath: string): boolean {
  // Fleet archives use POSIX separators only. A literal backslash would
  // validate as one path but extract as another on POSIX, so it is rejected
  // outright at both backup and restore time.
  if (rawPath.includes("\\")) {
    return false;
  }
  const normalized = path.posix.normalize(rawPath);
  if (normalized !== rawPath || normalized.startsWith("/") || normalized.startsWith("../")) {
    return false;
  }
  return (
    normalized === "manifest.json" ||
    normalized === "data" ||
    normalized.startsWith("data/") ||
    normalized === "auth" ||
    normalized.startsWith("auth/")
  );
}

function restoreEntryKind(entry: Stats | tar.ReadEntry): "file" | "directory" | "other" {
  if ("isFile" in entry) {
    return entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
  }
  return entry.type === "File" ? "file" : entry.type === "Directory" ? "directory" : "other";
}

// Extraction runs as the invoking user, so a root-invoked restore must repair
// ownership for whichever identity the cell container actually runs as: the
// explicit non-root user mapping when one exists, else the image default
// (uid 1000). Rootless mappings (uid 0) keep root ownership, which the user
// namespace translates to the daemon user.
export function resolveRestoreOwner(
  hostIdentity: HostIdentity | undefined,
  containerUser: CellContainerProfile["containerUser"],
): { uid: number; gid: number } | undefined {
  if (hostIdentity?.uid !== 0) {
    return undefined;
  }
  if (!containerUser) {
    return { uid: 1000, gid: 1000 };
  }
  return containerUser.uid > 0 ? { uid: containerUser.uid, gid: containerUser.gid } : undefined;
}

// Lease liveness during this walk comes from withFleetCellOperation's interval
// heartbeat (60s, well under the 5-minute TTL); per-entry checkpoints would add
// a SQLite write per file for a stall-only risk the v1 lease design accepts.
async function chownTree(root: string, owner: { uid: number; gid: number }): Promise<void> {
  await fs.chown(root, owner.uid, owner.gid);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to chown symlink in restored fleet data: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await chownTree(entryPath, owner);
    } else {
      await fs.chown(entryPath, owner.uid, owner.gid);
    }
  }
}

export async function restoreFleetCell(params: {
  record: FleetCellRecord;
  stateDir: string;
  containers: FleetContainerRuntime;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  checkpoint: () => void;
  generateToken: () => string;
  generateAttemptId: () => string;
  hostIdentity: HostIdentity | undefined;
  selinuxRelabel: boolean;
  from: string;
  force?: boolean;
  maxBytes?: number;
  maxEntries?: number;
}): Promise<FleetRestoreResult> {
  await params.containers.assertLocal(params.record.runtime);
  const archivePath = path.resolve(params.from);
  const archiveStat = await fs.lstat(archivePath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    throw new Error(`Fleet restore archive must be a regular file: ${archivePath}`);
  }
  const canonicalArchive = await fs.realpath(archivePath);
  const restoreRoots = await Promise.all([
    canonicalizeForContainment(params.record.dataDir),
    canonicalizeForContainment(cellAuthSecretDir(params.stateDir, params.record.tenantId)),
  ]);
  if (restoreRoots.some((root) => isWithin(canonicalArchive, root))) {
    throw new Error(
      "Fleet restore archive must not be stored inside the cell data or auth directory.",
    );
  }
  const inspectionResult = await params.containers.inspect(
    params.record.runtime,
    params.record.containerName,
  );
  if (inspectionResult.kind === "missing") {
    throw new Error(
      `Fleet cell container is missing for ${params.record.tenantId}; create the cell (openclaw fleet create ${params.record.tenantId}) and then restore into it.`,
    );
  }
  const inspection = assertManagedInspection(params.record, inspectionResult);
  if (inspection.running && !params.force) {
    throw new Error(
      `Fleet cell ${params.record.tenantId} is running; pass --force to stop it and replace its state.`,
    );
  }
  const wasRunning = inspection.running;
  requireInspectedGatewayToken(inspection, "restore");
  requireInspectedAttemptId(inspection, "restore");

  const tempRoot = path.join(params.stateDir, "fleet", "restore-tmp");
  await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, `${params.record.tenantId}-`));
  await fs.chmod(tempDir, 0o700);
  let preserveTemp = false;
  let stoppedForRestore = false;
  let containerRemoved = false;
  let previousDisplaced = false;
  let stateSwapped = false;
  // Captured outside the try so the failure path can recognize the replacement
  // generation by attempt label.
  let replacementAttemptId = "";
  try {
    let invalidArchive = false;
    let totalBytes = 0;
    let totalEntries = 0;
    let exceeded = false;
    let tooManyEntries = false;
    const maxBytes = params.maxBytes ?? DEFAULT_FLEET_BACKUP_MAX_BYTES;
    const maxEntries = params.maxEntries ?? FLEET_BACKUP_MAX_ENTRIES;
    await tar.x({
      file: archivePath,
      cwd: tempDir,
      preservePaths: false,
      preserveOwner: false,
      strict: true,
      onwarn: () => {
        invalidArchive = true;
      },
      filter: (entryPath, entry) => {
        if (exceeded || tooManyEntries) {
          return false;
        }
        // Entry cap complements the byte cap: metadata-only archive bombs stay
        // under --max-bytes but can exhaust host inodes during extraction.
        // Count path segments, not entries, so deep paths whose intermediate
        // directories are created implicitly cannot bypass the budget.
        totalEntries += entryPath.split("/").filter(Boolean).length;
        if (totalEntries > maxEntries) {
          tooManyEntries = true;
          return false;
        }
        const kind = restoreEntryKind(entry);
        if (kind === "other" || !isAllowedRestorePath(entryPath)) {
          invalidArchive = true;
          return false;
        }
        if (kind === "file") {
          totalBytes += entry.size;
          if (totalBytes > maxBytes) {
            exceeded = true;
            return false;
          }
        }
        return true;
      },
    });
    if (exceeded) {
      throw new Error(
        `Fleet restore exceeds the ${maxBytes}-byte limit; raise --max-bytes or use a smaller archive.`,
      );
    }
    if (tooManyEntries) {
      throw new Error(
        `Fleet restore exceeds the ${maxEntries}-entry limit; the archive is not a usable fleet cell backup.`,
      );
    }
    if (invalidArchive) {
      throw new Error("Archive is not a fleet cell backup or was tampered with.");
    }
    const safeRoot = await fsSafeRoot(tempDir, {
      symlinks: "reject",
      hardlinks: "reject",
      maxBytes: MANIFEST_MAX_BYTES,
      nonBlockingRead: true,
    });
    let manifest: unknown;
    try {
      manifest = JSON.parse((await safeRoot.read("manifest.json")).buffer.toString("utf8"));
    } catch (error) {
      throw new Error("Archive is not a fleet cell backup or was tampered with.", {
        cause: error,
      });
    }
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("kind" in manifest) ||
      manifest.kind !== "openclaw-fleet-cell-backup" ||
      !("schemaVersion" in manifest) ||
      manifest.schemaVersion !== 1 ||
      !("tenant" in manifest) ||
      typeof manifest.tenant !== "string"
    ) {
      throw new Error("Archive is not a fleet cell backup or was tampered with.");
    }
    if (manifest.tenant !== params.record.tenantId) {
      throw new Error(
        `Backup archive belongs to tenant ${manifest.tenant}; refusing to restore it into ${params.record.tenantId}.`,
      );
    }
    const extractedData = path.join(tempDir, "data");
    const dataStat = await fs.lstat(extractedData);
    if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) {
      throw new Error("Archive is not a fleet cell backup or was tampered with.");
    }
    // The auth tree is mandatory: accepting an auth-less archive would swap the
    // cell's auth-profile encryption keys for an empty directory and then delete
    // the displaced originals on successful cleanup.
    const extractedAuth = path.join(tempDir, "auth");
    let authStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      authStat = await fs.lstat(extractedAuth);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Archive is not a fleet cell backup or was tampered with.", {
          cause: error,
        });
      }
      throw error;
    }
    if (!authStat.isDirectory() || authStat.isSymbolicLink()) {
      throw new Error("Archive is not a fleet cell backup or was tampered with.");
    }

    const containerUser = await resolveContainerUser({
      runtime: params.record.runtime,
      containers: params.containers,
      hostIdentity: params.hostIdentity,
      user: inspection.user,
    });
    const imageOwner = resolveRestoreOwner(params.hostIdentity, containerUser);
    // Build and validate the replacement profile before any destructive step so a
    // drifted-but-managed container (bad provenance label, invalid inspected limits)
    // fails preflight instead of after the old container and state are gone.
    const token = params.generateToken();
    const attemptId = params.generateAttemptId();
    replacementAttemptId = attemptId;
    const profile: CellContainerProfile = {
      ...buildProfileBaseFromInspection({
        record: params.record,
        stateDir: params.stateDir,
        inspection,
        containerUser,
        selinuxRelabel: params.selinuxRelabel,
        token,
        context: "restore",
      }),
      image: inspection.imageId,
      attemptId,
    };
    validateCellContainerProfile(profile);
    const authSecretDir = cellAuthSecretDir(params.stateDir, params.record.tenantId);
    const dataTarget = await resolvePurgeTarget(
      path.join(params.stateDir, "fleet", "cells"),
      params.record.dataDir,
      params.record.tenantId,
    );
    const authTarget = await resolvePurgeTarget(
      path.join(params.stateDir, "fleet", "auth-profile-secrets"),
      authSecretDir,
      params.record.tenantId,
    );
    const replacedRoot = path.join(tempDir, "replaced");
    await fs.mkdir(replacedRoot, { mode: 0o700 });

    assertManagedNetwork(
      params.record,
      await params.containers.inspectNetwork(
        params.record.runtime,
        cellNetworkName(params.record.tenantId),
      ),
    );

    if (wasRunning) {
      params.checkpoint();
      assertManagedInspection(
        params.record,
        await params.containers.inspect(params.record.runtime, params.record.containerName),
      );
      await params.containers.stop(params.record.runtime, params.record.containerName);
      stoppedForRestore = true;
    }
    params.checkpoint();
    assertManagedInspection(
      params.record,
      await params.containers.inspect(params.record.runtime, params.record.containerName),
    );
    await params.containers.remove(params.record.runtime, params.record.containerName, false);
    containerRemoved = true;
    params.checkpoint();
    previousDisplaced = true;
    if (dataTarget) {
      await fs.rename(dataTarget, path.join(replacedRoot, "data"));
    }
    if (authTarget) {
      await fs.rename(authTarget, path.join(replacedRoot, "auth"));
    }
    await fs.rename(extractedData, params.record.dataDir);
    await fs.rename(extractedAuth, authSecretDir);
    stateSwapped = true;
    await prepareCellDirectories(params.record, authSecretDir, imageOwner);
    if (imageOwner) {
      await Promise.all([
        chownTree(params.record.dataDir, imageOwner),
        chownTree(authSecretDir, imageOwner),
      ]);
    }
    await prepareCellConfig(params.record, imageOwner);

    params.checkpoint();
    await params.containers.run(profile, wasRunning);
    if (wasRunning) {
      await verifyReplacementHealthy({
        containers: params.containers,
        record: params.record,
        attemptId,
        fetchImpl: params.fetchImpl,
        now: params.now,
        sleep: params.sleep,
        checkpoint: params.checkpoint,
        timeoutMs: RESTORE_VERIFY_TIMEOUT_MS,
        pollMs: RESTORE_VERIFY_POLL_MS,
        context: "restore",
      });
    }
    return {
      tenant: params.record.tenantId,
      archivePath,
      token,
      tokenNote: "Shown once. The previous Gateway token was rotated by this restore.",
      started: wasRunning,
      url: `http://127.0.0.1:${params.record.hostPort}`,
    };
  } catch (error) {
    if (containerRemoved) {
      preserveTemp = true;
      // The rotated token was never delivered, so a live replacement must not
      // keep serving. Detect it by attempt label (containers.run can fail after
      // partially starting), and never claim it was stopped when it was not.
      let replacementNote = "";
      try {
        const current = await params.containers.inspect(
          params.record.runtime,
          params.record.containerName,
        );
        if (
          current.kind === "ok" &&
          current.labels[FLEET_ATTEMPT_LABEL] === replacementAttemptId &&
          current.running
        ) {
          await params.containers.stop(params.record.runtime, params.record.containerName);
          replacementNote =
            " The interrupted replacement container was stopped; retry fleet restore to rotate a fresh Gateway token.";
        } else if (current.kind === "unavailable") {
          // An unavailable runtime cannot prove the replacement is down.
          replacementNote =
            " The replacement container state could not be verified; stop it manually before retrying fleet restore.";
        }
      } catch {
        replacementNote =
          " The interrupted replacement container could not be stopped; stop it manually before retrying fleet restore.";
      }
      // Report where each tree actually is for the failure phase: before the
      // swap the previous data never moved; after it, the restored trees are
      // already live and only the displaced originals sit under replaced/.
      const recoveryNote = stateSwapped
        ? ` Restored data is already in place under the cell directories; displaced previous data is preserved at ${tempDir}/replaced.`
        : previousDisplaced
          ? ` Previous data is preserved at ${tempDir}/replaced and the extracted archive remains at ${tempDir}.`
          : ` Previous cell data remains in place; the extracted archive remains at ${tempDir}.`;
      throw new Error(
        `Fleet restore for ${params.record.tenantId} was interrupted after the cell container was removed: ${errorMessage(error)}.${replacementNote}${recoveryNote}`,
        { cause: error },
      );
    }
    if (stoppedForRestore) {
      // A --force restore stopped a running cell but failed before removal.
      // Restart the same managed generation so an aborted restore does not
      // strand a healthy tenant stopped; the original error stays primary.
      try {
        const current = assertManagedInspection(
          params.record,
          await params.containers.inspect(params.record.runtime, params.record.containerName),
        );
        if (
          !current.running &&
          current.labels[FLEET_ATTEMPT_LABEL] === inspection.labels[FLEET_ATTEMPT_LABEL]
        ) {
          await params.containers.start(params.record.runtime, params.record.containerName);
        }
      } catch {
        // Best-effort recovery; the container remains stopped but intact.
      }
    }
    throw error;
  } finally {
    if (!preserveTemp) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
