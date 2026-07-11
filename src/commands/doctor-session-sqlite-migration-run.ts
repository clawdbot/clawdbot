/** Manifest and restore helpers for doctor-owned session SQLite migrations. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../config/paths.js";
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
  manifestVersion: 1;
  openClawVersion: string;
  restore?: {
    attemptedAt: string;
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

export function createSessionSqliteMigrationRun(
  env: NodeJS.ProcessEnv,
  targets: readonly SessionSqliteMigrationTargetInput[],
): ActiveSessionSqliteMigrationRun {
  const runId = `session-sqlite-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const manifestPath = path.join(resolveSessionSqliteMigrationRunsDir(env), `${runId}.json`);
  const manifest: SessionSqliteMigrationManifest = {
    manifestVersion: 1,
    openClawVersion: VERSION,
    runId,
    startedAt: new Date().toISOString(),
    targets: targets.map((target) => ({
      ...target,
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

export function recordPlannedMigrationMove(
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
  target: SessionSqliteMigrationTargetInput,
  move: SessionSqliteMigrationMove,
): void {
  recordPlannedMigrationMoves(activeRun, target, [move]);
}

export function recordPlannedMigrationMoves(
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
  target: SessionSqliteMigrationTargetInput,
  moves: readonly SessionSqliteMigrationMove[],
): void {
  recordMigrationMoves(activeRun, target, "plannedMoves", moves);
}

export function recordCompletedMigrationMove(
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
  target: SessionSqliteMigrationTargetInput,
  move: SessionSqliteMigrationMove,
): void {
  recordCompletedMigrationMoves(activeRun, target, [move]);
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
    const key = migrationMoveKey(move);
    if (knownMoves.has(key)) {
      continue;
    }
    knownMoves.add(key);
    targetMoves.push(move);
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
  targetKeys?: ReadonlySet<string>;
}): DoctorSessionSqliteRestoreReport {
  const restoreReport: DoctorSessionSqliteRestoreReport = emptyRestoreReport();
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(params.env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (!manifest) {
      continue;
    }
    const targetManifests = filterRestoreManifestTargets(manifest, params.targetKeys);
    if (targetManifests.length === 0) {
      continue;
    }
    const manifestRestoreReport: DoctorSessionSqliteRestoreReport = {
      ...emptyRestoreReport(),
      manifestPaths: [manifestPath],
    };
    restoreReport.manifestPaths.push(manifestPath);
    restoreSessionSqliteMigrationManifest(manifest, targetManifests, manifestRestoreReport);
    restoreReport.conflicts.push(...manifestRestoreReport.conflicts);
    restoreReport.restoredFiles.push(...manifestRestoreReport.restoredFiles);
    restoreReport.skippedFiles.push(...manifestRestoreReport.skippedFiles);
    writeSessionSqliteMigrationManifest({ manifest, manifestPath });
  }
  return restoreReport;
}

export function restoreSessionSqliteMigrationRun(params: {
  manifestPath: string;
  targetKeys?: ReadonlySet<string>;
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
  restoreSessionSqliteMigrationManifest(
    manifest,
    filterRestoreManifestTargets(manifest, params.targetKeys),
    restoreReport,
  );
  writeSessionSqliteMigrationManifest({ manifest, manifestPath: params.manifestPath });
  return restoreReport;
}

export function findLatestFailedSessionSqliteMigrationManifest(
  env: NodeJS.ProcessEnv,
  targetKeys?: ReadonlySet<string>,
): { manifest: SessionSqliteMigrationManifest; manifestPath: string } | undefined {
  return listSessionSqliteMigrationManifestPaths(env)
    .map((manifestPath) => ({
      manifest: readSessionSqliteMigrationManifest(manifestPath),
      manifestPath,
    }))
    .filter(
      (item): item is { manifest: SessionSqliteMigrationManifest; manifestPath: string } =>
        item.manifest !== undefined &&
        isFailedSessionSqliteMigrationManifest(item.manifest) &&
        filterRestoreManifestTargets(item.manifest, targetKeys).length > 0,
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
  targetKeys?: ReadonlySet<string>,
): SessionSqliteMigrationFailureIssue | undefined {
  const manifest = readSessionSqliteMigrationManifest(manifestPath);
  if (!manifest) {
    return undefined;
  }
  const title = `Session SQLite migration recovery report (${manifest.runId})`;
  const bodyPath = manifest.failureReports?.markdownPath;
  const targets = filterRestoreManifestTargets(manifest, targetKeys);
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
  ]
    .join("\n")
    .slice(0, 20_000);
  return {
    body,
    ...(bodyPath ? { bodyPath } : {}),
    title,
    url: createPrefilledGithubIssueUrl(title, body),
  };
}

export function sessionSqliteMigrationTargetKey(target: {
  agentId: string;
  storePath: string;
}): string {
  return `${target.agentId}\u0000${path.resolve(target.storePath)}`;
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
  targets: readonly SessionSqliteMigrationTargetManifest[],
  restoreReport: DoctorSessionSqliteRestoreReport,
): void {
  for (const target of targets) {
    for (const move of uniqueRestoreMoves(target)) {
      restoreMigrationMove(move, restoreReport);
    }
  }
  manifest.restore = {
    attemptedAt: new Date().toISOString(),
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

function restoreMigrationMove(
  move: SessionSqliteMigrationMove,
  restoreReport: DoctorSessionSqliteRestoreReport,
): void {
  const sourceExists = fs.existsSync(move.sourcePath);
  const archiveExists = fs.existsSync(move.archivePath);
  if (!sourceExists && archiveExists) {
    fs.mkdirSync(path.dirname(move.sourcePath), { recursive: true, mode: 0o700 });
    fs.renameSync(move.archivePath, move.sourcePath);
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

function filterRestoreManifestTargets(
  manifest: SessionSqliteMigrationManifest,
  targetKeys: ReadonlySet<string> | undefined,
): SessionSqliteMigrationTargetManifest[] {
  if (!targetKeys) {
    return manifest.targets;
  }
  if (targetKeys.size === 0) {
    return [];
  }
  return manifest.targets.filter((target) =>
    targetKeys.has(sessionSqliteMigrationTargetKey(target)),
  );
}

export function listSessionSqliteMigrationManifestPaths(env: NodeJS.ProcessEnv): string[] {
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

export function readSessionSqliteMigrationManifest(
  manifestPath: string,
): SessionSqliteMigrationManifest | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
    if (!isRecord(parsed) || parsed.manifestVersion !== 1 || typeof parsed.runId !== "string") {
      return undefined;
    }
    return parsed as SessionSqliteMigrationManifest;
  } catch {
    return undefined;
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
      ? `${body.slice(0, 6_000)}\n\n...(truncated for URL; see local failure report for the full sanitized body)`
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
  return value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/(api[_-]?key|token|secret|password)[=-][A-Za-z0-9._-]+/gi, "$1-[redacted]")
    .replace(/(api[_-]?key|token|secret|password)=\S+/gi, "$1=[redacted]")
    .slice(0, 500);
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
