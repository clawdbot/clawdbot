import { timestampMsToIsoFileStamp } from "@openclaw/normalization-core/number-coercion";
import { escapeRegExp } from "../../shared/regexp.js";

export type SessionArchiveReason = "bak" | "reset" | "deleted";

const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;
const LEGACY_STORE_BACKUP_RE = /^sessions\.json\.bak\.\d+$/;
const COMPACTION_CHECKPOINT_TRANSCRIPT_RE =
  /^(.+)\.checkpoint\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;

function hasArchiveSuffix(fileName: string, reason: SessionArchiveReason): boolean {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return false;
  }
  const raw = fileName.slice(index + marker.length);
  return ARCHIVE_TIMESTAMP_RE.test(raw);
}

export function isSessionArchiveArtifactName(fileName: string): boolean {
  if (LEGACY_STORE_BACKUP_RE.test(fileName)) {
    return true;
  }
  return (
    hasArchiveSuffix(fileName, "deleted") ||
    hasArchiveSuffix(fileName, "reset") ||
    hasArchiveSuffix(fileName, "bak")
  );
}

// Compiled-pattern cache keyed by store basename. A disk sweep calls the matcher
// once per file, so compiling the per-store pattern once (basenames are few — one
// per agent store) keeps the hot path allocation-free.
const SESSION_STORE_TEMP_RE_CACHE = new Map<string, RegExp>();

function sessionStoreTempPattern(storeBasename: string): RegExp {
  let pattern = SESSION_STORE_TEMP_RE_CACHE.get(storeBasename);
  if (!pattern) {
    pattern = new RegExp(
      `^${escapeRegExp(storeBasename)}\\.(?:\\d+\\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`,
      "i",
    );
    SESSION_STORE_TEMP_RE_CACHE.set(storeBasename, pattern);
  }
  return pattern;
}

// Atomic writes of the session store stage into `<store>.<pid>.<uuid>.tmp`
// (legacy: `<store>.<uuid>.tmp`) and rename into place. A crash between write and
// rename orphans the temp; these accumulate and waste disk (#56827). They are
// never the live store, so a stale one is safe to reclaim. `storeBasename` is the
// store filename (the atomic write's temp prefix, e.g. `sessions.json`), so a
// custom-named `session.store` is matched too.
export function isSessionStoreTempArtifactName(fileName: string, storeBasename: string): boolean {
  if (!storeBasename) {
    return false;
  }
  return sessionStoreTempPattern(storeBasename).test(fileName);
}

export function parseCompactionCheckpointTranscriptFileName(fileName: string): {
  sessionId: string;
  checkpointId: string;
} | null {
  const match = COMPACTION_CHECKPOINT_TRANSCRIPT_RE.exec(fileName);
  const sessionId = match?.[1];
  const checkpointId = match?.[2];
  return sessionId && checkpointId ? { sessionId, checkpointId } : null;
}

export function isCompactionCheckpointTranscriptFileName(fileName: string): boolean {
  return parseCompactionCheckpointTranscriptFileName(fileName) !== null;
}

export function isTrajectoryRuntimeArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory.jsonl");
}

export function isTrajectoryPointerArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory-path.json");
}

export function isTrajectorySessionArtifactName(fileName: string): boolean {
  return isTrajectoryRuntimeArtifactName(fileName) || isTrajectoryPointerArtifactName(fileName);
}

export function isPrimarySessionTranscriptFileName(fileName: string): boolean {
  if (fileName === "sessions.json") {
    return false;
  }
  if (!fileName.endsWith(".jsonl")) {
    return false;
  }
  if (isTrajectoryRuntimeArtifactName(fileName)) {
    return false;
  }
  if (isCompactionCheckpointTranscriptFileName(fileName)) {
    return false;
  }
  return !isSessionArchiveArtifactName(fileName);
}

export function isUsageCountedSessionTranscriptFileName(fileName: string): boolean {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return true;
  }
  return hasArchiveSuffix(fileName, "reset") || hasArchiveSuffix(fileName, "deleted");
}

export function parseUsageCountedSessionIdFromFileName(fileName: string): string | null {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return fileName.slice(0, -".jsonl".length);
  }
  for (const reason of ["reset", "deleted"] as const) {
    const marker = `.jsonl.${reason}.`;
    const index = fileName.lastIndexOf(marker);
    if (index > 0 && hasArchiveSuffix(fileName, reason)) {
      return fileName.slice(0, index);
    }
  }
  return null;
}

export function formatSessionArchiveTimestamp(nowMs = Date.now()): string {
  return timestampMsToIsoFileStamp(nowMs);
}

function restoreSessionArchiveTimestamp(raw: string): string {
  const [datePart, timePart] = raw.split("T");
  if (!datePart || !timePart) {
    return raw;
  }
  return `${datePart}T${timePart.replace(/-/g, ":")}`;
}

export function parseSessionArchiveTimestamp(
  fileName: string,
  reason: SessionArchiveReason,
): number | null {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }
  const raw = fileName.slice(index + marker.length);
  if (!raw) {
    return null;
  }
  if (!ARCHIVE_TIMESTAMP_RE.test(raw)) {
    return null;
  }
  const timestamp = Date.parse(restoreSessionArchiveTimestamp(raw));
  return Number.isNaN(timestamp) ? null : timestamp;
}
