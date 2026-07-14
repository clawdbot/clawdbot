/** Shared type contracts for doctor-owned session SQLite migration reports. */
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type DoctorSessionSqliteIssue = {
  code: string;
  message: string;
  sessionKey?: string;
};

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
