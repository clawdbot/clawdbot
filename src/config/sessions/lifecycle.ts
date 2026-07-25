// Session lifecycle timestamps prefer store metadata and fall back to transcript headers.
import fs from "node:fs";
import { readFileWindowFullySync } from "../../infra/file-read.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import { canonicalizeMainSessionAlias } from "./main-session.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionFilePathOptions,
} from "./paths.js";
import { readTranscriptStatsSync } from "./session-accessor.js";
import { isTerminalSessionStatus, type SessionEntry, type SessionScope } from "./types.js";

type SessionLifecycleEntry = Pick<
  SessionEntry,
  "sessionId" | "sessionFile" | "sessionStartedAt" | "lastInteractionAt" | "updatedAt"
>;

type SessionWorkStartEntry = Pick<
  SessionEntry,
  "archivedAt" | "initializationPending" | "sessionId"
>;

type SessionWorkStartOptions = {
  expectedSessionId?: string;
};

/** Stable Gateway error detail for stale session lifecycle requests. */
export const SESSION_LIFECYCLE_CHANGED_ERROR_REASON = "session-changed";
const SESSION_WORK_START_INVALIDATED_ERROR_CODE = "SESSION_WORK_START_INVALIDATED";

export class SessionWorkStartInvalidatedError extends Error {
  readonly code = SESSION_WORK_START_INVALIDATED_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "SessionWorkStartInvalidatedError";
  }
}

export function isSessionWorkStartInvalidatedError(
  error: unknown,
): error is SessionWorkStartInvalidatedError {
  return (
    error instanceof SessionWorkStartInvalidatedError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === SESSION_WORK_START_INVALIDATED_ERROR_CODE)
  );
}

/** Lifecycle-owned initializing and archived sessions reject new work. */
export function resolveSessionWorkStartError(
  sessionKey: string,
  entry: SessionWorkStartEntry | null | undefined,
  options?: SessionWorkStartOptions,
): string | undefined {
  if (options?.expectedSessionId && !entry) {
    return `Session "${sessionKey}" was deleted while starting work. Retry.`;
  }
  if (options?.expectedSessionId && entry?.sessionId !== options.expectedSessionId) {
    return `Session "${sessionKey}" changed while starting work. Retry.`;
  }
  if (entry?.initializationPending === true) {
    return `Session "${sessionKey}" is still initializing. Retry after initialization completes.`;
  }
  return entry?.archivedAt === undefined
    ? undefined
    : `Session "${sessionKey}" is archived. Restore it before starting new work.`;
}

// Transcript headers are read lazily to recover startedAt without parsing full files.

type TerminalMainSessionTranscriptRegistryParams = {
  entry: SessionEntry | undefined;
  sessionScope?: SessionScope;
  sessionKey?: string;
  agentId: string;
  mainKey?: string;
  storePath?: string;
};

type TerminalMainSessionTranscriptRegistryCheck = {
  sessionId: string;
  registryTimestampMs: number;
};

function resolveTimestamp(value: number | undefined): number | undefined {
  const timestampMs = asDateTimestampMs(value);
  return timestampMs !== undefined && timestampMs >= 0 ? timestampMs : undefined;
}

function resolvePositiveTimestamp(value: number | undefined): number | undefined {
  const timestampMs = resolveTimestamp(value);
  return timestampMs !== undefined && timestampMs > 0 ? timestampMs : undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return resolveTimestamp(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return resolveTimestamp(parsed);
}

function readFirstLine(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = readFileWindowFullySync(fd, buffer, 0);
      if (bytesRead <= 0) {
        return undefined;
      }
      const chunk = buffer.subarray(0, bytesRead).toString("utf8");
      const newline = chunk.indexOf("\n");
      return newline >= 0 ? chunk.slice(0, newline) : chunk;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Reads session start time from a transcript header when store metadata is missing. */
function readSessionHeaderStartedAtMs(params: {
  entry: SessionLifecycleEntry | undefined;
  agentId?: string;
  storePath?: string;
  pathOptions?: SessionFilePathOptions;
}): number | undefined {
  const sessionId = params.entry?.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  const pathOptions =
    params.pathOptions ??
    resolveSessionFilePathOptions({
      agentId: params.agentId,
      storePath: params.storePath,
    });
  let sessionFile: string;
  try {
    sessionFile = resolveSessionFilePath(sessionId, params.entry, pathOptions);
  } catch {
    return undefined;
  }
  const firstLine = readFirstLine(sessionFile);
  if (!firstLine) {
    return undefined;
  }
  try {
    const header = JSON.parse(firstLine) as {
      type?: unknown;
      id?: unknown;
      timestamp?: unknown;
    };
    if (header.type !== "session") {
      return undefined;
    }
    if (typeof header.id === "string" && header.id.trim() && header.id !== sessionId) {
      return undefined;
    }
    return parseTimestampMs(header.timestamp);
  } catch {
    return undefined;
  }
}

export function resolveSessionLifecycleTimestamps(params: {
  entry: SessionLifecycleEntry | undefined;
  agentId?: string;
  storePath?: string;
  pathOptions?: SessionFilePathOptions;
}): { sessionStartedAt?: number; lastInteractionAt?: number } {
  const entry = params.entry;
  if (!entry) {
    return {};
  }
  return {
    sessionStartedAt:
      resolveTimestamp(entry.sessionStartedAt) ??
      readSessionHeaderStartedAtMs({
        entry,
        agentId: params.agentId,
        storePath: params.storePath,
        pathOptions: params.pathOptions,
      }),
    lastInteractionAt: resolveTimestamp(entry.lastInteractionAt),
  };
}

export function resolveTerminalMainSessionTranscriptRegistryCheck(
  params: TerminalMainSessionTranscriptRegistryParams,
): TerminalMainSessionTranscriptRegistryCheck | undefined {
  if (!params.entry || !params.sessionKey) {
    return undefined;
  }
  const configuredMainSessionKey = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.sessionScope, mainKey: params.mainKey } },
    agentId: params.agentId,
    sessionKey: params.mainKey ?? "main",
  });
  const candidateSessionKey = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.sessionScope, mainKey: params.mainKey } },
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (candidateSessionKey !== configuredMainSessionKey) {
    return undefined;
  }
  const hasTerminalLifecycle =
    isTerminalSessionStatus(params.entry.status) ||
    resolvePositiveTimestamp(params.entry.endedAt) !== undefined;
  if (!hasTerminalLifecycle) {
    return undefined;
  }
  if (params.entry.status === "done") {
    // Successful rows stay reusable: transcript writes can land after registry
    // updates without making the session stale.
    return undefined;
  }
  if (params.entry.status === "failed") {
    // Failed rows with a present transcript stay reusable for retry/recovery.
    // Callers already rotate failed rows when the transcript is missing.
    return undefined;
  }
  // updatedAt is touched after managed transcript appends; endedAt can predate
  // healthy post-run transcript writes and would rotate valid sessions.
  const registryTimestampMs = resolvePositiveTimestamp(params.entry.updatedAt);
  if (registryTimestampMs === undefined) {
    return undefined;
  }
  const sessionId = typeof params.entry.sessionId === "string" ? params.entry.sessionId.trim() : "";
  if (!sessionId) {
    return undefined;
  }
  return { sessionId, registryTimestampMs };
}

function isTranscriptMutationNewerThanRegistry(params: {
  transcriptMutationAtMs: number;
  registryTimestampMs: number;
}): boolean {
  const transcriptMutationAtMs = Math.floor(params.transcriptMutationAtMs);
  const registryTimestampMs = Math.floor(params.registryTimestampMs);
  return Number.isFinite(transcriptMutationAtMs) && transcriptMutationAtMs > registryTimestampMs;
}

export function hasTerminalMainSessionTranscriptNewerThanRegistrySync(
  params: TerminalMainSessionTranscriptRegistryParams,
): boolean {
  const check = resolveTerminalMainSessionTranscriptRegistryCheck(params);
  if (!check) {
    return false;
  }
  try {
    // Runtime transcripts are SQLite-only. Legacy-looking sessionFile values still
    // resolve through agent/session/store scope, so a file stat would read stale state.
    const stats = readTranscriptStatsSync({
      agentId: params.agentId,
      sessionId: check.sessionId,
      storePath: params.storePath,
    });
    if (stats.lastMutationAtMs === undefined) {
      return false;
    }
    return isTranscriptMutationNewerThanRegistry({
      transcriptMutationAtMs: stats.lastMutationAtMs,
      registryTimestampMs: stats.lastObservedMutationAtMs ?? check.registryTimestampMs,
    });
  } catch {
    return false;
  }
}

export async function hasTerminalMainSessionTranscriptNewerThanRegistry(
  params: TerminalMainSessionTranscriptRegistryParams,
): Promise<boolean> {
  return hasTerminalMainSessionTranscriptNewerThanRegistrySync(params);
}
