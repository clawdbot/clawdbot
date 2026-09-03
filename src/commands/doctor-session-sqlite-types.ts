/** Shared type contracts for doctor-owned session SQLite migration reports. */
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type DoctorSessionSqliteIssue = {
  code: string;
  message: string;
  sessionKey?: string;
};

const SESSION_SQLITE_WARNING_ISSUE_CODES = new Set([
  "entry_invalid",
  "transcript_archive_failed",
  "transcript_malformed",
  "transcript_missing",
  "unreferenced_jsonl_archive_failed",
]);

export function isSessionSqliteMigrationWarning(issue: DoctorSessionSqliteIssue): boolean {
  return SESSION_SQLITE_WARNING_ISSUE_CODES.has(issue.code);
}

export type DoctorSessionSqliteRestoreConflict = {
  archivePath: string;
  reason: string;
  sourcePath: string;
};

export type DoctorSessionSqliteRestoreReport = {
  conflicts: DoctorSessionSqliteRestoreConflict[];
  manifestPaths: string[];
  restoredFiles: string[];
  skippedFiles: string[];
};

type DoctorSessionSqliteLargestSession = {
  events: number;
  rowBytes: number;
  sessionId: string;
};

type DoctorSessionSqliteDbStats = {
  dbSizeBytes: number;
  integrityCheck?: string;
  largestSessions: DoctorSessionSqliteLargestSession[];
  totalTranscriptRowBytes: number;
  walSizeBytes: number;
};

export type DoctorSessionSqliteCompactReport = {
  dbSizeAfterBytes: number;
  dbSizeBeforeBytes: number;
  freelistAfterPages: number;
  freelistBeforePages: number;
  pageSizeBytes: number;
  reclaimedBytes: number;
  skipped: boolean;
  walSizeAfterBytes: number;
  walSizeBeforeBytes: number;
};

type DoctorSessionSqliteCorruptRecovery = {
  movedFiles: string[];
  skippedFiles: string[];
};

export type SessionSqliteMigrationFailureIssue = {
  body: string;
  bodyPath?: string;
  github?: {
    fallbackUrl?: string;
    message?: string;
    status: "created" | "failed" | "skipped";
    url?: string;
  };
  title: string;
  url: string;
};

export type DoctorSessionSqliteMode =
  | "dry-run"
  | "import"
  | "validate"
  | "inspect"
  | "compact"
  | "restore"
  | "recover";

export type DoctorSessionSqliteOptions = {
  allAgents?: boolean;
  agent?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
};

export type DoctorSessionSqliteTargetReport = {
  agentId: string;
  archivedLegacyStoreFiles?: string[];
  archivedTranscriptFiles: string[];
  archivedUnreferencedJsonlFiles: string[];
  dbStats?: DoctorSessionSqliteDbStats;
  importedEntries: number;
  importedTranscriptEvents: number;
  issues: DoctorSessionSqliteIssue[];
  legacyEntries: number;
  referencedTranscriptFiles: number;
  sqliteEntries: number;
  sqlitePath: string;
  storePath: string;
  unreferencedJsonlFiles: string[];
  validatedEntries: number;
  validatedTranscriptEvents: number;
  compact?: DoctorSessionSqliteCompactReport;
  corruptRecovery?: DoctorSessionSqliteCorruptRecovery;
  restore?: DoctorSessionSqliteRestoreReport;
};

export function createDoctorSessionSqliteTargetReport(
  values: Pick<DoctorSessionSqliteTargetReport, "agentId" | "sqlitePath" | "storePath"> &
    Partial<Omit<DoctorSessionSqliteTargetReport, "agentId" | "sqlitePath" | "storePath">>,
): DoctorSessionSqliteTargetReport {
  return {
    archivedTranscriptFiles: [],
    archivedUnreferencedJsonlFiles: [],
    importedEntries: 0,
    importedTranscriptEvents: 0,
    issues: [],
    legacyEntries: 0,
    referencedTranscriptFiles: 0,
    sqliteEntries: 0,
    unreferencedJsonlFiles: [],
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
    ...values,
  };
}

export type DoctorSessionSqliteReport = {
  migrationRun?: {
    failureReportJsonPath?: string;
    failureReportMarkdownPath?: string;
    manifestPath: string;
    runId: string;
  };
  mode: DoctorSessionSqliteMode;
  supportIssue?: SessionSqliteMigrationFailureIssue;
  targets: DoctorSessionSqliteTargetReport[];
  totals: {
    archivedLegacyStoreFiles?: number;
    archivedTranscriptFiles: number;
    archivedUnreferencedJsonlFiles: number;
    importedEntries: number;
    importedTranscriptEvents: number;
    issues: number;
    legacyEntries: number;
    reclaimedBytes?: number;
    sqliteEntries: number;
    targets: number;
    unreferencedJsonlFiles: number;
    validatedEntries: number;
    validatedTranscriptEvents: number;
  };
};

export function sumDoctorSessionSqliteTargets(
  targets: DoctorSessionSqliteTargetReport[],
  value: (target: DoctorSessionSqliteTargetReport) => number,
): number {
  return targets.reduce((total, target) => total + value(target), 0);
}

export function createDoctorSessionSqliteTotals(
  targets: DoctorSessionSqliteTargetReport[],
  values: Partial<
    Omit<DoctorSessionSqliteReport["totals"], "issues" | "sqliteEntries" | "targets">
  > = {},
): DoctorSessionSqliteReport["totals"] {
  const { archivedLegacyStoreFiles, reclaimedBytes } = values;
  const sqliteEntries = new Map<string, number>();
  for (const target of targets) {
    sqliteEntries.set(
      target.sqlitePath,
      Math.max(sqliteEntries.get(target.sqlitePath) ?? 0, target.sqliteEntries),
    );
  }
  return {
    ...(archivedLegacyStoreFiles === undefined ? {} : { archivedLegacyStoreFiles }),
    archivedTranscriptFiles: values.archivedTranscriptFiles ?? 0,
    archivedUnreferencedJsonlFiles: values.archivedUnreferencedJsonlFiles ?? 0,
    importedEntries: values.importedEntries ?? 0,
    importedTranscriptEvents: values.importedTranscriptEvents ?? 0,
    issues: sumDoctorSessionSqliteTargets(targets, (target) => target.issues.length),
    legacyEntries: values.legacyEntries ?? 0,
    ...(reclaimedBytes === undefined ? {} : { reclaimedBytes }),
    sqliteEntries: [...sqliteEntries.values()].reduce((total, count) => total + count, 0),
    targets: targets.length,
    unreferencedJsonlFiles: values.unreferencedJsonlFiles ?? 0,
    validatedEntries: values.validatedEntries ?? 0,
    validatedTranscriptEvents: values.validatedTranscriptEvents ?? 0,
  };
}
