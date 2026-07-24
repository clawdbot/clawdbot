// Doctor detection for legacy meeting transcript files and interrupted imports.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveNodeSqliteLocation } from "./node-sqlite.js";
import {
  hasMatchingRecordedTranscriptArtifact,
  isRecordedCanonicalTranscriptExport,
} from "./state-migrations.meeting-transcripts-files.js";
import type { LegacyMeetingTranscriptsDetection } from "./state-migrations.meeting-transcripts.types.js";

type MeetingTranscriptExportOwnership = {
  selector: string;
  sessionId: string;
  startedAt: string;
  manifest: Record<string, string>;
  pending: ReadonlySet<string>;
};

type MeetingTranscriptMigrationDetectionState = {
  exportOwnership: Map<string, MeetingTranscriptExportOwnership>;
  exportOwnershipByFoldedSelector: Map<string, MeetingTranscriptExportOwnership[]>;
  pendingImportCount: number;
};

const TRANSCRIPT_ARTIFACT_NAMES = new Set([
  "metadata.json",
  "summary.json",
  "summary.md",
  "transcript.jsonl",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasLegacyArtifactsSync(directory: string): boolean {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  let found = false;
  for (const entry of entries) {
    if (!TRANSCRIPT_ARTIFACT_NAMES.has(entry.name.toLowerCase())) {
      continue;
    }
    const stat = fs.lstatSync(path.join(directory, entry.name));
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`legacy transcript source must be a regular file: ${directory}`);
    }
    found = true;
  }
  return found;
}

export function resolveMeetingTranscriptExportOwnership(params: {
  state: MeetingTranscriptMigrationDetectionState;
  selector: string;
  sessionDir: string;
  sourceRoot: string;
}): MeetingTranscriptExportOwnership | undefined {
  const exact = params.state.exportOwnership.get(params.selector);
  if (exact) {
    return exact;
  }
  const folded = params.state.exportOwnershipByFoldedSelector.get(params.selector.toLowerCase());
  if (!folded || folded.length === 0) {
    return undefined;
  }
  try {
    const metadataEntries = fs
      .readdirSync(params.sessionDir, { withFileTypes: true })
      .filter((entry) => entry.name.toLowerCase() === "metadata.json");
    if (metadataEntries.length > 0) {
      if (metadataEntries.length !== 1) {
        return undefined;
      }
      const metadataPath = path.join(params.sessionDir, metadataEntries[0]!.name);
      const stat = fs.lstatSync(metadataPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return undefined;
      }
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        sessionId?: unknown;
        startedAt?: unknown;
      };
      const matches = folded.filter(
        (ownership) =>
          metadata.sessionId === ownership.sessionId && metadata.startedAt === ownership.startedAt,
      );
      return matches.length === 1 ? matches[0] : undefined;
    }
  } catch {
    return undefined;
  }
  const manifestMatches = folded.filter((ownership) => {
    try {
      const canonicalDir = path.join(params.sourceRoot, ownership.selector);
      const canonicalStat = fs.statSync(canonicalDir);
      const observedStat = fs.statSync(params.sessionDir);
      if (canonicalStat.dev !== observedStat.dev || canonicalStat.ino !== observedStat.ino) {
        return false;
      }
      return hasMatchingRecordedTranscriptArtifact({
        sessionDir: params.sessionDir,
        manifest: ownership.manifest,
      });
    } catch {
      return false;
    }
  });
  return manifestMatches.length === 1 ? manifestMatches[0] : undefined;
}

export function detectLegacyMeetingTranscripts(params: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  doctorOnlyStateMigrations?: boolean;
}): LegacyMeetingTranscriptsDetection {
  const sourceDir = path.join(params.stateDir, "transcripts");
  if (params.doctorOnlyStateMigrations !== true) {
    return { sourceDir, hasLegacy: false, pendingImportCount: 0 };
  }
  const databaseState = readMeetingTranscriptMigrationDetectionState({
    env: { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir },
  });
  const pendingImportCount = databaseState.pendingImportCount;
  try {
    const rootStat = fs.lstatSync(sourceDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`meeting transcript root must be a regular directory: ${sourceDir}`);
    }
    const dateEntries = fs.readdirSync(sourceDir, { withFileTypes: true });
    const sourceSelectors = hasLegacyArtifactsSync(sourceDir) ? ["."] : [];
    for (const dateEntry of dateEntries) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) {
        continue;
      }
      if (dateEntry.isSymbolicLink()) {
        throw new Error(`legacy transcript date directory cannot be a symlink: ${dateEntry.name}`);
      }
      if (!dateEntry.isDirectory()) {
        continue;
      }
      const dateDir = path.join(sourceDir, dateEntry.name);
      if (hasLegacyArtifactsSync(dateDir)) {
        sourceSelectors.push(dateEntry.name);
      }
      for (const entry of fs.readdirSync(dateDir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          throw new Error(`legacy transcript session cannot be a symlink: ${entry.name}`);
        }
        if (entry.isDirectory() && hasLegacyArtifactsSync(path.join(dateDir, entry.name))) {
          sourceSelectors.push(`${dateEntry.name}/${entry.name}`);
        }
      }
    }
    const hasSource = sourceSelectors.some((selector) => {
      const ownership = resolveMeetingTranscriptExportOwnership({
        state: databaseState,
        selector,
        sessionDir: path.join(sourceDir, selector),
        sourceRoot: sourceDir,
      });
      return (
        !ownership ||
        !isRecordedCanonicalTranscriptExport({
          sessionDir: path.join(sourceDir, selector),
          manifest: ownership.manifest,
          pending: ownership.pending,
        })
      );
    });
    return {
      sourceDir,
      hasLegacy: hasSource || pendingImportCount > 0,
      pendingImportCount,
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { sourceDir, hasLegacy: pendingImportCount > 0, pendingImportCount };
    }
    throw error;
  }
}

export function readMeetingTranscriptMigrationDetectionState(params: {
  env: NodeJS.ProcessEnv;
}): MeetingTranscriptMigrationDetectionState {
  const databasePath = resolveOpenClawStateSqlitePath(params.env);
  if (!fs.existsSync(databasePath)) {
    return {
      exportOwnership: new Map(),
      exportOwnershipByFoldedSelector: new Map(),
      pendingImportCount: 0,
    };
  }
  const database = new DatabaseSync(resolveNodeSqliteLocation(databasePath), { readOnly: true });
  try {
    const tables = new Set(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('meeting_transcript_sessions', 'migration_sources')",
        )
        .all()
        .map((row) => String(row.name)),
    );
    const exportOwnership = new Map<string, MeetingTranscriptExportOwnership>();
    const exportOwnershipByFoldedSelector = new Map<string, MeetingTranscriptExportOwnership[]>();
    if (tables.has("meeting_transcript_sessions")) {
      const rows = database
        .prepare(
          "SELECT session_id, started_at, selector, export_manifest_json, export_pending_json FROM meeting_transcript_sessions",
        )
        .all();
      for (const row of rows) {
        const selector = String(row.selector);
        const parsed = JSON.parse(String(row.export_manifest_json)) as unknown;
        if (isRecord(parsed)) {
          const ownership = {
            selector,
            sessionId: String(row.session_id),
            startedAt: String(row.started_at),
            manifest: parsed as Record<string, string>,
            pending: new Set(JSON.parse(String(row.export_pending_json)) as string[]),
          } satisfies MeetingTranscriptExportOwnership;
          exportOwnership.set(selector, ownership);
          const foldedSelector = selector.toLowerCase();
          const foldedOwners = exportOwnershipByFoldedSelector.get(foldedSelector) ?? [];
          foldedOwners.push(ownership);
          exportOwnershipByFoldedSelector.set(foldedSelector, foldedOwners);
        }
      }
    }
    const pendingRow = tables.has("migration_sources")
      ? (database
          .prepare(
            "SELECT COUNT(*) AS count FROM migration_sources WHERE migration_kind = ? AND status = ? AND removed_source = 0",
          )
          .get("meeting-transcripts-files-v1", "imported") as { count?: unknown } | undefined)
      : undefined;
    return {
      exportOwnership,
      exportOwnershipByFoldedSelector,
      pendingImportCount: typeof pendingRow?.count === "number" ? pendingRow.count : 0,
    };
  } finally {
    database.close();
  }
}
