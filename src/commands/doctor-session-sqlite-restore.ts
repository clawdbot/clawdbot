/** Restore planning across retained migration manifests. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../config/paths.js";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { requireDirectorySync, syncDirectorySync } from "../infra/directory-durability.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import {
  moveMigrationArtifact,
  readMigrationArtifactIdentity,
  statMigrationPath,
} from "./doctor-session-sqlite-artifact.js";
import {
  assertSafeSessionSqliteMigrationMove,
  canonicalMigrationFilePath,
  filterRestoreManifestTargets,
  hasSymbolicLinkInDirectoryPath,
  isRegularFileWithoutFollowingSymlinks,
  listSessionSqliteMigrationManifestPaths,
  migrationMoveKey,
  readSessionSqliteMigrationManifest,
  uniqueRestoreMoves,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationTargetInput,
  type SessionSqliteMigrationTargetManifest,
} from "./doctor-session-sqlite-migration-run.js";
import type { DoctorSessionSqliteRestoreReport } from "./doctor-session-sqlite-types.js";
import { assertDoctorSqliteMaintenancePathsNotAliased } from "./doctor-sqlite-maintenance-lock.js";
const RESTORE_ARCHIVE_HASH_CHUNK_BYTES = 64 * 1024;

export async function restoreSessionSqliteMigrationRuns(params: {
  env: NodeJS.ProcessEnv;
  trustedTargets: readonly SessionSqliteMigrationTargetInput[];
}): Promise<DoctorSessionSqliteRestoreReport> {
  const restoreReport: DoctorSessionSqliteRestoreReport = emptyRestoreReport();
  const contexts = loadRestoreManifestContexts(
    listSessionSqliteMigrationManifestPaths(params.env).toReversed(),
    params.trustedTargets,
  );
  await reconcileRestorePublications(contexts, params.env);
  const restorePlan = createRestorePlan(contexts);
  for (const { manifest, manifestPath, targets } of contexts) {
    const manifestRestoreReport: DoctorSessionSqliteRestoreReport = {
      ...emptyRestoreReport(),
      manifestPaths: [manifestPath],
    };
    restoreReport.manifestPaths.push(manifestPath);
    await restoreSessionSqliteMigrationManifest(
      manifest,
      manifestPath,
      targets,
      manifestRestoreReport,
      restorePlan,
    );
    restoreReport.conflicts.push(...manifestRestoreReport.conflicts);
    restoreReport.restoredFiles.push(...manifestRestoreReport.restoredFiles);
    restoreReport.skippedFiles.push(...manifestRestoreReport.skippedFiles);
    writeSessionSqliteMigrationManifest({ manifest, manifestPath });
  }
  return restoreReport;
}

/** Undo only recorded, still-linked publication intermediates before a fresh import or restore. */
export async function reconcileSessionSqliteMigrationPublications(params: {
  env: NodeJS.ProcessEnv;
  trustedTargets: readonly SessionSqliteMigrationTargetInput[];
  sourcePath?: string;
}): Promise<void> {
  await reconcileRestorePublications(
    loadRestoreManifestContexts(
      listSessionSqliteMigrationManifestPaths(params.env),
      params.trustedTargets,
    ),
    params.env,
    params.sourcePath,
  );
}

async function reconcileRestorePublications(
  contexts: readonly RestoreManifestContext[],
  env: NodeJS.ProcessEnv,
  sourcePath?: string,
): Promise<void> {
  const stateDir = path.dirname(
    canonicalMigrationFilePath(path.join(resolveStateDir(env), "anchor")),
  );
  for (const context of contexts) {
    for (const target of context.targets) {
      for (const move of uniqueRestoreMoves(target)) {
        if (
          (sourcePath && canonicalMigrationFilePath(sourcePath) !== move.sourcePath) ||
          !move.artifact ||
          move.artifact.disposal.state !== "retained"
        ) {
          continue;
        }
        const source = statMigrationPath(move.sourcePath);
        const archive = statMigrationPath(move.archivePath);
        if (!source || !archive) {
          continue;
        }
        if (
          !source.isFile() ||
          !archive.isFile() ||
          source.dev !== archive.dev ||
          source.ino !== archive.ino
        ) {
          continue;
        }
        if (source.nlink !== 2 || archive.nlink !== 2) {
          continue;
        }
        if (
          ![target.storePath, target.sqlitePath, move.archivePath].every((file) =>
            isPathInside(stateDir, file),
          )
        ) {
          continue;
        }
        assertSafeSessionSqliteMigrationMove(move, target);
        assertDoctorSqliteMaintenancePathsNotAliased(
          "session recovery publication",
          [context.manifestPath, ...resolveSqliteDatabaseFilePaths(target.sqlitePath)],
          [stateDir],
        );
        // The exact recorded original stays at its source; reconciliation never needs
        // the replacement SQLite database to exist or opens it for ownership inspection.
        await moveMigrationArtifact(
          move.archivePath,
          move.sourcePath,
          move.artifact.identity,
          () => {
            assertSafeSessionSqliteMigrationMove(move, target);
            recordRestoredMigrationMove(context.manifest, context.manifestPath, move);
          },
        );
      }
    }
  }
}

function recordRestoredMigrationMove(
  manifest: SessionSqliteMigrationManifest,
  manifestPath: string,
  move: SessionSqliteMigrationMove,
): void {
  // Sessions and archives are siblings. Retry their parent sync even when a previous
  // attempt created the sessions directory, before consuming its original archive.
  requireDirectorySync(
    syncDirectorySync(path.dirname(path.dirname(move.sourcePath))),
    "Restored session directory",
  );
  // Commit consumption before unlinking the archive, so an interrupted restore cannot
  // make a settled generation look like unexplained missing history.
  const consumed = collectRecordedConsumedArchives(manifest);
  consumed.add(move.archivePath);
  manifest.restore = {
    attemptedAt: new Date().toISOString(),
    consumedArchives: [...consumed].toSorted(),
    conflicts: [],
    restoredFiles: [...new Set([...(manifest.restore?.restoredFiles ?? []), move.sourcePath])],
    skippedFiles: [],
    status: "restored",
  };
  writeSessionSqliteMigrationManifest({ manifest, manifestPath });
}

type RestoreManifestContext = {
  manifest: SessionSqliteMigrationManifest;
  manifestPath: string;
  targets: SessionSqliteMigrationTargetManifest[];
};

type RestoreArchiveSnapshot = {
  digest: string;
  legacyEntryCount?: number;
  size: number;
};

type RestoreMovePlan =
  | { action: "conflict"; reason: string }
  | { action: "restore"; snapshot: RestoreArchiveSnapshot }
  | { action: "skip-consumed" }
  | { action: "skip-superseded" }
  | { action: "standard" };

function loadRestoreManifestContexts(
  manifestPaths: readonly string[],
  trustedTargets: readonly SessionSqliteMigrationTargetInput[],
): RestoreManifestContext[] {
  const contexts: RestoreManifestContext[] = [];
  for (const manifestPath of manifestPaths) {
    const stat = statMigrationPath(manifestPath);
    const manifest =
      stat?.isFile() &&
      stat.nlink === 1 &&
      !hasSymbolicLinkInDirectoryPath(path.dirname(manifestPath))
        ? readSessionSqliteMigrationManifest(manifestPath)
        : undefined;
    if (!manifest) {
      continue;
    }
    const targets = filterRestoreManifestTargets(manifest, trustedTargets);
    if (targets.length > 0) {
      contexts.push({ manifest, manifestPath, targets });
    }
  }
  return contexts;
}

/**
 * Resolve every duplicate destination before moving an archive. A missing archive only disappears
 * from the conflict set when its own manifest proves that an earlier restore consumed it.
 */
function createRestorePlan(
  contexts: readonly RestoreManifestContext[],
): Map<string, RestoreMovePlan> {
  const plan = new Map<string, RestoreMovePlan>();
  const candidatesBySource = new Map<
    string,
    Array<{
      consumed: boolean;
      context: RestoreManifestContext;
      move: SessionSqliteMigrationMove;
    }>
  >();
  for (const context of contexts) {
    const consumedArchives = collectRecordedConsumedArchives(context.manifest);
    for (const target of context.targets) {
      for (const move of uniqueRestoreMoves(target)) {
        if (move.artifact && move.artifact.disposal.state !== "retained") {
          plan.set(restoreMovePlanKey(context.manifestPath, move), {
            action: "conflict",
            reason:
              move.artifact.disposal.state === "disposed"
                ? "rollback original was intentionally disposed by update cleanup"
                : "rollback original has pending cleanup; finish cleanup before restore",
          });
          continue;
        }
        const candidates = candidatesBySource.get(move.sourcePath) ?? [];
        candidates.push({
          consumed: consumedArchives.has(move.archivePath),
          context,
          move,
        });
        candidatesBySource.set(move.sourcePath, candidates);
      }
    }
  }

  for (const [sourcePath, candidates] of candidatesBySource) {
    if (fs.existsSync(sourcePath) || candidates.length === 1) {
      for (const candidate of candidates) {
        plan.set(restoreMovePlanKey(candidate.context.manifestPath, candidate.move), {
          action: "standard",
        });
      }
      continue;
    }

    const available: Array<{
      context: RestoreManifestContext;
      move: SessionSqliteMigrationMove;
      snapshot: RestoreArchiveSnapshot;
    }> = [];
    let blocked = false;
    for (const candidate of candidates) {
      const key = restoreMovePlanKey(candidate.context.manifestPath, candidate.move);
      const inspection = inspectRestoreArchive(candidate.move);
      if (inspection.state === "available") {
        available.push({ ...candidate, snapshot: inspection.snapshot });
        continue;
      }
      if (inspection.state === "missing" && candidate.consumed) {
        plan.set(key, { action: "skip-consumed" });
        continue;
      }
      blocked = true;
      plan.set(key, {
        action: "conflict",
        reason:
          inspection.state === "missing"
            ? "archive is missing without a recorded prior restore; refusing another candidate"
            : inspection.reason,
      });
    }

    if (blocked) {
      for (const candidate of available) {
        plan.set(restoreMovePlanKey(candidate.context.manifestPath, candidate.move), {
          action: "conflict",
          reason:
            "another archive for this source is unavailable without prior restore evidence; refusing automatic selection",
        });
      }
      continue;
    }
    if (available.length === 0) {
      continue;
    }

    const kinds = new Set(available.map((candidate) => candidate.move.kind));
    if (kinds.size !== 1) {
      setRestoreCandidateConflicts(
        plan,
        available,
        "recorded archives disagree on artifact kind; refusing automatic selection",
      );
      continue;
    }
    const winner = selectRestoreCandidate(available);
    if (!winner) {
      setRestoreCandidateConflicts(
        plan,
        available,
        available[0]?.move.kind === "legacy-store"
          ? "multiple distinct nonempty session indexes require explicit archive selection"
          : "multiple distinct archives require explicit archive selection",
      );
      continue;
    }
    // Shared owners can repeat one publication. Every copy of its plan key must select
    // the same action, or a later owner overwrites the winner with a skip.
    const winnerKey = restoreMovePlanKey(winner.context.manifestPath, winner.move);
    for (const candidate of available) {
      const candidateKey = restoreMovePlanKey(candidate.context.manifestPath, candidate.move);
      plan.set(
        candidateKey,
        candidateKey === winnerKey
          ? { action: "restore", snapshot: candidate.snapshot }
          : { action: "skip-superseded" },
      );
    }
  }
  return plan;
}

function selectRestoreCandidate<
  T extends { move: SessionSqliteMigrationMove; snapshot: RestoreArchiveSnapshot },
>(candidates: readonly T[]): T | undefined {
  const distinctDigests = new Set(candidates.map((candidate) => candidate.snapshot.digest));
  if (distinctDigests.size === 1) {
    return candidates[0];
  }
  if (candidates[0]?.move.kind !== "legacy-store") {
    return undefined;
  }
  const nonemptyDigests = new Set(
    candidates
      .filter((candidate) => (candidate.snapshot.legacyEntryCount ?? 0) > 0)
      .map((candidate) => candidate.snapshot.digest),
  );
  if (nonemptyDigests.size === 0) {
    return candidates[0];
  }
  return nonemptyDigests.size === 1
    ? candidates.find((candidate) => (candidate.snapshot.legacyEntryCount ?? 0) > 0)
    : undefined;
}

function setRestoreCandidateConflicts(
  plan: Map<string, RestoreMovePlan>,
  candidates: ReadonlyArray<{
    context: RestoreManifestContext;
    move: SessionSqliteMigrationMove;
  }>,
  reason: string,
): void {
  for (const candidate of candidates) {
    plan.set(restoreMovePlanKey(candidate.context.manifestPath, candidate.move), {
      action: "conflict",
      reason,
    });
  }
}

function restoreMovePlanKey(manifestPath: string, move: SessionSqliteMigrationMove): string {
  return `${manifestPath}\u0000${migrationMoveKey(move)}`;
}

export function collectRecordedConsumedArchives(
  manifest: SessionSqliteMigrationManifest,
): Set<string> {
  const consumed = new Set(manifest.restore?.consumedArchives ?? []);
  const restoredSources = new Set(manifest.restore?.restoredFiles ?? []);
  if (restoredSources.size === 0) {
    return consumed;
  }
  const movesBySource = new Map<string, SessionSqliteMigrationMove[]>();
  for (const target of manifest.targets) {
    for (const move of uniqueRestoreMoves(target)) {
      const moves = movesBySource.get(move.sourcePath) ?? [];
      moves.push(move);
      movesBySource.set(move.sourcePath, moves);
    }
  }
  // Older shipped manifests only recorded restored source paths. Preserve that evidence when the
  // source identifies exactly one archive, then persist the explicit archive path on this run.
  for (const sourcePath of restoredSources) {
    const moves = movesBySource.get(sourcePath);
    const move = moves?.length === 1 ? moves[0] : undefined;
    if (move) {
      consumed.add(move.archivePath);
    }
  }
  return consumed;
}

type RestoreArchiveInspection =
  | { state: "available"; snapshot: RestoreArchiveSnapshot }
  | { state: "invalid"; reason: string }
  | { state: "missing" };

function hashRestoreArchive(fd: number, size: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(RESTORE_ARCHIVE_HASH_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (read === 0) {
      throw new Error("archive changed while it was inspected");
    }
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return hash.digest("hex");
}

function inspectRestoreArchive(move: SessionSqliteMigrationMove): RestoreArchiveInspection {
  if (hasSymbolicLinkInDirectoryPath(path.dirname(move.archivePath))) {
    return { state: "invalid", reason: "archive parent is a symbolic link; refusing restore" };
  }
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(move.archivePath);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { state: "missing" }
      : { state: "invalid", reason: "archive could not be inspected; refusing restore" };
  }
  if (!pathStat.isFile()) {
    return { state: "invalid", reason: "archive is not a regular file; refusing restore" };
  }

  let fd: number | undefined;
  try {
    const flags =
      process.platform === "win32"
        ? "r"
        : fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(move.archivePath, flags);
    const descriptorStat = fs.fstatSync(fd);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino
    ) {
      return {
        state: "invalid",
        reason: "archive changed while it was inspected; refusing restore",
      };
    }
    let digest: string;
    let legacyEntryCount: number | undefined;
    if (move.kind === "legacy-store") {
      const content = readFileDescriptorBoundedSync(fd, descriptorStat.size);
      digest = createHash("sha256").update(content).digest("hex");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content.toString("utf-8"));
      } catch {
        return {
          state: "invalid",
          reason: "session index archive is not valid JSON; refusing automatic selection",
        };
      }
      if (!isRecord(parsed)) {
        return {
          state: "invalid",
          reason: "session index archive is not a JSON object; refusing automatic selection",
        };
      }
      legacyEntryCount = Object.keys(parsed).length;
    } else {
      // Transcript-like archives can be arbitrarily large. Hash them incrementally so duplicate
      // planning cannot turn a Doctor restore into a synchronous whole-file allocation.
      digest = hashRestoreArchive(fd, descriptorStat.size);
    }
    const finalPathStat = fs.lstatSync(move.archivePath);
    if (
      finalPathStat.dev !== descriptorStat.dev ||
      finalPathStat.ino !== descriptorStat.ino ||
      finalPathStat.size !== descriptorStat.size
    ) {
      return {
        state: "invalid",
        reason: "archive changed while it was inspected; refusing restore",
      };
    }
    return {
      state: "available",
      snapshot: {
        digest,
        ...(legacyEntryCount === undefined ? {} : { legacyEntryCount }),
        size: descriptorStat.size,
      },
    };
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { state: "missing" }
      : { state: "invalid", reason: "archive could not be read safely; refusing restore" };
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export async function restoreSessionSqliteMigrationRun(params: {
  env?: NodeJS.ProcessEnv;
  manifestPath: string;
  trustedTargets: readonly SessionSqliteMigrationTargetInput[];
}): Promise<DoctorSessionSqliteRestoreReport> {
  const restoreReport: DoctorSessionSqliteRestoreReport = {
    ...emptyRestoreReport(),
    manifestPaths: [params.manifestPath],
  };
  const manifest = readSessionSqliteMigrationManifest(params.manifestPath);
  if (!manifest) {
    restoreReport.conflicts.push({
      archivePath: params.manifestPath,
      reason: "manifest is missing or unreadable",
      sourcePath: params.manifestPath,
    });
    return restoreReport;
  }
  const targetManifests = filterRestoreManifestTargets(manifest, params.trustedTargets);
  if (targetManifests.length === 0) {
    restoreReport.conflicts.push({
      archivePath: params.manifestPath,
      reason: "manifest does not match a trusted session target",
      sourcePath: params.manifestPath,
    });
    return restoreReport;
  }
  await reconcileRestorePublications(
    [{ manifest, manifestPath: params.manifestPath, targets: targetManifests }],
    params.env ?? process.env,
  );
  await restoreSessionSqliteMigrationManifest(
    manifest,
    params.manifestPath,
    targetManifests,
    restoreReport,
    createRestorePlan([
      {
        manifest,
        manifestPath: params.manifestPath,
        targets: targetManifests,
      },
    ]),
  );
  writeSessionSqliteMigrationManifest({ manifest, manifestPath: params.manifestPath });
  return restoreReport;
}

function emptyRestoreReport(): DoctorSessionSqliteRestoreReport {
  return {
    conflicts: [],
    manifestPaths: [],
    restoredFiles: [],
    skippedFiles: [],
  };
}

async function restoreSessionSqliteMigrationManifest(
  manifest: SessionSqliteMigrationManifest,
  manifestPath: string,
  targets: readonly SessionSqliteMigrationTargetManifest[],
  restoreReport: DoctorSessionSqliteRestoreReport,
  restorePlan: ReadonlyMap<string, RestoreMovePlan>,
): Promise<void> {
  for (const target of targets) {
    for (const move of uniqueRestoreMoves(target)) {
      await restoreMigrationMove({
        manifest,
        manifestPath,
        target,
        move,
        restorePlan,
        restoreReport,
      });
    }
  }
  const consumedArchives = collectRecordedConsumedArchives(manifest);
  manifest.restore = {
    attemptedAt: new Date().toISOString(),
    ...(consumedArchives.size > 0 ? { consumedArchives: [...consumedArchives].toSorted() } : {}),
    conflicts: restoreReport.conflicts,
    restoredFiles: restoreReport.restoredFiles,
    skippedFiles: restoreReport.skippedFiles,
    status: resolveRestoreStatus(restoreReport),
  };
}

async function restoreMigrationMove(params: {
  manifest: SessionSqliteMigrationManifest;
  manifestPath: string;
  target: SessionSqliteMigrationTargetManifest;
  move: SessionSqliteMigrationMove;
  restorePlan: ReadonlyMap<string, RestoreMovePlan>;
  restoreReport: DoctorSessionSqliteRestoreReport;
}): Promise<void> {
  const { manifest, manifestPath, target, move, restorePlan, restoreReport } = params;
  const recordConflict = (reason: string) => {
    restoreReport.conflicts.push({
      archivePath: move.archivePath,
      reason,
      sourcePath: move.sourcePath,
    });
  };
  const planned = restorePlan.get(restoreMovePlanKey(manifestPath, move)) ?? { action: "standard" };
  if (planned.action === "conflict") {
    recordConflict(planned.reason);
    return;
  }
  if (planned.action === "skip-consumed" || planned.action === "skip-superseded") {
    restoreReport.skippedFiles.push(move.sourcePath);
    return;
  }
  const sourceExists = statMigrationPath(move.sourcePath) !== undefined;
  const archiveExists = statMigrationPath(move.archivePath) !== undefined;
  if (sourceExists || !archiveExists) {
    if (sourceExists && !archiveExists) {
      restoreReport.skippedFiles.push(move.sourcePath);
    } else {
      recordConflict(
        sourceExists
          ? "source and archive both exist; refusing to overwrite source"
          : "source and archive are both missing",
      );
    }
    return;
  }
  try {
    if (!isRegularFileWithoutFollowingSymlinks(move.archivePath)) {
      throw new Error("archive is not a regular file; refusing restore");
    }
    assertRestoreDirectories(move);
    fs.mkdirSync(path.dirname(move.sourcePath), { recursive: true, mode: 0o700 });
    assertRestoreDirectories(move);
    const identity = move.artifact?.identity ?? readMigrationArtifactIdentity(move.archivePath);
    // Publication rechecks these exact bytes; matching the plan also preserves its index count.
    if (
      planned.action === "restore" &&
      (identity.sha256 !== planned.snapshot.digest || identity.size !== planned.snapshot.size)
    ) {
      throw new Error("archive changed after restore planning; refusing restore");
    }
    if (!move.artifact) {
      // Historical manifests need an identity before the first link so a crash is retryable.
      // This proves the original's identity, not its import; cleanup must keep it protected.
      move.artifact = {
        identity,
        classification: "protected",
        reason: "historical-restore-original",
        dependencies:
          move.kind === "legacy-store"
            ? uniqueRestoreMoves(target)
                .filter((item) => item.kind === "transcript")
                .map((item) => item.sourcePath)
            : [],
        disposal: { state: "retained" },
      };
      for (const recorded of [...target.plannedMoves, ...target.completedMoves]) {
        if (migrationMoveKey(recorded) === migrationMoveKey(move)) {
          recorded.artifact = move.artifact;
        }
      }
      writeSessionSqliteMigrationManifest({ manifest, manifestPath });
    }
    await moveMigrationArtifact(move.archivePath, move.sourcePath, move.artifact.identity, () => {
      assertRestoreDirectories(move);
      recordRestoredMigrationMove(manifest, manifestPath, move);
    });
    restoreReport.restoredFiles.push(move.sourcePath);
  } catch (error) {
    recordConflict(error instanceof Error ? error.message : String(error));
  }
}

function assertRestoreDirectories(move: SessionSqliteMigrationMove): void {
  if (
    hasSymbolicLinkInDirectoryPath(path.dirname(move.sourcePath)) ||
    hasSymbolicLinkInDirectoryPath(path.dirname(move.archivePath))
  ) {
    throw new Error("source or archive parent is a symbolic link; refusing restore");
  }
}

function resolveRestoreStatus(
  report: DoctorSessionSqliteRestoreReport,
): NonNullable<SessionSqliteMigrationManifest["restore"]>["status"] {
  if (report.conflicts.length > 0 && report.restoredFiles.length > 0) {
    return "partial";
  }
  if (report.conflicts.length > 0) {
    return "conflicts";
  }
  if (report.restoredFiles.length > 0) {
    return "restored";
  }
  return "noop";
}
