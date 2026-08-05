/**
 * Shared process-local state for active and abandoned embedded-agent runs.
 */
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../../auto-reply/get-reply-options.types.js";
import {
  getActiveReplyRunCount,
  isReplyRunActiveForSessionId,
  isReplyRunActiveForSessionIdAndAgent,
  listActiveReplyRunSessionKeys,
  listActiveReplyRunSessionIds,
  resolveActiveReplyRunSessionId,
  resolveActiveReplyRunSessionIdForAgent,
  type ReplyBackendQueueMessageOptions,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import {
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

function normalizeEmbeddedSessionFileKey(sessionFile: string | undefined): string | undefined {
  const normalized = sessionFile?.trim();
  return normalized || undefined;
}

/**
 * Shared process state for embedded-agent runs, queues, and snapshots.
 *
 * The maps are global-singleton backed so reloads and lazy imports inside the same gateway process
 * do not split active-run bookkeeping.
 */
export type EmbeddedAgentQueueHandle = {
  kind?: "embedded";
  runId?: string;
  queueMessage: (text: string, options?: EmbeddedAgentQueueMessageOptions) => Promise<void>;
  isStreaming: () => boolean;
  isStopped?: () => boolean;
  /** True after this handle has accepted an abort, even while cleanup retains it. */
  isAborted?: () => boolean;
  isAbortable?: () => boolean;
  isCompacting: () => boolean;
  supportsTranscriptCommitWait?: boolean;
  /** True only when queueMessage preserves images supplied in its options. */
  supportsQueueMessageImages?: boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: (reason?: "restart") => void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
};

export type EmbeddedAgentQueueMessageOptions = ReplyBackendQueueMessageOptions;

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

export type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer?: NodeJS.Timeout;
};

export type AbandonedEmbeddedRun = {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  agentId?: string;
  abandonedAtMs: number;
  reason: "timeout";
};

const EMBEDDED_RUN_STATE_KEY = Symbol.for("openclaw.embeddedRunState");

const embeddedRunState = resolveGlobalSingleton(EMBEDDED_RUN_STATE_KEY, () => ({
  activeRuns: new Map<string, EmbeddedAgentQueueHandle>(),
  activeRunsByRunId: new Map<string, EmbeddedAgentQueueHandle>(),
  activeRunLifecycleGenerations: new WeakMap<EmbeddedAgentQueueHandle, string>(),
  retainedAbortabilityRunIds: new Set<string>(),
  snapshots: new Map<string, ActiveEmbeddedRunSnapshot>(),
  sessionIdsByKey: new Map<string, string>(),
  sessionIdsByAgentScopedFallbackKey: new Map<string, string>(),
  sessionIdsByFile: new Map<string, string>(),
  abandonedRunsBySessionId: new Map<string, AbandonedEmbeddedRun>(),
  abandonedRunsByAgentScopedFallbackKey: new Map<string, AbandonedEmbeddedRun>(),
  abandonedRunSessionIdsByKey: new Map<string, string>(),
  abandonedRunSessionIdsByAgentScopedFallbackKey: new Map<string, string>(),
  abandonedRunSessionIdsByFile: new Map<string, string>(),
  waiters: new Map<string, Set<EmbeddedRunWaiter>>(),
}));

export const ACTIVE_EMBEDDED_RUNS =
  embeddedRunState.activeRuns ??
  (embeddedRunState.activeRuns = new Map<string, EmbeddedAgentQueueHandle>());
export const ACTIVE_EMBEDDED_RUNS_BY_RUN_ID =
  embeddedRunState.activeRunsByRunId ??
  (embeddedRunState.activeRunsByRunId = new Map<string, EmbeddedAgentQueueHandle>());
const ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS =
  embeddedRunState.activeRunLifecycleGenerations ??
  (embeddedRunState.activeRunLifecycleGenerations = new WeakMap<
    EmbeddedAgentQueueHandle,
    string
  >());
export const RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS =
  embeddedRunState.retainedAbortabilityRunIds ??
  (embeddedRunState.retainedAbortabilityRunIds = new Set<string>());
export const ACTIVE_EMBEDDED_RUN_SNAPSHOTS =
  embeddedRunState.snapshots ??
  (embeddedRunState.snapshots = new Map<string, ActiveEmbeddedRunSnapshot>());
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.sessionIdsByKey ??
  (embeddedRunState.sessionIdsByKey = new Map<string, string>());
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY =
  embeddedRunState.sessionIdsByAgentScopedFallbackKey ??
  (embeddedRunState.sessionIdsByAgentScopedFallbackKey = new Map<string, string>());
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE =
  embeddedRunState.sessionIdsByFile ??
  (embeddedRunState.sessionIdsByFile = new Map<string, string>());
export const ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID =
  embeddedRunState.abandonedRunsBySessionId ??
  (embeddedRunState.abandonedRunsBySessionId = new Map<string, AbandonedEmbeddedRun>());
export const ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY =
  embeddedRunState.abandonedRunsByAgentScopedFallbackKey ??
  (embeddedRunState.abandonedRunsByAgentScopedFallbackKey = new Map<
    string,
    AbandonedEmbeddedRun
  >());
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.abandonedRunSessionIdsByKey ??
  (embeddedRunState.abandonedRunSessionIdsByKey = new Map<string, string>());
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY =
  embeddedRunState.abandonedRunSessionIdsByAgentScopedFallbackKey ??
  (embeddedRunState.abandonedRunSessionIdsByAgentScopedFallbackKey = new Map<string, string>());
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE =
  embeddedRunState.abandonedRunSessionIdsByFile ??
  (embeddedRunState.abandonedRunSessionIdsByFile = new Map<string, string>());
export const EMBEDDED_RUN_WAITERS =
  embeddedRunState.waiters ??
  (embeddedRunState.waiters = new Map<string, Set<EmbeddedRunWaiter>>());

// `global` and `unknown` are per-agent store rows but process-wide runtime keys.
// Session ids remain run-generation identities; this side index scopes those
// fallback aliases without creating a second active-handle ownership model.
export function resolveEmbeddedRunAgentScopedFallbackIndexKey(params: {
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const rawSessionKey = params.sessionKey?.trim();
  const parsedSessionKey = parseAgentSessionKey(rawSessionKey);
  const sessionKey = parsedSessionKey?.rest ?? rawSessionKey;
  const agentId = params.agentId?.trim() || parsedSessionKey?.agentId;
  if (!sessionKey || !agentId || !isUnscopedSessionKeySentinel(sessionKey)) {
    return undefined;
  }
  return `${normalizeAgentId(agentId)}:${sessionKey.toLowerCase()}`;
}

function resolveOnlyAgentScopedFallbackSessionId(
  map: ReadonlyMap<string, string>,
  sessionKey: string,
  legacySessionId?: string,
): { found: boolean; sessionId?: string } {
  const suffix = `:${sessionKey.toLowerCase()}`;
  let resolvedSessionId: string | undefined;
  let found = false;
  const addSessionId = (sessionId: string): { ambiguous: true } | undefined => {
    if (!found) {
      resolvedSessionId = sessionId;
      found = true;
      return undefined;
    }
    return resolvedSessionId === sessionId ? undefined : { ambiguous: true };
  };
  if (legacySessionId) {
    addSessionId(legacySessionId);
  }
  for (const [scopedKey, sessionId] of map) {
    if (!scopedKey.endsWith(suffix)) {
      continue;
    }
    if (addSessionId(sessionId)?.ambiguous) {
      return { found: true };
    }
  }
  return found ? { found: true, sessionId: resolvedSessionId } : { found: false };
}

function listAgentScopedFallbackSessionKeys(map: ReadonlyMap<string, string>): string[] {
  const keys = new Set<string>();
  for (const scopedKey of map.keys()) {
    if (scopedKey.endsWith(":global")) {
      keys.add("global");
    } else if (scopedKey.endsWith(":unknown")) {
      keys.add("unknown");
    }
  }
  return [...keys];
}

export function resolveActiveEmbeddedRunSessionIdByKey(
  sessionKey: string,
  agentId?: string,
): string | undefined {
  const scopedFallbackKey = resolveEmbeddedRunAgentScopedFallbackIndexKey({
    sessionKey,
    agentId,
  });
  if (scopedFallbackKey) {
    return ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.get(scopedFallbackKey);
  }
  if (isUnscopedSessionKeySentinel(sessionKey)) {
    const scoped = resolveOnlyAgentScopedFallbackSessionId(
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY,
      sessionKey,
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(sessionKey),
    );
    return scoped.found ? scoped.sessionId : undefined;
  }
  return ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(sessionKey);
}

function resolveAbandonedEmbeddedRunSessionIdByKey(
  sessionKey: string,
  agentId?: string,
): string | undefined {
  const scopedFallbackKey = resolveEmbeddedRunAgentScopedFallbackIndexKey({
    sessionKey,
    agentId,
  });
  if (scopedFallbackKey) {
    return ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.get(scopedFallbackKey);
  }
  if (isUnscopedSessionKeySentinel(sessionKey)) {
    const scoped = resolveOnlyAgentScopedFallbackSessionId(
      ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY,
      sessionKey,
      ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(sessionKey),
    );
    return scoped.found ? scoped.sessionId : undefined;
  }
  return ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(sessionKey);
}

function evictPriorLifecycleEmbeddedRuns(): void {
  const staleHandles = new Set<EmbeddedAgentQueueHandle>();
  for (const [sessionId, handle] of ACTIVE_EMBEDDED_RUNS) {
    const lifecycleGeneration = ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.get(handle);
    if (lifecycleGeneration && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
      continue;
    }
    staleHandles.add(handle);
    if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
      ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    }
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
  }
  for (const [runId, handle] of ACTIVE_EMBEDDED_RUNS_BY_RUN_ID) {
    const lifecycleGeneration = ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.get(handle);
    if (lifecycleGeneration && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
      continue;
    }
    staleHandles.add(handle);
    // This index only gates the separately owned chat abort controller; absence
    // is abortable. Keeping it would let stale ownership influence new work.
    if (ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId) === handle) {
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(runId);
      RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.delete(runId);
    }
  }
  for (const [sessionKey, sessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(sessionKey);
    }
  }
  for (const [
    sessionKey,
    sessionId,
  ] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.delete(sessionKey);
    }
  }
  for (const [sessionFile, sessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.delete(sessionFile);
    }
  }
  for (const [sessionId, waiters] of EMBEDDED_RUN_WAITERS) {
    if (ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      continue;
    }
    EMBEDDED_RUN_WAITERS.delete(sessionId);
    for (const waiter of waiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(true);
    }
  }
  const abortErrors: unknown[] = [];
  // Remove stale ownership first so synchronous abort callbacks may register a
  // replacement without the cleanup above erasing that current-generation run.
  for (const handle of staleHandles) {
    try {
      handle.abort("restart");
    } catch (error) {
      abortErrors.push(error);
    }
  }
  if (abortErrors.length > 0) {
    throw new AggregateError(abortErrors, "Failed to abort stale embedded agent runs");
  }
}

registerAgentEventLifecycleRotationHandler("embedded-agent-runs", evictPriorLifecycleEmbeddedRuns);

/** Counts active embedded runs while including auto-reply registry runs for shared sessions. */
export function getActiveEmbeddedRunCount(): number {
  let activeCount = ACTIVE_EMBEDDED_RUNS.size;
  for (const sessionId of listActiveReplyRunSessionIds()) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      activeCount += 1;
    }
  }
  return Math.max(activeCount, getActiveReplyRunCount());
}

/** Lists active embedded-run session keys from both embedded and auto-reply registries. */
export function listActiveEmbeddedRunSessionKeys(): string[] {
  return [
    ...new Set([
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.keys(),
      ...listAgentScopedFallbackSessionKeys(
        ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY,
      ),
      ...listActiveReplyRunSessionKeys(),
    ]),
  ].toSorted((a, b) => a.localeCompare(b));
}

/** Lists active embedded-run session ids from all embedded-run lookup maps. */
export function listActiveEmbeddedRunSessionIds(): string[] {
  return [
    ...new Set([
      ...ACTIVE_EMBEDDED_RUNS.keys(),
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.values(),
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.values(),
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.values(),
      ...listActiveReplyRunSessionIds(),
    ]),
  ].toSorted((a, b) => a.localeCompare(b));
}

export function setActiveEmbeddedRunLifecycleGeneration(
  handle: EmbeddedAgentQueueHandle,
  lifecycleGeneration: string,
): string {
  // A delayed re-registration must not transfer an old driver into the new
  // Gateway lifecycle and suppress orphan recovery again.
  const existingLifecycleGeneration = ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.get(handle);
  if (existingLifecycleGeneration !== undefined) {
    return existingLifecycleGeneration;
  }
  ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.set(handle, lifecycleGeneration);
  return lifecycleGeneration;
}

/** Resolves the current session id for an active run after resets or compaction. */
export function resolveActiveEmbeddedRunSessionId(
  sessionKey: string,
  agentId?: string,
): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  const parsedSessionKey = parseAgentSessionKey(normalizedSessionKey);
  const resolvedAgentId = agentId ?? parsedSessionKey?.agentId;
  const scopedFallbackKey = resolveEmbeddedRunAgentScopedFallbackIndexKey({
    sessionKey: normalizedSessionKey,
    agentId: resolvedAgentId,
  });
  const fallbackSessionKey = scopedFallbackKey ? parsedSessionKey?.rest : undefined;
  const scopedReplySessionId =
    scopedFallbackKey && resolvedAgentId
      ? (resolveActiveReplyRunSessionIdForAgent(normalizedSessionKey, resolvedAgentId) ??
        (fallbackSessionKey
          ? resolveActiveReplyRunSessionIdForAgent(fallbackSessionKey, resolvedAgentId)
          : undefined))
      : undefined;
  return (
    scopedReplySessionId ??
    (!scopedFallbackKey ? resolveActiveReplyRunSessionId(normalizedSessionKey) : undefined) ??
    resolveActiveEmbeddedRunSessionIdByKey(normalizedSessionKey, resolvedAgentId)
  );
}

type EmbeddedRunDiagnosticSnapshot = {
  active: boolean;
  sessionId?: string;
  sessionKey?: string;
  streaming?: boolean;
  compacting?: boolean;
  transcriptCommitWait?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  hasTranscriptSnapshot?: boolean;
  abandoned?: {
    sessionId: string;
    sessionKey?: string;
    abandonedAtMs: number;
    reason: AbandonedEmbeddedRun["reason"];
  };
};

function resolveEmbeddedRunDiagnosticSessionId(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  agentId?: string;
}): string | undefined {
  const sessionId = params.sessionId?.trim();
  const sessionKey = params.sessionKey?.trim();
  const scopedFallbackKey = resolveEmbeddedRunAgentScopedFallbackIndexKey({
    sessionKey,
    agentId: params.agentId,
  });
  if (sessionKey) {
    const embeddedSessionId = resolveActiveEmbeddedRunSessionIdByKey(sessionKey, params.agentId);
    const activeSessionId =
      params.agentId && isUnscopedSessionKeySentinel(sessionKey)
        ? (resolveActiveReplyRunSessionIdForAgent(sessionKey, params.agentId) ?? embeddedSessionId)
        : (resolveActiveReplyRunSessionId(sessionKey) ?? embeddedSessionId);
    if (activeSessionId) {
      return activeSessionId;
    }
  }
  const sessionFile = params.sessionFile?.trim();
  const sessionFileKey = normalizeEmbeddedSessionFileKey(sessionFile);
  if (sessionFile && !scopedFallbackKey) {
    const activeSessionId = sessionFileKey
      ? ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(sessionFileKey)
      : undefined;
    if (activeSessionId) {
      return activeSessionId;
    }
  }
  if (
    sessionId &&
    isReplyRunActiveForDiagnosticIdentity({
      sessionId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    })
  ) {
    return sessionId;
  }
  if (sessionKey) {
    const abandonedSessionId = resolveAbandonedEmbeddedRunSessionIdByKey(
      sessionKey,
      params.agentId,
    );
    if (abandonedSessionId) {
      return abandonedSessionId;
    }
  }
  if (sessionFileKey && !scopedFallbackKey) {
    const abandonedSessionId = sessionFileKey
      ? ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(sessionFileKey)
      : undefined;
    if (abandonedSessionId) {
      return abandonedSessionId;
    }
  }
  const hasConflictingActiveIndex =
    sessionId !== undefined &&
    hasConflictingEmbeddedRunDiagnosticIndex({
      sessionId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(sessionFileKey ? { sessionFileKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    });
  if (
    sessionId &&
    (ACTIVE_EMBEDDED_RUNS.has(sessionId) ||
      isReplyRunActiveForDiagnosticIdentity({
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
      })) &&
    !hasConflictingActiveIndex
  ) {
    return sessionId;
  }
  if (sessionId && !hasConflictingActiveIndex) {
    return sessionId;
  }
  return undefined;
}

function isReplyRunActiveForDiagnosticIdentity(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
}): boolean {
  if (
    params.sessionKey &&
    params.agentId &&
    resolveEmbeddedRunAgentScopedFallbackIndexKey(params)
  ) {
    return isReplyRunActiveForSessionIdAndAgent(params.sessionId, params.agentId);
  }
  return isReplyRunActiveForSessionId(params.sessionId);
}

function hasConflictingEmbeddedRunDiagnosticIndex(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFileKey?: string;
  agentId?: string;
}): boolean {
  const scopedFallbackKey = resolveEmbeddedRunAgentScopedFallbackIndexKey({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (scopedFallbackKey) {
    const scopedSessionId =
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.get(scopedFallbackKey);
    if (scopedSessionId && scopedSessionId !== params.sessionId) {
      return true;
    }
  } else if (
    params.sessionKey &&
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.has(params.sessionKey) &&
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(params.sessionKey) !== params.sessionId
  ) {
    return true;
  }
  if (
    params.sessionFileKey &&
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.has(params.sessionFileKey) &&
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(params.sessionFileKey) !== params.sessionId
  ) {
    return true;
  }
  for (const [sessionKey, indexedSessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY) {
    if (
      indexedSessionId === params.sessionId &&
      params.sessionKey &&
      sessionKey !== params.sessionKey
    ) {
      return true;
    }
  }
  for (const [sessionFileKey, indexedSessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE) {
    if (
      indexedSessionId === params.sessionId &&
      params.sessionFileKey &&
      sessionFileKey !== params.sessionFileKey
    ) {
      return true;
    }
  }
  return false;
}

function hasActiveEmbeddedRunDiagnosticOwnership(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFileKey?: string;
  agentId?: string;
}): boolean {
  if (!ACTIVE_EMBEDDED_RUNS.has(params.sessionId)) {
    return false;
  }
  const scopedFallbackKey = resolveEmbeddedRunAgentScopedFallbackIndexKey({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (scopedFallbackKey) {
    return (
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.get(scopedFallbackKey) ===
      params.sessionId
    );
  }
  if (
    params.sessionFileKey &&
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(params.sessionFileKey) === params.sessionId
  ) {
    return true;
  }
  if (params.sessionKey && isUnscopedSessionKeySentinel(params.sessionKey)) {
    const scoped = resolveOnlyAgentScopedFallbackSessionId(
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY,
      params.sessionKey,
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(params.sessionKey),
    );
    if (scoped.found) {
      return scoped.sessionId === params.sessionId;
    }
  }
  if (
    params.sessionKey &&
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(params.sessionKey) === params.sessionId
  ) {
    return true;
  }
  return !hasConflictingEmbeddedRunDiagnosticIndex(params);
}

function resolveEmbeddedRunDiagnosticAbandonment(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFileKey?: string;
  agentId?: string;
}): AbandonedEmbeddedRun | undefined {
  const matchesDiagnosticIdentity = (run: AbandonedEmbeddedRun): boolean => {
    if (params.sessionId && run.sessionId !== params.sessionId) {
      return false;
    }
    const runFileKey = normalizeEmbeddedSessionFileKey(run.sessionFile);
    return !params.sessionFileKey || !runFileKey || runFileKey === params.sessionFileKey;
  };
  const scopedFallbackKey = resolveEmbeddedRunAgentScopedFallbackIndexKey({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (scopedFallbackKey) {
    const scopedRun = ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY.get(scopedFallbackKey);
    if (scopedRun && matchesDiagnosticIdentity(scopedRun)) {
      return scopedRun;
    }
    const sessionRun = params.sessionId
      ? ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(params.sessionId)
      : undefined;
    if (sessionRun && !matchesDiagnosticIdentity(sessionRun)) {
      return undefined;
    }
    const sessionRunScopedKey = resolveEmbeddedRunAgentScopedFallbackIndexKey({
      sessionKey: sessionRun?.sessionKey,
      agentId: sessionRun?.agentId,
    });
    if (sessionRunScopedKey) {
      return sessionRunScopedKey === scopedFallbackKey ? sessionRun : undefined;
    }
    const sessionRunFileKey = normalizeEmbeddedSessionFileKey(sessionRun?.sessionFile);
    return params.sessionFileKey && sessionRunFileKey === params.sessionFileKey
      ? sessionRun
      : undefined;
  }
  return params.sessionId ? ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(params.sessionId) : undefined;
}

/** Projects embedded run state for read-only diagnostics without exposing prompts or messages. */
export function getEmbeddedRunDiagnosticSnapshot(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  agentId?: string;
}): EmbeddedRunDiagnosticSnapshot {
  const sessionId = resolveEmbeddedRunDiagnosticSessionId(params);
  const sessionFile = params.sessionFile?.trim();
  const sessionFileKey = normalizeEmbeddedSessionFileKey(sessionFile);
  const activeOwnership =
    sessionId &&
    hasActiveEmbeddedRunDiagnosticOwnership({
      sessionId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(sessionFileKey ? { sessionFileKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    });
  const handle = activeOwnership ? ACTIVE_EMBEDDED_RUNS.get(sessionId) : undefined;
  const abandoned = resolveEmbeddedRunDiagnosticAbandonment({
    sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(sessionFileKey ? { sessionFileKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const replyRunActive = sessionId
    ? isReplyRunActiveForDiagnosticIdentity({
        sessionId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
      })
    : false;
  return {
    active: Boolean(handle) || replyRunActive,
    ...(sessionId ? { sessionId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(handle ? { streaming: handle.isStreaming() } : {}),
    ...(handle ? { compacting: handle.isCompacting() } : {}),
    ...(handle?.supportsTranscriptCommitWait !== undefined
      ? { transcriptCommitWait: handle.supportsTranscriptCommitWait }
      : {}),
    ...(handle?.sourceReplyDeliveryMode
      ? { sourceReplyDeliveryMode: handle.sourceReplyDeliveryMode }
      : {}),
    ...(handle && sessionId
      ? { hasTranscriptSnapshot: ACTIVE_EMBEDDED_RUN_SNAPSHOTS.has(sessionId) }
      : {}),
    ...(abandoned
      ? {
          abandoned: {
            sessionId: abandoned.sessionId,
            ...(abandoned.sessionKey ? { sessionKey: abandoned.sessionKey } : {}),
            abandonedAtMs: abandoned.abandonedAtMs,
            reason: abandoned.reason,
          },
        }
      : {}),
  };
}
