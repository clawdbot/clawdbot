/** Manifest and restore helpers for doctor-owned session SQLite migrations. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import * as replaceFile from "../infra/replace-file.js";
import { VERSION } from "../version.js";
import type {
  DoctorSessionSqliteIssue,
  DoctorSessionSqliteRestoreConflict,
  DoctorSessionSqliteRestoreReport,
  SessionSqliteMigrationFailureIssue,
} from "./doctor-session-sqlite-types.js";

export type SessionSqliteMigrationMoveKind =
  | "legacy-store"
  | "transcript"
  | "trajectory"
  | "unreferenced-jsonl";

export type SessionSqliteMigrationMove = {
  archivePath: string;
  kind: SessionSqliteMigrationMoveKind;
  sessionKey?: string;
  sourcePath: string;
};

export type SessionSqliteMigrationTargetInput = {
  agentId: string;
  sqlitePath: string;
  storePath: string;
};

type SessionSqliteMigrationTargetManifest = SessionSqliteMigrationTargetInput & {
  completedMoves: SessionSqliteMigrationMove[];
  issues: DoctorSessionSqliteIssue[];
  plannedMoves: SessionSqliteMigrationMove[];
  validationBeforeArchive: "not_run" | "passed" | "failed";
};

type SessionSqliteMigrationManifest = {
  completedAt?: string;
  failedAt?: string;
  failureReports?: {
    jsonPath: string;
    markdownPath: string;
  };
  manifestVersion: 1 | 2;
  openClawVersion: string;
  restore?: {
    attemptedAt: string;
    consumedArchives?: string[];
    conflicts: DoctorSessionSqliteRestoreConflict[];
    restoredFiles: string[];
    skippedFiles: string[];
    status: "restored" | "partial" | "conflicts" | "failed" | "noop";
  };
  runId: string;
  startedAt: string;
  targets: SessionSqliteMigrationTargetManifest[];
};

export type ActiveSessionSqliteMigrationRun = {
  manifest: SessionSqliteMigrationManifest;
  manifestPath: string;
};

const SESSION_SQLITE_MIGRATION_RUNS_DIR = "session-sqlite-migration-runs";
const COMPLETED_MIGRATION_RUN_RETENTION = 50;
const RESTORE_ARCHIVE_HASH_CHUNK_BYTES = 64 * 1024;
const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0") && path.isAbsolute(value))
  .transform((value) => path.resolve(value));
const MigrationMoveSchema = z.object({
  archivePath: AbsolutePathSchema,
  kind: z.enum(["legacy-store", "transcript", "trajectory", "unreferenced-jsonl"]),
  sessionKey: z.string().optional(),
  sourcePath: AbsolutePathSchema,
});
const MigrationIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  sessionKey: z.string().optional(),
});
const RestoreConflictSchema = z.object({
  archivePath: AbsolutePathSchema,
  reason: z.string(),
  sourcePath: AbsolutePathSchema,
});
const MigrationTargetSchema = z
  .object({
    agentId: z.string().min(1),
    completedMoves: z.array(MigrationMoveSchema),
    issues: z.array(MigrationIssueSchema),
    plannedMoves: z.array(MigrationMoveSchema),
    sqlitePath: AbsolutePathSchema,
    storePath: AbsolutePathSchema,
    validationBeforeArchive: z.enum(["not_run", "passed", "failed"]),
  })
  .superRefine((target, context) => {
    const plannedMoveKeys = new Set<string>();
    for (const move of target.plannedMoves) {
      if (!isRestoreMoveWithinTarget(move, target)) {
        context.addIssue({ code: "custom", message: "restore move is outside target paths" });
      }
      const moveKey = migrationMoveKey(move);
      if (plannedMoveKeys.has(moveKey)) {
        context.addIssue({ code: "custom", message: "duplicate planned restore move" });
      }
      plannedMoveKeys.add(moveKey);
    }
    const completedMoveKeys = new Set<string>();
    for (const move of target.completedMoves) {
      const moveKey = migrationMoveKey(move);
      if (
        !isRestoreMoveWithinTarget(move, target) ||
        !plannedMoveKeys.has(moveKey) ||
        completedMoveKeys.has(moveKey)
      ) {
        context.addIssue({ code: "custom", message: "invalid completed restore move" });
      }
      completedMoveKeys.add(moveKey);
    }
  });
const MigrationManifestSchema = z
  .object({
    completedAt: z.string().optional(),
    failedAt: z.string().optional(),
    failureReports: z
      .object({
        jsonPath: AbsolutePathSchema,
        markdownPath: AbsolutePathSchema,
      })
      .optional(),
    manifestVersion: z.union([z.literal(1), z.literal(2)]),
    openClawVersion: z.string().min(1),
    restore: z
      .object({
        attemptedAt: z.string().min(1),
        consumedArchives: z.array(AbsolutePathSchema).optional(),
        conflicts: z.array(RestoreConflictSchema),
        restoredFiles: z.array(AbsolutePathSchema),
        skippedFiles: z.array(AbsolutePathSchema),
        status: z.enum(["restored", "partial", "conflicts", "failed", "noop"]),
      })
      .optional(),
    runId: z.string().min(1),
    startedAt: z.string().min(1),
    targets: z.array(MigrationTargetSchema),
  })
  .superRefine((manifest, context) => {
    const targetKeys = new Set<string>();
    for (const target of manifest.targets) {
      const targetKey = sessionSqliteMigrationTargetKey(target);
      if (targetKeys.has(targetKey)) {
        context.addIssue({ code: "custom", message: "duplicate migration target" });
      }
      targetKeys.add(targetKey);
    }
  });

export function createSessionSqliteMigrationRun(
  env: NodeJS.ProcessEnv,
  targets: readonly SessionSqliteMigrationTargetInput[],
): ActiveSessionSqliteMigrationRun {
  for (const target of targets) {
    assertSafeMigrationTargetTopology(target);
  }
  const runId = `session-sqlite-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const manifestPath = path.join(resolveSessionSqliteMigrationRunsDir(env), `${runId}.json`);
  const manifest: SessionSqliteMigrationManifest = {
    manifestVersion: 2,
    openClawVersion: VERSION,
    runId,
    startedAt: new Date().toISOString(),
    targets: targets.map((target) => ({
      ...normalizeMigrationTarget(target),
      completedMoves: [],
      issues: [],
      plannedMoves: [],
      validationBeforeArchive: "not_run",
    })),
  };
  const activeRun = { manifest, manifestPath };
  writeSessionSqliteMigrationManifest(activeRun);
  pruneCompletedSessionSqliteMigrationRuns(env);
  return activeRun;
}

export function resolveSessionSqliteMigrationRunsDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), SESSION_SQLITE_MIGRATION_RUNS_DIR);
}

export function writeSessionSqliteMigrationManifest(
  activeRun: ActiveSessionSqliteMigrationRun,
): void {
  fs.mkdirSync(path.dirname(activeRun.manifestPath), { recursive: true, mode: 0o700 });
  replaceFile.replaceFileAtomicSync({
    filePath: activeRun.manifestPath,
    content: `${JSON.stringify(activeRun.manifest, null, 2)}\n`,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: path.basename(activeRun.manifestPath),
  });
}

export function updateMigrationManifestTarget(
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
  target: SessionSqliteMigrationTargetInput,
  issues: readonly DoctorSessionSqliteIssue[],
  updates: {
    validationBeforeArchive?: SessionSqliteMigrationTargetManifest["validationBeforeArchive"];
  } = {},
): void {
  const manifestTarget = findMigrationManifestTarget(activeRun, target);
  if (!activeRun || !manifestTarget) {
    return;
  }
  manifestTarget.issues = issues.map((issue) => ({ ...issue }));
  if (updates.validationBeforeArchive) {
    manifestTarget.validationBeforeArchive = updates.validationBeforeArchive;
  }
  writeSessionSqliteMigrationManifest(activeRun);
}

export function recordPlannedMigrationMoves(
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
  target: SessionSqliteMigrationTargetInput,
  moves: readonly SessionSqliteMigrationMove[],
): void {
  recordMigrationMoves(activeRun, target, "plannedMoves", moves);
}

export function recordCompletedMigrationMoves(
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
  target: SessionSqliteMigrationTargetInput,
  moves: readonly SessionSqliteMigrationMove[],
): void {
  recordMigrationMoves(activeRun, target, "completedMoves", moves);
}

function recordMigrationMoves(
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
  target: SessionSqliteMigrationTargetInput,
  listKey: "completedMoves" | "plannedMoves",
  moves: readonly SessionSqliteMigrationMove[],
): void {
  const manifestTarget = findMigrationManifestTarget(activeRun, target);
  if (!activeRun || !manifestTarget || moves.length === 0) {
    return;
  }
  const targetMoves = manifestTarget[listKey];
  const knownMoves = new Set(targetMoves.map(migrationMoveKey));
  let changed = false;
  for (const move of moves) {
    const normalizedMove = normalizeMigrationMove(move);
    const key = migrationMoveKey(normalizedMove);
    if (knownMoves.has(key)) {
      continue;
    }
    knownMoves.add(key);
    targetMoves.push(normalizedMove);
    changed = true;
  }
  if (changed) {
    writeSessionSqliteMigrationManifest(activeRun);
  }
}

function migrationMoveKey(move: SessionSqliteMigrationMove): string {
  return `${move.sourcePath}\u0000${move.archivePath}`;
}

export function restoreSessionSqliteMigrationRuns(params: {
  env: NodeJS.ProcessEnv;
  trustedTargets: readonly SessionSqliteMigrationTargetInput[];
}): DoctorSessionSqliteRestoreReport {
  const restoreReport: DoctorSessionSqliteRestoreReport = emptyRestoreReport();
  const contexts = loadRestoreManifestContexts(
    listSessionSqliteMigrationManifestPaths(params.env).toReversed(),
    params.trustedTargets,
  );
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
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
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
    for (const candidate of available) {
      plan.set(
        restoreMovePlanKey(candidate.context.manifestPath, candidate.move),
        candidate === winner
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

function collectRecordedConsumedArchives(manifest: SessionSqliteMigrationManifest): Set<string> {
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
    const code = (error as NodeJS.ErrnoException).code;
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
    const code = (error as NodeJS.ErrnoException).code;
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

export function findLatestFailedSessionSqliteMigrationManifest(
  env: NodeJS.ProcessEnv,
  trustedTargets: readonly SessionSqliteMigrationTargetInput[],
):
  | {
      manifest: SessionSqliteMigrationManifest;
      manifestPath: string;
      targets: SessionSqliteMigrationTargetManifest[];
    }
  | undefined {
  return listSessionSqliteMigrationManifestPaths(env)
    .map((manifestPath) => {
      const manifest = readSessionSqliteMigrationManifest(manifestPath);
      return {
        manifest,
        manifestPath,
        targets: manifest ? filterRestoreManifestTargets(manifest, trustedTargets) : [],
      };
    })
    .filter(
      (
        item,
      ): item is {
        manifest: SessionSqliteMigrationManifest;
        manifestPath: string;
        targets: SessionSqliteMigrationTargetManifest[];
      } =>
        item.manifest !== undefined &&
        isFailedSessionSqliteMigrationManifest(item.manifest) &&
        item.targets.length > 0,
    )
    .toSorted(
      (left, right) => manifestSortTime(right.manifest) - manifestSortTime(left.manifest),
    )[0];
}

export function writeSessionSqliteMigrationFailureReports(
  manifestPath: string,
  params: { reason: string },
): { jsonPath: string; markdownPath: string } {
  const manifest = readSessionSqliteMigrationManifest(manifestPath);
  const jsonPath = manifestPath.replace(/\.json$/, ".failure.json");
  const markdownPath = manifestPath.replace(/\.json$/, ".failure.md");
  const payload = {
    generatedAt: new Date().toISOString(),
    manifestPath: sanitizeFailureReportText(shortenFailureReportPath(manifestPath)),
    reason: params.reason,
    recoveryCommand: "openclaw doctor --session-sqlite recover --github-issue",
    restoreStatus: manifest?.restore?.status ?? "not_attempted",
    runId: manifest?.runId ?? path.basename(manifestPath, ".json"),
    targets:
      manifest?.targets.map((target) => ({
        agentId: sanitizeFailureReportText(target.agentId),
        completedMoves: target.completedMoves.length,
        issues: target.issues.map((issue) => ({
          code: issue.code,
          message: sanitizeFailureIssueMessage(issue, target),
          ...(issue.sessionKey ? { sessionKey: redactSessionKey(issue.sessionKey) } : {}),
        })),
        plannedMoves: target.plannedMoves.length,
        sqlitePath: sanitizeFailureReportText(shortenFailureReportPath(target.sqlitePath)),
        storePath: sanitizeFailureReportText(shortenFailureReportPath(target.storePath)),
        validationBeforeArchive: target.validationBeforeArchive,
      })) ?? [],
    version: VERSION,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(markdownPath, renderFailureMarkdown(payload), { mode: 0o600 });
  if (manifest) {
    manifest.failureReports = { jsonPath, markdownPath };
    writeSessionSqliteMigrationManifest({ manifest, manifestPath });
  }
  return { jsonPath, markdownPath };
}

export function createSessionSqliteMigrationFailureIssue(
  manifestPath: string,
  trustedTargets?: readonly SessionSqliteMigrationTargetInput[],
): SessionSqliteMigrationFailureIssue | undefined {
  const manifest = readSessionSqliteMigrationManifest(manifestPath);
  if (!manifest) {
    return undefined;
  }
  const title = `Session SQLite migration recovery report (${manifest.runId})`;
  const bodyPath = manifest.failureReports?.markdownPath;
  const targets = trustedTargets
    ? filterRestoreManifestTargets(manifest, trustedTargets)
    : manifest.targets;
  const reportBody = renderFailureMarkdown({
    generatedAt: new Date().toISOString(),
    manifestPath: sanitizeFailureReportText(shortenFailureReportPath(manifestPath)),
    reason: "session SQLite migration failed",
    recoveryCommand: "openclaw doctor --session-sqlite recover --github-issue",
    restoreStatus: manifest.restore?.status ?? "not_attempted",
    runId: manifest.runId,
    targets: targets.map((target) => ({
      agentId: sanitizeFailureReportText(target.agentId),
      completedMoves: target.completedMoves.length,
      issues: target.issues.map((issue) => ({
        code: issue.code,
        message: sanitizeFailureIssueMessage(issue, target),
      })),
      plannedMoves: target.plannedMoves.length,
      sqlitePath: sanitizeFailureReportText(shortenFailureReportPath(target.sqlitePath)),
      storePath: sanitizeFailureReportText(shortenFailureReportPath(target.storePath)),
      validationBeforeArchive: target.validationBeforeArchive,
    })),
    version: VERSION,
  });
  const body = [
    "OpenClaw doctor generated this sanitized report from a local session SQLite migration recovery.",
    "",
    reportBody,
  ].join("\n");
  const boundedBody = truncateUtf16Safe(body, 20_000);
  return {
    body: boundedBody,
    ...(bodyPath ? { bodyPath } : {}),
    title,
    url: createPrefilledGithubIssueUrl(title, boundedBody),
  };
}

function sessionSqliteMigrationTargetKey(target: { agentId: string; storePath: string }): string {
  return `${target.agentId}\u0000${canonicalMigrationFilePath(target.storePath)}`;
}

function findMigrationManifestTarget(
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
  target: SessionSqliteMigrationTargetInput,
): SessionSqliteMigrationTargetManifest | undefined {
  if (!activeRun) {
    return undefined;
  }
  return activeRun.manifest.targets.find(
    (item) => sessionSqliteMigrationTargetKey(item) === sessionSqliteMigrationTargetKey(target),
  );
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

function uniqueRestoreMoves(
  target: SessionSqliteMigrationTargetManifest,
): SessionSqliteMigrationMove[] {
  const moves = new Map<string, SessionSqliteMigrationMove>();
  for (const move of [...target.completedMoves, ...target.plannedMoves]) {
    moves.set(`${move.sourcePath}\u0000${move.archivePath}`, move);
  }
  return [...moves.values()];
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

export function assertSafeSessionSqliteMigrationMove(
  move: SessionSqliteMigrationMove,
  target: SessionSqliteMigrationTargetInput,
): void {
  if (!isRestoreMoveWithinTarget(move, target)) {
    throw new Error(
      `Migration source is outside the target sessions directory: ${move.sourcePath}`,
    );
  }
  if (!isRegularFileWithoutFollowingSymlinks(move.sourcePath)) {
    throw new Error(`Migration source is not a regular file: ${move.sourcePath}`);
  }
  assertSafeSessionSqliteMigrationDirectory(path.dirname(move.sourcePath));
  assertSafeSessionSqliteMigrationDirectory(path.dirname(move.archivePath));
}

export function assertSafeSessionSqliteMigrationDirectory(directoryPath: string): void {
  if (hasSymbolicLinkInDirectoryPath(directoryPath)) {
    throw new Error(`Refusing session SQLite migration through symbolic link: ${directoryPath}`);
  }
}

function isRegularFileWithoutFollowingSymlinks(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function hasSymbolicLinkInDirectoryPath(directoryPath: string): boolean {
  const resolvedPath = path.resolve(directoryPath);
  const root = path.parse(resolvedPath).root;
  let currentPath = root;
  for (const segment of path.relative(root, resolvedPath).split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    try {
      if (fs.lstatSync(currentPath).isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      return true;
    }
  }
  return false;
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

function filterRestoreManifestTargets(
  manifest: SessionSqliteMigrationManifest,
  trustedTargets: readonly SessionSqliteMigrationTargetInput[],
): SessionSqliteMigrationTargetManifest[] {
  if (trustedTargets.length === 0) {
    return [];
  }
  const trustedSqlitePaths = new Map(
    trustedTargets.map((target) => [
      sessionSqliteMigrationTargetKey(target),
      canonicalMigrationFilePath(target.sqlitePath),
    ]),
  );
  return manifest.targets.filter(
    (target) =>
      trustedSqlitePaths.get(sessionSqliteMigrationTargetKey(target)) ===
      canonicalMigrationFilePath(target.sqlitePath),
  );
}

function listSessionSqliteMigrationManifestPaths(env: NodeJS.ProcessEnv): string[] {
  const runsDir = resolveSessionSqliteMigrationRunsDir(env);
  let entries: string[];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .filter((entry) => !entry.endsWith(".failure.json"))
    .map((entry) => path.join(runsDir, entry))
    .toSorted((left, right) => right.localeCompare(left));
}

function readSessionSqliteMigrationManifest(
  manifestPath: string,
): SessionSqliteMigrationManifest | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
    const result = MigrationManifestSchema.safeParse(parsed);
    if (!result.success) {
      return undefined;
    }
    if (result.data.manifestVersion === 1) {
      if (hasUnsupportedV1DirectorySymlink(result.data)) {
        return undefined;
      }
      const normalized = {
        ...result.data,
        targets: result.data.targets.map(normalizeMigrationTargetManifest),
      };
      const normalizedResult = MigrationManifestSchema.safeParse(normalized);
      return normalizedResult.success
        ? (normalizedResult.data as SessionSqliteMigrationManifest)
        : undefined;
    }
    // New manifests are canonicalized when written. Do not realpath retained entries here:
    // a symlink inserted after the write must remain visible to the restore safety checks.
    return result.data as SessionSqliteMigrationManifest;
  } catch {
    return undefined;
  }
}

function isRestoreMoveWithinTarget(
  move: SessionSqliteMigrationMove,
  target: Pick<SessionSqliteMigrationTargetManifest, "storePath">,
): boolean {
  const sourcePath = path.resolve(move.sourcePath);
  const archivePath = path.resolve(move.archivePath);
  if (sourcePath === archivePath) {
    return false;
  }
  const storePath = path.resolve(target.storePath);
  const sessionsDir = path.dirname(storePath);
  const archiveDir = path.join(path.dirname(sessionsDir), "session-sqlite-import-archive");
  if (path.dirname(archivePath) !== archiveDir) {
    return false;
  }
  return move.kind === "legacy-store"
    ? sourcePath === storePath
    : path.dirname(sourcePath) === sessionsDir;
}

function normalizeMigrationTarget(
  target: SessionSqliteMigrationTargetInput,
): SessionSqliteMigrationTargetInput {
  return {
    agentId: target.agentId,
    sqlitePath: canonicalMigrationFilePath(target.sqlitePath),
    storePath: canonicalMigrationFilePath(target.storePath),
  };
}

function normalizeMigrationTargetManifest(
  target: SessionSqliteMigrationTargetManifest,
): SessionSqliteMigrationTargetManifest {
  return {
    ...target,
    ...normalizeMigrationTarget(target),
    completedMoves: target.completedMoves.map(normalizeMigrationMove),
    plannedMoves: target.plannedMoves.map(normalizeMigrationMove),
  };
}

function normalizeMigrationMove(move: SessionSqliteMigrationMove): SessionSqliteMigrationMove {
  return {
    archivePath: canonicalMigrationFilePath(move.archivePath),
    kind: move.kind,
    ...(move.sessionKey ? { sessionKey: move.sessionKey } : {}),
    sourcePath: canonicalMigrationFilePath(move.sourcePath),
  };
}

function hasUnsupportedV1DirectorySymlink(manifest: SessionSqliteMigrationManifest): boolean {
  const directoryPaths = manifest.targets.flatMap((target) => [
    path.dirname(target.sqlitePath),
    path.dirname(target.storePath),
    ...target.plannedMoves.flatMap((move) => [
      path.dirname(move.archivePath),
      path.dirname(move.sourcePath),
    ]),
    ...target.completedMoves.flatMap((move) => [
      path.dirname(move.archivePath),
      path.dirname(move.sourcePath),
    ]),
  ]);
  return directoryPaths.some((directoryPath) => {
    const resolvedPath = path.resolve(directoryPath);
    const root = path.parse(resolvedPath).root;
    let currentPath = root;
    for (const segment of path.relative(root, resolvedPath).split(path.sep).filter(Boolean)) {
      currentPath = path.join(currentPath, segment);
      try {
        const stat = fs.lstatSync(currentPath);
        // Version 1 predates canonical paths. Only filesystem-root aliases such as
        // macOS /var and /tmp are safe to normalize without trusting manifest data.
        if (stat.isSymbolicLink() && path.dirname(currentPath) !== root) {
          return true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return true;
        }
      }
    }
    return false;
  });
}

export function canonicalMigrationFilePath(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  const fileName = path.basename(resolvedPath);
  const directoryPath = path.dirname(resolvedPath);
  const suffix: string[] = [];
  let currentPath = directoryPath;
  while (true) {
    try {
      return path.join(fs.realpathSync.native(currentPath), ...suffix, fileName);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parentPath = path.dirname(currentPath);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parentPath === currentPath) {
        return resolvedPath;
      }
      suffix.unshift(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

function assertSafeMigrationTargetTopology(target: SessionSqliteMigrationTargetInput): void {
  for (const filePath of [target.storePath, target.sqlitePath]) {
    if (isSymbolicLinkPath(filePath) || isSymbolicLinkPath(path.dirname(filePath))) {
      throw new Error(`Refusing session SQLite migration through symbolic link: ${filePath}`);
    }
  }
  const sessionsDir = path.dirname(canonicalMigrationFilePath(target.storePath));
  assertSafeSessionSqliteMigrationDirectory(
    path.join(path.dirname(sessionsDir), "session-sqlite-import-archive"),
  );
}

function isSymbolicLinkPath(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isFailedSessionSqliteMigrationManifest(manifest: SessionSqliteMigrationManifest): boolean {
  return (
    manifest.completedAt === undefined ||
    manifest.failedAt !== undefined ||
    manifest.failureReports !== undefined ||
    manifest.targets.some((target) => target.issues.length > 0)
  );
}

function manifestSortTime(manifest: SessionSqliteMigrationManifest): number {
  const timestamp = manifest.failedAt ?? manifest.completedAt ?? manifest.startedAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createPrefilledGithubIssueUrl(title: string, body: string): string {
  const urlBody =
    body.length > 6_000
      ? `${truncateUtf16Safe(body, 6_000)}\n\n...(truncated for URL; see local failure report for the full sanitized body)`
      : body;
  const params = new URLSearchParams({
    body: urlBody,
    title,
  });
  return `https://github.com/openclaw/openclaw/issues/new?${params.toString()}`;
}

function pruneCompletedSessionSqliteMigrationRuns(env: NodeJS.ProcessEnv): void {
  const completed = listSessionSqliteMigrationManifestPaths(env)
    .map((manifestPath) => ({
      manifest: readSessionSqliteMigrationManifest(manifestPath),
      manifestPath,
    }))
    .filter(
      (item): item is { manifest: SessionSqliteMigrationManifest; manifestPath: string } =>
        item.manifest !== undefined &&
        item.manifest.completedAt !== undefined &&
        !isFailedSessionSqliteMigrationManifest(item.manifest),
    )
    .toSorted((left, right) => manifestSortTime(right.manifest) - manifestSortTime(left.manifest));
  for (const item of completed.slice(COMPLETED_MIGRATION_RUN_RETENTION)) {
    try {
      fs.rmSync(item.manifestPath, { force: true });
    } catch {
      // Retention is best-effort and must not block startup import.
    }
  }
}

function renderFailureMarkdown(payload: {
  generatedAt: string;
  manifestPath: string;
  reason: string;
  recoveryCommand: string;
  restoreStatus: string;
  runId: string;
  targets: Array<{
    agentId: string;
    completedMoves: number;
    issues: Array<{ code: string; message: string; sessionKey?: string }>;
    plannedMoves: number;
    sqlitePath: string;
    storePath: string;
    validationBeforeArchive: string;
  }>;
  version: string;
}): string {
  const lines = [
    "# Session SQLite Migration Failure",
    "",
    `- Run: ${payload.runId}`,
    `- Generated: ${payload.generatedAt}`,
    `- OpenClaw version: ${payload.version}`,
    `- Reason: ${sanitizeFailureReportText(payload.reason)}`,
    `- Restore status: ${payload.restoreStatus}`,
    `- Recovery command: \`${payload.recoveryCommand}\``,
    "",
    "## Targets",
  ];
  for (const target of payload.targets) {
    lines.push(
      "",
      `### ${target.agentId}`,
      "",
      `- Store: ${target.storePath}`,
      `- SQLite: ${target.sqlitePath}`,
      `- Planned moves: ${target.plannedMoves}`,
      `- Completed moves: ${target.completedMoves}`,
      `- Validation before archive: ${target.validationBeforeArchive}`,
      `- Issues: ${target.issues.length}`,
    );
    for (const issue of target.issues.slice(0, 10)) {
      lines.push(
        `  - [${issue.code}] ${issue.sessionKey ? `${issue.sessionKey}: ` : ""}${issue.message}`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function sanitizeFailureReportText(value: string): string {
  const sanitized = value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/(api[_-]?key|token|secret|password)[=-][A-Za-z0-9._-]+/gi, "$1-[redacted]")
    .replace(/(api[_-]?key|token|secret|password)=\S+/gi, "$1=[redacted]");
  return truncateUtf16Safe(sanitized, 500);
}

function shortenFailureReportPath(filePath: string): string {
  const home = process.env.HOME;
  if (home && filePath.startsWith(`${home}${path.sep}`)) {
    return `~${path.sep}${path.relative(home, filePath)}`;
  }
  return filePath;
}

function sanitizeFailureIssueMessage(
  issue: DoctorSessionSqliteIssue,
  target: SessionSqliteMigrationTargetManifest,
): string {
  let message = issue.message;
  for (const filePath of [
    target.storePath,
    target.sqlitePath,
    ...target.plannedMoves.flatMap((move) => [move.sourcePath, move.archivePath]),
    ...target.completedMoves.flatMap((move) => [move.sourcePath, move.archivePath]),
  ]) {
    message = message.split(filePath).join(shortenFailureReportPath(filePath));
  }
  if (issue.sessionKey) {
    message = message.split(issue.sessionKey).join(redactSessionKey(issue.sessionKey));
  }
  message = redactAbsoluteHomePaths(message);
  return sanitizeFailureReportText(message);
}

function redactSessionKey(sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    return "[redacted-session-key]";
  }
  return `[redacted-session-key:${randomUUID().slice(0, 8)}]`;
}

function redactAbsoluteHomePaths(value: string): string {
  const home = process.env.HOME;
  if (!home) {
    return value;
  }
  return value.split(home).join("~");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
