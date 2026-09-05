/** Manifest and restore helpers for doctor-owned session SQLite migrations. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { requireDirectorySync, syncDirectorySync } from "../infra/directory-durability.js";
import * as replaceFile from "../infra/replace-file.js";
import { VERSION } from "../version.js";
import {
  MigrationArtifactSchema,
  type MigrationArtifact,
} from "./doctor-session-sqlite-artifact.js";
import { isSessionSqliteMigrationWarning } from "./doctor-session-sqlite-types.js";
import type {
  DoctorSessionSqliteIssue,
  DoctorSessionSqliteRestoreConflict,
} from "./doctor-session-sqlite-types.js";

export type SessionSqliteMigrationMoveKind =
  | "legacy-store"
  | "transcript"
  | "trajectory"
  | "unreferenced-jsonl";

export type SessionSqliteMigrationMove = {
  archivePath: string;
  artifact?: MigrationArtifact;
  kind: SessionSqliteMigrationMoveKind;
  sessionKey?: string;
  sourcePath: string;
};

export type SessionSqliteMigrationTargetInput = {
  agentId: string;
  sqlitePath: string;
  storePath: string;
};

export type SessionSqliteMigrationTargetManifest = SessionSqliteMigrationTargetInput & {
  completedMoves: SessionSqliteMigrationMove[];
  issues: DoctorSessionSqliteIssue[];
  plannedMoves: SessionSqliteMigrationMove[];
  validationBeforeArchive: "not_run" | "passed" | "failed";
};

export type SessionSqliteMigrationManifest = {
  completedAt?: string;
  failedAt?: string;
  failureReports?: {
    jsonPath: string;
    markdownPath: string;
  };
  manifestVersion: 1 | 2 | 3;
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
const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0") && path.isAbsolute(value))
  .transform((value) => path.resolve(value));
const MigrationMoveSchema = z
  .object({
    archivePath: AbsolutePathSchema,
    artifact: MigrationArtifactSchema.optional(),
    kind: z.enum(["legacy-store", "transcript", "trajectory", "unreferenced-jsonl"]),
    sessionKey: z.string().optional(),
    sourcePath: AbsolutePathSchema,
  })
  .superRefine((move, context) => {
    const disposal = move.artifact?.disposal;
    if (
      disposal?.state === "pending-disposal" &&
      (path.dirname(disposal.claimPath) !== path.dirname(move.archivePath) ||
        !/^\.cleanup-[a-f0-9-]{36}$/.test(path.basename(disposal.claimPath)))
    ) {
      context.addIssue({
        code: "custom",
        message: "disposal claim is outside its archive boundary",
      });
    }
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
      if (
        move.artifact?.dependencies.some(
          (source) => path.dirname(source) !== path.dirname(target.storePath),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "artifact dependency is outside its source boundary",
        });
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
    manifestVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
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
    manifestVersion: 3,
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
  // Normalize the selected root, not the directory leaf: substituted recovery directories
  // must still fail alias checks, while platform root aliases must not hide recorded runs.
  return canonicalMigrationFilePath(
    path.join(resolveStateDir(env), SESSION_SQLITE_MIGRATION_RUNS_DIR),
  );
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
    copyFallbackOnPermissionError: false,
    syncTempFile: true,
  });
  // Atomic replacement only offers best-effort parent sync. Recovery receipts must be
  // durable before their recorded original can be published, consumed, or retired.
  requireDirectorySync(
    syncDirectorySync(path.dirname(activeRun.manifestPath)),
    "Session SQLite migration manifest",
  );
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

export function migrationMoveKey(move: SessionSqliteMigrationMove): string {
  return `${move.sourcePath}\u0000${move.archivePath}`;
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

export function isRegularFileWithoutFollowingSymlinks(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function hasSymbolicLinkInDirectoryPath(directoryPath: string): boolean {
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

export function filterRestoreManifestTargets(
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

export function listSessionSqliteMigrationManifestPaths(env: NodeJS.ProcessEnv): string[] {
  const runsDir = resolveSessionSqliteMigrationRunsDir(env);
  let entries: string[];
  try {
    entries = fs.readdirSync(runsDir);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .filter((entry) => !entry.endsWith(".failure.json"))
    .map((entry) => path.join(runsDir, entry))
    .toSorted((left, right) => right.localeCompare(left));
}

export function readSessionSqliteMigrationManifest(
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
    ...(move.artifact ? { artifact: move.artifact } : {}),
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
    manifest.targets.some((target) =>
      target.issues.some((issue) => !isSessionSqliteMigrationWarning(issue)),
    )
  );
}

function manifestSortTime(manifest: SessionSqliteMigrationManifest): number {
  const timestamp = manifest.failedAt ?? manifest.completedAt ?? manifest.startedAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pruneCompletedSessionSqliteMigrationRuns(env: NodeJS.ProcessEnv): void {
  const all = listSessionSqliteMigrationManifestPaths(env).map((manifestPath) => ({
    manifest: readSessionSqliteMigrationManifest(manifestPath),
    manifestPath,
  }));
  const dependencies = new Set(
    all.flatMap(
      ({ manifest }) =>
        manifest?.targets.flatMap((target) =>
          uniqueRestoreMoves(target)
            .filter((move) => move.artifact?.disposal.state !== "disposed")
            .flatMap((move) => [move.sourcePath].concat(move.artifact?.dependencies ?? [])),
        ) ?? [],
    ),
  );
  const completed = all
    .filter(
      (item): item is { manifest: SessionSqliteMigrationManifest; manifestPath: string } =>
        item.manifest !== undefined &&
        item.manifest.completedAt !== undefined &&
        !isFailedSessionSqliteMigrationManifest(item.manifest) &&
        item.manifest.targets.every((target) =>
          uniqueRestoreMoves(target).every(
            (move) =>
              move.artifact?.disposal.state === "disposed" && !dependencies.has(move.sourcePath),
          ),
        ),
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

export function uniqueRestoreMoves(
  target: SessionSqliteMigrationTargetManifest,
): SessionSqliteMigrationMove[] {
  const moves = new Map<string, SessionSqliteMigrationMove>();
  for (const move of [...target.completedMoves, ...target.plannedMoves]) {
    moves.set(`${move.sourcePath}\u0000${move.archivePath}`, move);
  }
  return [...moves.values()];
}
