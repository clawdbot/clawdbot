// Memory Core codecs normalize canonical and legacy dreaming ingestion state.
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { asRecord } from "./dreaming-shared.js";

const MEMORY_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION = 4096;

export type DailyIngestionFileState = {
  mtimeMs: number;
  size: number;
  lastDreamingDayIngested?: string;
};

export type DailyIngestionState = {
  version: 1;
  files: Record<string, DailyIngestionFileState>;
};

export type SessionIngestionFileState = {
  mtimeMs: number;
  size: number;
  contentHash: string;
  lineCount: number;
  lastContentLine: number;
};

export type SessionIngestionState = {
  version: 3;
  files: Record<string, SessionIngestionFileState>;
  seenMessages: Record<string, string[]>;
};

export function normalizeMemoryDay(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const day = value.trim();
  return MEMORY_DAY_RE.test(day) ? day : undefined;
}

export function normalizeDailyIngestionState(raw: unknown): DailyIngestionState {
  const record = asRecord(raw);
  const filesRaw = asRecord(record?.files);
  if (!filesRaw) {
    return { version: 1, files: {} };
  }
  const files: Record<string, DailyIngestionFileState> = {};
  for (const [key, value] of Object.entries(filesRaw)) {
    const file = asRecord(value);
    if (!file || typeof key !== "string" || key.trim().length === 0) {
      continue;
    }
    const mtimeMs = Number(file.mtimeMs);
    const size = Number(file.size);
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !Number.isFinite(size) || size < 0) {
      continue;
    }
    const lastDreamingDayIngested = normalizeMemoryDay(file.lastDreamingDayIngested);
    files[key] = {
      mtimeMs: Math.floor(mtimeMs),
      size: Math.floor(size),
      ...(lastDreamingDayIngested ? { lastDreamingDayIngested } : {}),
    };
  }
  return { version: 1, files };
}

export function normalizeSessionIngestionState(raw: unknown): SessionIngestionState {
  const record = asRecord(raw);
  const filesRaw = asRecord(record?.files);
  const files: Record<string, SessionIngestionFileState> = {};
  if (filesRaw) {
    for (const [key, value] of Object.entries(filesRaw)) {
      const file = asRecord(value);
      if (!file || key.trim().length === 0) {
        continue;
      }
      const mtimeMs = Number(file.mtimeMs);
      const size = Number(file.size);
      if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !Number.isFinite(size) || size < 0) {
        continue;
      }
      const lineCountRaw = Number(file.lineCount);
      const lastContentLineRaw = Number(file.lastContentLine);
      const lineCount =
        Number.isFinite(lineCountRaw) && lineCountRaw >= 0 ? Math.floor(lineCountRaw) : 0;
      const lastContentLine =
        Number.isFinite(lastContentLineRaw) && lastContentLineRaw >= 0
          ? Math.floor(lastContentLineRaw)
          : 0;
      files[key] = {
        mtimeMs: Math.floor(mtimeMs),
        size: Math.floor(size),
        contentHash: typeof file.contentHash === "string" ? file.contentHash.trim() : "",
        lineCount,
        lastContentLine: Math.min(lineCount, lastContentLine),
      };
    }
  }
  const seenMessagesRaw = asRecord(record?.seenMessages);
  const seenMessages: Record<string, string[]> = {};
  if (seenMessagesRaw) {
    for (const [scope, value] of Object.entries(seenMessagesRaw)) {
      if (scope.trim().length === 0 || !Array.isArray(value)) {
        continue;
      }
      const unique = normalizeStringEntries([
        ...new Set(value.filter((entry): entry is string => typeof entry === "string")),
      ]).slice(-SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION);
      if (unique.length > 0) {
        seenMessages[scope] = unique;
      }
    }
  }
  return { version: 3, files, seenMessages };
}
