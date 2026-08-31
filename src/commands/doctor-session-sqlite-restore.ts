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
import { inspectOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db.js";
import {
  assertMigrationArtifactPublication,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
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

export function restoreSessionSqliteMigrationRuns(params: {
  env: NodeJS.ProcessEnv;
  trustedTargets: readonly SessionSqliteMigrationTargetInput[];
}): DoctorSessionSqliteRestoreReport {
  const restoreReport: DoctorSessionSqliteRestoreReport = emptyRestoreReport();
  const contexts = loadRestoreManifestContexts(
    listSessionSqliteMigrationManifestPaths(params.env).toReversed(),
    params.trustedTargets,
  );
  reconcileRestorePublications(contexts, params.env);
  const restorePlan = createRestorePlan(contexts);
  for (const { manifest, manifestPath, targets } of contexts) {
    const manifestRestoreReport: DoctorSessionSqliteRestoreReport = {
      ...emptyRestoreReport(),
      manifestPaths: [manifestPath],
    };
    restoreReport.manifestPaths.push(manifestPath);
    restoreSessionSqliteMigrationManifest(
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
export function reconcileSessionSqliteMigrationPublications(params: {
  env: NodeJS.ProcessEnv;
  trustedTargets: readonly SessionSqliteMigrationTargetInput[];
  sourcePath?: string;
}): void {
  reconcileRestorePublications(
    loadRestoreManifestContexts(
      listSessionSqliteMigrationManifestPaths(params.env),
      params.trustedTargets,
    ),
    params.env,
    params.sourcePath,
  );
}

function reconcileRestorePublications(
  contexts: readonly RestoreManifestContext[],
  env: NodeJS.ProcessEnv,
  sourcePath?: string,
): void {
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
        const owner = inspectOpenClawAgentDatabaseOwner(target.sqlitePath);
        if (owner.status !== "owned" || owner.agentId !== target.agentId) {
          throw new Error("Cannot reconcile publication without the current destination owner");
        }
        assertMigrationArtifactPublication(
          move.sourcePath,
          move.archivePath,
          move.artifact.identity,
        );
        // The original already exists at its source. Record that restoration before removing the
        // archive name, so a crash cannot turn a consumed original into unexplained missing history.
        const consumed = collectRecordedConsumedArchives(context.manifest);
        consumed.add(move.archivePath);
        context.manifest.restore = {
          attemptedAt: new Date().toISOString(),
          consumedArchives: [...consumed].toSorted(),
          conflicts: [],
          restoredFiles: [
            ...new Set([...(context.manifest.restore?.restoredFiles ?? []), move.sourcePath]),
          ],
          skippedFiles: [],
          status: "restored",
        };
        writeSessionSqliteMigrationManifest(context);
        requireDirectorySync(
          syncDirectorySync(path.dirname(context.manifestPath)),
          "Recovery restoration receipt",
        );
        assertSafeSessionSqliteMigrationMove(move, target);
        assertMigrationArtifactPublication(
          move.sourcePath,
          move.archivePath,
          move.artifact.identity,
        );
        fs.unlinkSync(move.archivePath);
        requireDirectorySync(
          syncDirectorySync(path.dirname(move.archivePath)),
          "Recovery publication reconciliation",
        );
        if (
          !sameMigrationArtifact(
            readMigrationArtifactIdentity(move.sourcePath),
            move.artifact.identity,
          )
        ) {
          throw new Error("Restored publication source changed");
        }
      }
    }
  }
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

export function restoreSessionSqliteMigrationRun(params: {
  env?: NodeJS.ProcessEnv;
  manifestPath: string;
  trustedTargets: readonly SessionSqliteMigrationTargetInput[];
}): DoctorSessionSqliteRestoreReport {
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
  reconcileRestorePublications(
    [{ manifest, manifestPath: params.manifestPath, targets: targetManifests }],
    params.env ?? process.env,
  );
  restoreSessionSqliteMigrationManifest(
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

function restoreSessionSqliteMigrationManifest(
  manifest: SessionSqliteMigrationManifest,
  manifestPath: string,
  targets: readonly SessionSqliteMigrationTargetManifest[],
  restoreReport: DoctorSessionSqliteRestoreReport,
  restorePlan: ReadonlyMap<string, RestoreMovePlan>,
): void {
  const consumedArchives = collectRecordedConsumedArchives(manifest);
  for (const target of targets) {
    for (const move of uniqueRestoreMoves(target)) {
      restoreMigrationMove({
        consumedArchives,
        manifestPath,
        move,
        restorePlan,
        restoreReport,
      });
    }
  }
  manifest.restore = {
    attemptedAt: new Date().toISOString(),
    ...(consumedArchives.size > 0 ? { consumedArchives: [...consumedArchives].toSorted() } : {}),
    conflicts: restoreReport.conflicts,
    restoredFiles: restoreReport.restoredFiles,
    skippedFiles: restoreReport.skippedFiles,
    status: resolveRestoreStatus(restoreReport),
  };
}

function restoreMigrationMove(params: {
  consumedArchives: Set<string>;
  manifestPath: string;
  move: SessionSqliteMigrationMove;
  restorePlan: ReadonlyMap<string, RestoreMovePlan>;
  restoreReport: DoctorSessionSqliteRestoreReport;
}): void {
  const { consumedArchives, manifestPath, move, restorePlan, restoreReport } = params;
  const planned = restorePlan.get(restoreMovePlanKey(manifestPath, move)) ?? {
    action: "standard",
  };
  if (planned.action === "conflict") {
    restoreReport.conflicts.push({
      archivePath: move.archivePath,
      reason: planned.reason,
      sourcePath: move.sourcePath,
    });
    return;
  }
  if (planned.action === "skip-consumed" || planned.action === "skip-superseded") {
    restoreReport.skippedFiles.push(move.sourcePath);
    return;
  }
  const sourceExists = fs.existsSync(move.sourcePath);
  const archiveExists = fs.existsSync(move.archivePath);
  if (!sourceExists && archiveExists) {
    if (planned.action === "restore") {
      const inspection = inspectRestoreArchive(move);
      if (
        inspection.state !== "available" ||
        inspection.snapshot.digest !== planned.snapshot.digest ||
        inspection.snapshot.size !== planned.snapshot.size ||
        inspection.snapshot.legacyEntryCount !== planned.snapshot.legacyEntryCount
      ) {
        restoreReport.conflicts.push({
          archivePath: move.archivePath,
          reason: "archive changed after restore planning; refusing restore",
          sourcePath: move.sourcePath,
        });
        return;
      }
    }
    if (!isRegularFileWithoutFollowingSymlinks(move.archivePath)) {
      restoreReport.conflicts.push({
        archivePath: move.archivePath,
        reason: "archive is not a regular file; refusing restore",
        sourcePath: move.sourcePath,
      });
      return;
    }
    const sourceDir = path.dirname(move.sourcePath);
    const archiveDir = path.dirname(move.archivePath);
    if (hasSymbolicLinkInDirectoryPath(sourceDir) || hasSymbolicLinkInDirectoryPath(archiveDir)) {
      restoreReport.conflicts.push({
        archivePath: move.archivePath,
        reason: "source or archive parent is a symbolic link; refusing restore",
        sourcePath: move.sourcePath,
      });
      return;
    }
    fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
    if (hasSymbolicLinkInDirectoryPath(sourceDir) || hasSymbolicLinkInDirectoryPath(archiveDir)) {
      restoreReport.conflicts.push({
        archivePath: move.archivePath,
        reason: "source or archive parent is a symbolic link; refusing restore",
        sourcePath: move.sourcePath,
      });
      return;
    }
    fs.renameSync(move.archivePath, move.sourcePath);
    consumedArchives.add(move.archivePath);
    restoreReport.restoredFiles.push(move.sourcePath);
    return;
  }
  if (sourceExists && !archiveExists) {
    restoreReport.skippedFiles.push(move.sourcePath);
    return;
  }
  if (sourceExists && archiveExists) {
    restoreReport.conflicts.push({
      archivePath: move.archivePath,
      reason: "source and archive both exist; refusing to overwrite source",
      sourcePath: move.sourcePath,
    });
    return;
  }
  restoreReport.conflicts.push({
    archivePath: move.archivePath,
    reason: "source and archive are both missing",
    sourcePath: move.sourcePath,
  });
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
  if (report.skippedFiles.length > 0) {
    return "noop";
  }
  return "noop";
}
