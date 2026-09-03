// Session lifecycle timestamps prefer store metadata and fall back to transcript headers.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { canonicalizeMainSessionAlias } from "./main-session.js";
import { loadTranscriptHeaderSync, readTranscriptStatsSync } from "./session-accessor.js";
import {
  isTerminalSessionStatus,
  type InternalSessionEntry,
  type SessionEntry,
  type SessionScope,
} from "./types.js";
import {
  SESSION_WORK_START_CHANGED_ERROR_CODE,
  SESSION_WORK_START_INVALIDATED_ERROR_CODE,
} from "./work-start-error.js";

type SessionLifecycleEntry = Pick<
  SessionEntry,
  "sessionId" | "sessionStartedAt" | "lastInteractionAt" | "updatedAt"
>;

type SessionWorkStartEntry = Pick<
  InternalSessionEntry,
  | "archivedAt"
  | "initializationPending"
  | "mainRestartRecovery"
  | "modelSelectionLocked"
  | "sessionId"
  | "pendingProjectGitUrl"
  | "pendingWorktree"
>;

type SessionWorkStartOptions = {
  allowRestartTombstoneReplacement?: boolean;
  expectedSessionId?: string;
  /** Only workspace preparers and lifecycle cancellation may enter pending sessions. */
  allowPendingWorkspace?: true;
};

export function isRestartRecoveryTombstone(
  entry: SessionWorkStartEntry | null | undefined,
): boolean {
  return entry?.mainRestartRecovery?.tombstone !== undefined;
}

/** Stable Gateway error detail for stale session lifecycle requests. */
export const SESSION_LIFECYCLE_CHANGED_ERROR_REASON = "session-changed";
export const SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE = "SESSION_RESTART_RECOVERY_TOMBSTONE";

export class SessionWorkStartInvalidatedError extends Error {
  readonly code = SESSION_WORK_START_INVALIDATED_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "SessionWorkStartInvalidatedError";
  }
}

export class SessionWorkStartChangedError extends Error {
  readonly code = SESSION_WORK_START_CHANGED_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "SessionWorkStartChangedError";
  }
}

export function createSessionWorkStartChangedError(
  sessionKey: string,
): SessionWorkStartChangedError {
  return new SessionWorkStartChangedError(
    `Session "${sessionKey}" changed while starting work. Retry.`,
  );
}

export function isSessionWorkStartInvalidatedError(
  error: unknown,
): error is SessionWorkStartInvalidatedError | SessionWorkStartChangedError {
  return (
    error instanceof SessionWorkStartInvalidatedError ||
    error instanceof SessionWorkStartChangedError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === SESSION_WORK_START_INVALIDATED_ERROR_CODE ||
        error.code === SESSION_WORK_START_CHANGED_ERROR_CODE))
  );
}

export class SessionRestartRecoveryTombstoneError extends Error {
  readonly code = SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "SessionRestartRecoveryTombstoneError";
  }
}

/** Lifecycle-owned initializing, restart-tombstoned, and archived sessions reject new work. */
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
  const restartRecoveryTombstone = isRestartRecoveryTombstone(entry);
  if (restartRecoveryTombstone) {
    if (options?.allowRestartTombstoneReplacement === true) {
      return undefined;
    }
    return entry?.modelSelectionLocked === true
      ? `Session "${sessionKey}" ended during restart recovery and cannot be replaced while model selection is locked. Open it in WebChat and use Resume in new session.`
      : `Session "${sessionKey}" ended during restart recovery. Use /new or /reset to start a replacement session.`;
  }
  if (entry?.archivedAt !== undefined) {
    return `Session "${sessionKey}" is archived. Restore it before starting new work.`;
  }
  if (
    !options?.allowPendingWorkspace &&
    (entry?.pendingProjectGitUrl !== undefined || entry?.pendingWorktree !== undefined)
  ) {
    return `Session "${sessionKey}" workspace is not ready. Wait for setup to finish or retry in chat.`;
  }
  return undefined;
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
  return resolveTimestamp(Date.parse(value));
}

function readSessionHeaderStartedAtMs(params: {
  entry: SessionLifecycleEntry;
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
}): number | undefined {
  const sessionId = params.entry.sessionId?.trim();
  const sessionKey = params.sessionKey?.trim();
  const agentId =
    params.agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
  if (!sessionId || !agentId) {
    return undefined;
  }
  try {
    const header = loadTranscriptHeaderSync({
      agentId,
      sessionId,
      ...(params.storePath ? { storePath: params.storePath } : {}),
      ...(sessionKey ? { sessionKey } : {}),
    }) as { type?: unknown; id?: unknown; timestamp?: unknown } | undefined;
    if (
      header?.type !== "session" ||
      (typeof header.id === "string" && header.id.trim() && header.id !== sessionId)
    ) {
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
  sessionKey?: string;
  storePath?: string;
}): { sessionStartedAt?: number; lastInteractionAt?: number } {
  const entry = params.entry;
  if (!entry) {
    return {};
  }
  return {
    sessionStartedAt:
      resolveTimestamp(entry.sessionStartedAt) ??
      readSessionHeaderStartedAtMs({ ...params, entry }),
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
