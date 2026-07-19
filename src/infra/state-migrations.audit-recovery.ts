import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { root as createFsSafeRoot } from "./fs-safe.js";
import { syncDirectoryBestEffort } from "./sqlite-snapshot.js";
import {
  legacyAuditRawCheckpointKey,
  legacyAuditRawCheckpointsMatch,
  legacyAuditSourceGenerationKey,
  openLegacyAuditRawCheckpointStore,
  type LegacyAuditFileCheckpoint,
  type LegacyAuditRawCheckpoint,
} from "./state-migrations.audit-checkpoints.js";
import {
  auditRecoveryStateMatchesJournal,
  parseAuditRecoveryProgress,
  parseAuditRecoveryRestoreJournal,
  serializeAuditRecoveryProgress,
  serializeAuditRecoveryRestoreJournal,
  type AuditRecoveryProgress,
  type ParsedAuditRecoveryRestoreJournal,
} from "./state-migrations.audit-recovery-protocol.js";

export type AuditMigrationRoot = Awaited<ReturnType<typeof createFsSafeRoot>>;
export type LegacyAuditSourceSnapshot = LegacyAuditFileCheckpoint & {
  raw: string;
  rawBytes: Buffer;
};

const AUDIT_RECOVERY_RESTORE_SUFFIX = ".doctor-scrub-restore";
const AUDIT_RECOVERY_STAGING_SUFFIX = ".doctor-scrub-staging";
const AUDIT_RECOVERY_PROGRESS_SUFFIX = ".doctor-scrub-progress";
const AUDIT_RECOVERY_SCRUB_PATTERN_BYTES = 32;

function auditRecoverySiblingPath(relativePath: string, suffix: string): string {
  return `${relativePath}${suffix}`;
}

function auditRecoveryJournalTargetsSnapshot(
  snapshot: LegacyAuditSourceSnapshot,
  journal: Pick<ParsedAuditRecoveryRestoreJournal, "target">,
): boolean {
  return (
    snapshot.dev === journal.target.dev &&
    snapshot.ino === journal.target.ino &&
    snapshot.rawBytes.length >= journal.target.size
  );
}

function auditRecoveryCheckpointPrefixMatches(
  snapshot: LegacyAuditSourceSnapshot,
  checkpoint: LegacyAuditRawCheckpoint,
): boolean {
  if (snapshot.rawBytes.length < checkpoint.size) {
    return false;
  }
  return (
    createHash("sha256").update(snapshot.rawBytes.subarray(0, checkpoint.size)).digest("hex") ===
    checkpoint.contentHash
  );
}

async function syncAuditRecoveryDirectory(
  root: AuditMigrationRoot,
  relativePath: string,
): Promise<void> {
  await syncDirectoryBestEffort(path.join(root.rootReal, path.dirname(relativePath)));
}

export async function readLegacyAuditSourceSnapshot(
  root: AuditMigrationRoot,
  relativePath: string,
): Promise<LegacyAuditSourceSnapshot> {
  const opened = await root.open(relativePath);
  try {
    const before = await opened.handle.stat();
    if (!before.isFile()) {
      throw new Error("legacy audit source is not a regular file");
    }
    const rawBytes = await opened.handle.readFile();
    const after = await opened.handle.stat();
    const beforeCheckpoint = {
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      size: before.size,
    };
    const afterCheckpoint = {
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      size: after.size,
    };
    if (!legacyAuditRawCheckpointsMatch(beforeCheckpoint, afterCheckpoint)) {
      throw new Error("legacy audit source changed while Doctor was reading it");
    }
    return { ...afterCheckpoint, raw: rawBytes.toString("utf8"), rawBytes };
  } finally {
    await opened.handle.close();
  }
}

export async function readLegacyAuditSourcePrefixSnapshotForBackup(
  root: AuditMigrationRoot,
  relativePath: string,
): Promise<LegacyAuditSourceSnapshot> {
  const opened = await root.open(relativePath);
  try {
    const before = await opened.handle.stat();
    if (!before.isFile()) {
      throw new Error("legacy audit source is not a regular file");
    }
    const rawBytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < rawBytes.length) {
      const length = Math.min(64 * 1024, rawBytes.length - offset);
      const { bytesRead } = await opened.handle.read(rawBytes, offset, length, offset);
      if (bytesRead === 0) {
        throw new Error("legacy audit source was truncated while backup was reading it");
      }
      offset += bytesRead;
    }
    const after = await opened.handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || after.size < before.size) {
      throw new Error("legacy audit source changed other than by append during backup");
    }
    const checkpoint = {
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      size: before.size,
    };
    return { ...checkpoint, raw: rawBytes.toString("utf8"), rawBytes };
  } finally {
    await opened.handle.close();
  }
}

export async function readLegacyAuditRecoverySourceForBackup(
  root: AuditMigrationRoot,
  relativePath: string,
): Promise<LegacyAuditSourceSnapshot> {
  const current = await readLegacyAuditSourcePrefixSnapshotForBackup(root, relativePath);
  const restoreRelativePath = auditRecoverySiblingPath(relativePath, AUDIT_RECOVERY_RESTORE_SUFFIX);
  if (!(await root.exists(restoreRelativePath))) {
    return current;
  }
  const restoreSnapshot = await readLegacyAuditSourceSnapshot(root, restoreRelativePath);
  const journal = parseAuditRecoveryRestoreJournal(restoreSnapshot.raw);
  const progress = await readAuditRecoveryProgress({ root, relativePath, journal });
  const scrubbedContent = buildScrubbedAuditRecoveryContent(
    journal.sourceRaw,
    journal.scrubPattern,
  );
  if (
    !auditRecoveryJournalTargetsSnapshot(current, journal) ||
    !auditRecoveryStateMatchesJournal({
      current: current.rawBytes,
      original: journal.sourceRaw,
      scrubbed: scrubbedContent,
      progress,
    })
  ) {
    return current;
  }
  const rawBytes = Buffer.concat([
    journal.sourceRaw,
    current.rawBytes.subarray(journal.sourceRaw.length),
  ]);
  return { ...current, raw: rawBytes.toString("utf8"), rawBytes };
}

function createAuditRecoveryScrubPattern(): Buffer {
  const pattern = randomBytes(AUDIT_RECOVERY_SCRUB_PATTERN_BYTES);
  for (let index = 0; index < pattern.length; index += 1) {
    pattern[index] = (pattern[index]! & 1) === 0 ? 0x20 : 0x09;
  }
  for (let offset = 0; offset < pattern.length; offset += 8) {
    const block = pattern.subarray(offset, offset + 8);
    if (block.every((byte) => byte === 0x20)) {
      pattern[offset + 7] = 0x09;
    } else if (block.every((byte) => byte === 0x09)) {
      pattern[offset + 7] = 0x20;
    }
  }
  return pattern;
}

function buildScrubbedAuditRecoveryContent(rawBytes: Buffer, scrubPattern: Buffer): Buffer {
  if (rawBytes.length === 0) {
    return Buffer.alloc(0);
  }
  // The readable sanitized sibling owns migrated history. This same-inode file
  // is only an append landing pad for predecessor writers, so blank the complete
  // fixed-size prefix and checkpoint it with zero records. Leading whitespace is
  // valid before any late JSONL row and preserves an open O_APPEND offset.
  const scrubbed = Buffer.allocUnsafe(rawBytes.length);
  for (let offset = 0; offset < scrubbed.length; offset += scrubPattern.length) {
    scrubPattern.copy(scrubbed, offset, 0, Math.min(scrubPattern.length, scrubbed.length - offset));
  }
  return scrubbed;
}

async function writeAuditRecoveryRange(
  handle: Awaited<ReturnType<AuditMigrationRoot["openWritable"]>>["handle"],
  content: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < content.byteLength) {
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.byteLength - offset,
      position + offset,
    );
    if (bytesWritten === 0) {
      throw new Error("zero-byte write while updating legacy recovery archive");
    }
    offset += bytesWritten;
  }
}

const AUDIT_RECOVERY_WRITE_CHUNK_BYTES = 64 * 1024;

async function writeAuditRecoveryProgress(params: {
  root: AuditMigrationRoot;
  relativePath: string;
  progress: AuditRecoveryProgress;
}): Promise<void> {
  const progressRelativePath = auditRecoverySiblingPath(
    params.relativePath,
    AUDIT_RECOVERY_PROGRESS_SUFFIX,
  );
  await params.root.write(progressRelativePath, serializeAuditRecoveryProgress(params.progress), {
    mkdir: false,
    mode: 0o600,
  });
  const opened = await params.root.open(progressRelativePath);
  try {
    await opened.handle.chmod(0o600);
    await opened.handle.sync();
  } finally {
    await opened.handle.close();
  }
  await syncAuditRecoveryDirectory(params.root, params.relativePath);
}

async function readAuditRecoveryProgress(params: {
  root: AuditMigrationRoot;
  relativePath: string;
  journal: ReturnType<typeof parseAuditRecoveryRestoreJournal>;
}): Promise<AuditRecoveryProgress> {
  const progressRelativePath = auditRecoverySiblingPath(
    params.relativePath,
    AUDIT_RECOVERY_PROGRESS_SUFFIX,
  );
  if (!(await params.root.exists(progressRelativePath))) {
    return {
      schemaVersion: 1,
      journalHash: params.journal.journalHash,
      direction: "scrubbing",
      committedBytes: 0,
      pendingEnd: 0,
      extentBytes: params.journal.target.size,
    };
  }
  const snapshot = await readLegacyAuditSourceSnapshot(params.root, progressRelativePath);
  return parseAuditRecoveryProgress(snapshot.raw, params.journal);
}

async function advanceAuditRecoveryWrite(params: {
  root: AuditMigrationRoot;
  relativePath: string;
  progress: AuditRecoveryProgress;
  desiredContent: Buffer;
  handle: Awaited<ReturnType<AuditMigrationRoot["openWritable"]>>["handle"];
}): Promise<AuditRecoveryProgress> {
  let progress = params.progress;
  if (progress.pendingEnd > progress.committedBytes) {
    await writeAuditRecoveryRange(
      params.handle,
      params.desiredContent.subarray(progress.committedBytes, progress.pendingEnd),
      progress.committedBytes,
    );
    await params.handle.sync();
    progress = { ...progress, committedBytes: progress.pendingEnd };
    await writeAuditRecoveryProgress({ ...params, progress });
  }
  while (progress.committedBytes < progress.extentBytes) {
    const end = Math.min(
      progress.committedBytes + AUDIT_RECOVERY_WRITE_CHUNK_BYTES,
      progress.extentBytes,
    );
    // Commit intent before target bytes. A crash can leave any prefix of this
    // range changed; pendingEnd lets recovery finish it without guessing.
    progress = { ...progress, pendingEnd: end };
    await writeAuditRecoveryProgress({ ...params, progress });
    await writeAuditRecoveryRange(
      params.handle,
      params.desiredContent.subarray(progress.committedBytes, end),
      progress.committedBytes,
    );
    await params.handle.sync();
    progress = { ...progress, committedBytes: end };
    await writeAuditRecoveryProgress({ ...params, progress });
  }
  return progress;
}

async function reconcileAuditRecoveryPendingWrite(params: {
  root: AuditMigrationRoot;
  relativePath: string;
  progress: AuditRecoveryProgress;
  desiredContent: Buffer;
  handle: Awaited<ReturnType<AuditMigrationRoot["openWritable"]>>["handle"];
}): Promise<AuditRecoveryProgress> {
  if (params.progress.pendingEnd === params.progress.committedBytes) {
    return params.progress;
  }
  await writeAuditRecoveryRange(
    params.handle,
    params.desiredContent.subarray(params.progress.committedBytes, params.progress.pendingEnd),
    params.progress.committedBytes,
  );
  await params.handle.sync();
  const progress = { ...params.progress, committedBytes: params.progress.pendingEnd };
  await writeAuditRecoveryProgress({ ...params, progress });
  return progress;
}

async function stageAuditRecoveryRestore(params: {
  root: AuditMigrationRoot;
  relativePath: string;
  snapshot: LegacyAuditSourceSnapshot;
  scrubPattern: Buffer;
}): Promise<AuditRecoveryProgress> {
  const restoreRelativePath = auditRecoverySiblingPath(
    params.relativePath,
    AUDIT_RECOVERY_RESTORE_SUFFIX,
  );
  const stagingRelativePath = auditRecoverySiblingPath(
    params.relativePath,
    AUDIT_RECOVERY_STAGING_SUFFIX,
  );
  await params.root.remove(stagingRelativePath).catch(() => undefined);
  const journalRaw = serializeAuditRecoveryRestoreJournal({
    rawBytes: params.snapshot.rawBytes,
    scrubPattern: params.scrubPattern,
    target: {
      dev: params.snapshot.dev,
      ino: params.snapshot.ino,
      size: params.snapshot.size,
    },
  });
  await params.root.create(stagingRelativePath, journalRaw, { mode: 0o600 });
  const staged = await params.root.open(stagingRelativePath);
  try {
    await staged.handle.chmod(0o600);
    await staged.handle.sync();
  } finally {
    await staged.handle.close();
  }
  await params.root.move(stagingRelativePath, restoreRelativePath);
  await syncAuditRecoveryDirectory(params.root, params.relativePath);
  const journal = parseAuditRecoveryRestoreJournal(journalRaw);
  const progress: AuditRecoveryProgress = {
    schemaVersion: 1,
    journalHash: journal.journalHash,
    direction: "scrubbing",
    committedBytes: 0,
    pendingEnd: 0,
    extentBytes: journal.target.size,
  };
  await writeAuditRecoveryProgress({
    root: params.root,
    relativePath: params.relativePath,
    progress,
  });
  return progress;
}

export async function restoreInterruptedAuditRecoveryArchive(params: {
  root: AuditMigrationRoot;
  relativePath: string;
  label: string;
  warnings: string[];
}): Promise<boolean> {
  const restoreRelativePath = auditRecoverySiblingPath(
    params.relativePath,
    AUDIT_RECOVERY_RESTORE_SUFFIX,
  );
  const stagingRelativePath = auditRecoverySiblingPath(
    params.relativePath,
    AUDIT_RECOVERY_STAGING_SUFFIX,
  );
  const progressRelativePath = auditRecoverySiblingPath(
    params.relativePath,
    AUDIT_RECOVERY_PROGRESS_SUFFIX,
  );
  if (!(await params.root.exists(restoreRelativePath))) {
    await params.root.remove(stagingRelativePath).catch(() => undefined);
    await params.root.remove(progressRelativePath).catch(() => undefined);
    return true;
  }
  try {
    const currentSnapshot = await readLegacyAuditSourceSnapshot(params.root, params.relativePath);
    const restoreSnapshot = await readLegacyAuditSourceSnapshot(params.root, restoreRelativePath);
    const journal = parseAuditRecoveryRestoreJournal(restoreSnapshot.raw);
    let progress = await readAuditRecoveryProgress({
      root: params.root,
      relativePath: params.relativePath,
      journal,
    });
    const scrubbedContent = buildScrubbedAuditRecoveryContent(
      journal.sourceRaw,
      journal.scrubPattern,
    );
    let completedCheckpoint: LegacyAuditRawCheckpoint | undefined;
    try {
      completedCheckpoint = findPreviousLegacyAuditRawCheckpoint(
        params.root.rootReal,
        params.relativePath,
      );
    } catch {
      completedCheckpoint = undefined;
    }
    if (
      completedCheckpoint &&
      completedCheckpoint.phase === "raw" &&
      completedCheckpoint.recordCount === 0 &&
      completedCheckpoint.size === journal.sourceRaw.length &&
      auditRecoveryCheckpointPrefixMatches(currentSnapshot, completedCheckpoint)
    ) {
      // Checkpoint commit won the crash race; the restore journal is stale and
      // must not roll the already-checkpointed sanitized inode backward.
      await params.root.remove(progressRelativePath).catch(() => undefined);
      await params.root.remove(stagingRelativePath).catch(() => undefined);
      await params.root.remove(restoreRelativePath);
      await syncAuditRecoveryDirectory(params.root, params.relativePath);
      return true;
    }
    const writable = await params.root.openWritable(params.relativePath, {
      mode: 0o600,
      writeMode: "update",
    });
    try {
      const verification = await readLegacyAuditSourceSnapshot(params.root, params.relativePath);
      if (
        writable.stat.dev !== verification.dev ||
        writable.stat.ino !== verification.ino ||
        !auditRecoveryJournalTargetsSnapshot(verification, journal) ||
        !auditRecoveryStateMatchesJournal({
          current: verification.rawBytes,
          original: journal.sourceRaw,
          scrubbed: scrubbedContent,
          progress,
        })
      ) {
        throw new Error("legacy recovery archive no longer matches its restore journal target");
      }
      progress = await reconcileAuditRecoveryPendingWrite({
        root: params.root,
        relativePath: params.relativePath,
        progress,
        desiredContent: progress.direction === "scrubbing" ? scrubbedContent : journal.sourceRaw,
        handle: writable.handle,
      });
      if (progress.direction === "scrubbing") {
        progress = {
          schemaVersion: 1,
          journalHash: journal.journalHash,
          direction: "restoring",
          committedBytes: 0,
          pendingEnd: 0,
          extentBytes: progress.committedBytes,
        };
        await writeAuditRecoveryProgress({
          root: params.root,
          relativePath: params.relativePath,
          progress,
        });
      }
      await advanceAuditRecoveryWrite({
        root: params.root,
        relativePath: params.relativePath,
        progress,
        desiredContent: journal.sourceRaw,
        handle: writable.handle,
      });
      await writable.handle.chmod(0o600);
      await writable.handle.sync();
    } finally {
      await writable.handle.close().catch(() => undefined);
    }
    await params.root.remove(progressRelativePath).catch(() => undefined);
    await params.root.remove(stagingRelativePath).catch(() => undefined);
    await params.root.remove(restoreRelativePath);
    await syncAuditRecoveryDirectory(params.root, params.relativePath);
    return true;
  } catch (error) {
    params.warnings.push(
      `Failed restoring interrupted ${params.label} legacy recovery archive: ${String(error)}`,
    );
    return false;
  }
}

export async function finalizeLegacyAuditRecoveryArchive(params: {
  root: AuditMigrationRoot;
  relativePath: string;
}): Promise<void> {
  await params.root
    .remove(auditRecoverySiblingPath(params.relativePath, AUDIT_RECOVERY_PROGRESS_SUFFIX))
    .catch(() => undefined);
  await params.root
    .remove(auditRecoverySiblingPath(params.relativePath, AUDIT_RECOVERY_STAGING_SUFFIX))
    .catch(() => undefined);
  await params.root.remove(
    auditRecoverySiblingPath(params.relativePath, AUDIT_RECOVERY_RESTORE_SUFFIX),
  );
  await syncAuditRecoveryDirectory(params.root, params.relativePath);
}

export async function scrubLegacyAuditRecoveryArchive(params: {
  root: AuditMigrationRoot;
  relativePath: string;
  expectedSnapshot: LegacyAuditSourceSnapshot;
  label: string;
  warnings: string[];
}): Promise<LegacyAuditSourceSnapshot | undefined> {
  const scrubPattern = createAuditRecoveryScrubPattern();
  const scrubbedContent = buildScrubbedAuditRecoveryContent(
    params.expectedSnapshot.rawBytes,
    scrubPattern,
  );
  let progress: AuditRecoveryProgress;
  try {
    progress = await stageAuditRecoveryRestore({
      root: params.root,
      relativePath: params.relativePath,
      snapshot: params.expectedSnapshot,
      scrubPattern,
    });
  } catch (error) {
    params.warnings.push(
      `Failed staging ${params.label} legacy recovery restore journal: ${String(error)}`,
    );
    return undefined;
  }
  let writable: Awaited<ReturnType<AuditMigrationRoot["openWritable"]>>;
  try {
    writable = await params.root.openWritable(params.relativePath, {
      mode: 0o600,
      writeMode: "update",
    });
  } catch (error) {
    params.warnings.push(
      `Failed scrubbing ${params.label} legacy recovery archive: ${String(error)}`,
    );
    return undefined;
  }
  try {
    if (!legacyAuditRawCheckpointsMatch(params.expectedSnapshot, writable.stat)) {
      params.warnings.push(
        `Skipped scrubbing changed ${params.label} legacy recovery archive; rerun openclaw doctor --fix`,
      );
      return undefined;
    }
    await advanceAuditRecoveryWrite({
      root: params.root,
      relativePath: params.relativePath,
      progress,
      desiredContent: scrubbedContent,
      handle: writable.handle,
    });
    await writable.handle.chmod(0o600);
    await writable.handle.sync();
  } catch (error) {
    await writable.handle.close().catch(() => undefined);
    const recoveryWarnings: string[] = [];
    const restored = await restoreInterruptedAuditRecoveryArchive({
      root: params.root,
      relativePath: params.relativePath,
      label: params.label,
      warnings: recoveryWarnings,
    });
    if (restored) {
      params.warnings.push(
        `Failed scrubbing ${params.label} legacy recovery archive; restored it for Doctor retry: ${String(error)}`,
      );
    } else {
      params.warnings.push(...recoveryWarnings);
      params.warnings.push(
        `Failed scrubbing ${params.label} legacy recovery archive; left its progress journal for Doctor retry: ${String(error)}`,
      );
    }
    return undefined;
  } finally {
    await writable.handle.close().catch(() => undefined);
  }
  let scrubbedSnapshot: LegacyAuditSourceSnapshot;
  try {
    scrubbedSnapshot = await readLegacyAuditSourceSnapshot(params.root, params.relativePath);
  } catch (error) {
    params.warnings.push(
      `Changed ${params.label} legacy recovery archive during scrub verification; rerun openclaw doctor --fix: ${String(error)}`,
    );
    return undefined;
  }
  const scrubbedPrefix = scrubbedSnapshot.rawBytes.subarray(0, scrubbedContent.length);
  if (!scrubbedPrefix.equals(scrubbedContent)) {
    params.warnings.push(
      `Failed verifying scrubbed ${params.label} legacy recovery archive; rerun openclaw doctor --fix`,
    );
    return undefined;
  }
  return scrubbedSnapshot;
}

export async function recordLegacyAuditRawCheckpoint(params: {
  stateDir: string;
  rawPath: string;
  rawRelativePath: string;
  sanitizedRelativePath: string;
  root: AuditMigrationRoot;
  snapshot: LegacyAuditSourceSnapshot;
  phase: "merge-intent" | "raw";
  recordCount: number;
  recordOrdinalBase: number;
  warnings: string[];
}): Promise<boolean> {
  try {
    const sanitizedSnapshot = await readLegacyAuditSourceSnapshot(
      params.root,
      params.sanitizedRelativePath,
    );
    const opened = await params.root.open(params.rawRelativePath);
    let checkpoint: LegacyAuditRawCheckpoint;
    try {
      const stat = await opened.handle.stat();
      checkpoint = {
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        phase: params.phase,
        generationKey: legacyAuditSourceGenerationKey(params.rawRelativePath),
        recordCount: params.recordCount,
        recordOrdinalBase: params.recordOrdinalBase,
        contentHash: createHash("sha256").update(params.snapshot.rawBytes).digest("hex"),
        sanitizedContentHash: createHash("sha256").update(sanitizedSnapshot.rawBytes).digest("hex"),
        sanitizedSize: sanitizedSnapshot.rawBytes.length,
      };
    } finally {
      await opened.handle.close();
    }
    if (!legacyAuditRawCheckpointsMatch(checkpoint, params.snapshot)) {
      params.warnings.push(
        `Retained changed legacy audit backup ${params.rawPath}; rerun openclaw doctor --fix to import its later rows`,
      );
      return false;
    }
    openLegacyAuditRawCheckpointStore(params.stateDir).upsert(
      legacyAuditRawCheckpointKey(checkpoint),
      checkpoint,
    );
    return true;
  } catch (error) {
    params.warnings.push(
      `Failed recording legacy audit backup checkpoint for ${params.rawPath}: ${String(error)}`,
    );
    return false;
  }
}

export function findPreviousLegacyAuditRawCheckpoint(
  stateDir: string,
  rawRelativePath: string,
): LegacyAuditRawCheckpoint | undefined {
  const generationKey = legacyAuditSourceGenerationKey(rawRelativePath);
  return openLegacyAuditRawCheckpointStore(stateDir)
    .entries()
    .toReversed()
    .find((entry) => entry.value.generationKey === generationKey)?.value;
}

export function recordsAfterLegacyAuditRawCheckpoint<T>(params: {
  checkpoint: LegacyAuditRawCheckpoint;
  snapshot: LegacyAuditSourceSnapshot;
  records: readonly T[];
}): readonly T[] | undefined {
  const rawBytes = params.snapshot.rawBytes;
  if (rawBytes.length < params.checkpoint.size) {
    return undefined;
  }
  const prefixHash = createHash("sha256")
    .update(rawBytes.subarray(0, params.checkpoint.size))
    .digest("hex");
  const legacyUtf8PrefixHash = createHash("sha256")
    .update(rawBytes.subarray(0, params.checkpoint.size).toString("utf8"))
    .digest("hex");
  if (
    (prefixHash !== params.checkpoint.contentHash &&
      legacyUtf8PrefixHash !== params.checkpoint.contentHash) ||
    params.records.length < params.checkpoint.recordCount
  ) {
    return undefined;
  }
  return params.records.slice(params.checkpoint.recordCount);
}
