// Process-local session-state tracker used by diagnostic stuck-session detection.
export type SessionStateValue = "idle" | "processing" | "waiting";

/** Mutable diagnostic state for one session key or id. */
export type SessionState = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  lastActivity: number;
  generation?: number;
  lastStuckWarnAgeMs?: number;
  lastLongRunningWarnAgeMs?: number;
  state: SessionStateValue;
  queueDepth: number;
  activeQueuedTurn?: boolean;
  toolCallHistory?: ToolCallRecord[];
  toolLoopWarningBuckets?: Map<string, number>;
  commandPollCounts?: Map<string, { count: number; lastPollAt: number }>;
};

/** Compact record of a recent tool call used for loop diagnostics. */
export type ToolCallRecord = {
  toolName: string;
  argsHash: string;
  toolCallId?: string;
  runId?: string;
  outcomeKind?: "tool-loop-veto" | "terminal-exec-failure";
  resultHash?: string;
  // Keep the raw result identity while this bounded identity survives alias
  // merges and lets the no-progress owner ignore diagnostic drift.
  failureIdentityHash?: string;
  noProgress?: true;
  unknownToolName?: string;
  timestamp: number;
};

/** Partial session identity accepted by diagnostic helpers. */
export type SessionRef = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
};

/** Shared in-memory diagnostic session state map. */
export const diagnosticSessionStates = new Map<string, SessionState>();

const SESSION_STATE_TTL_MS = 30 * 60 * 1000;
const SESSION_STATE_PRUNE_INTERVAL_MS = 60 * 1000;
const SESSION_STATE_MAX_ENTRIES = 2000;

let lastSessionPruneAt = 0;

/** Prunes stale idle session states and caps the process-local state map. */
export function pruneDiagnosticSessionStates(now = Date.now(), force = false): void {
  const shouldPruneForSize = diagnosticSessionStates.size > SESSION_STATE_MAX_ENTRIES;
  if (!force && !shouldPruneForSize && now - lastSessionPruneAt < SESSION_STATE_PRUNE_INTERVAL_MS) {
    return;
  }
  lastSessionPruneAt = now;

  let trackOldest = diagnosticSessionStates.size === SESSION_STATE_MAX_ENTRIES + 1;
  let oldest: [string, SessionState] | undefined;
  for (const entry of diagnosticSessionStates.entries()) {
    const [key, state] = entry;
    const ageMs = now - state.lastActivity;
    const isIdle = state.state === "idle";
    if (isIdle && state.queueDepth <= 0 && ageMs > SESSION_STATE_TTL_MS) {
      diagnosticSessionStates.delete(key);
      trackOldest = false;
    } else if (trackOldest && (!oldest || state.lastActivity < oldest[1].lastActivity)) {
      oldest = entry;
    }
  }

  if (diagnosticSessionStates.size <= SESSION_STATE_MAX_ENTRIES) {
    return;
  }
  // Insertions normally exceed the cap by one; equal ages keep Map order.
  if (oldest) {
    diagnosticSessionStates.delete(oldest[0]);
    return;
  }
  const ordered = Array.from(diagnosticSessionStates.entries()).toSorted(
    (a, b) => a[1].lastActivity - b[1].lastActivity,
  );
  for (const [key] of ordered) {
    diagnosticSessionStates.delete(key);
    if (diagnosticSessionStates.size <= SESSION_STATE_MAX_ENTRIES) {
      break;
    }
  }
}

function resolveSessionKey({ sessionKey, sessionId }: SessionRef) {
  return sessionKey ?? sessionId ?? "unknown";
}

function findStateEntryBySessionId(sessionId: string): [string, SessionState] | undefined {
  for (const entry of diagnosticSessionStates.entries()) {
    const [, state] = entry;
    if (state.sessionId === sessionId) {
      return entry;
    }
  }
  return undefined;
}

function sessionStatePriority(state: SessionStateValue): number {
  const priorities = {
    idle: 0,
    waiting: 1,
    processing: 2,
  } satisfies Record<SessionStateValue, number>;
  return priorities[state];
}

function mergeSessionState(target: SessionState, source: SessionState): void {
  const sourceIsNewer = source.lastActivity > target.lastActivity;
  const sourceIsSameAgeAndMoreActive =
    source.lastActivity === target.lastActivity &&
    sessionStatePriority(source.state) > sessionStatePriority(target.state);
  target.sessionId ??= source.sessionId;
  target.sessionKey ??= source.sessionKey;
  if (source.sessionFile && (sourceIsNewer || !target.sessionFile)) {
    target.sessionFile = source.sessionFile;
  }
  if (sourceIsNewer || sourceIsSameAgeAndMoreActive) {
    target.state = source.state;
  }
  target.generation = Math.max(target.generation ?? 0, source.generation ?? 0);
  target.lastActivity = Math.max(target.lastActivity, source.lastActivity);
  // Queue depth is additive when session id/key aliases collapse into one diagnostic entry.
  target.queueDepth += source.queueDepth;
  target.activeQueuedTurn ||= source.activeQueuedTurn;
  target.lastStuckWarnAgeMs =
    target.lastStuckWarnAgeMs === undefined || source.lastStuckWarnAgeMs === undefined
      ? undefined
      : Math.max(target.lastStuckWarnAgeMs, source.lastStuckWarnAgeMs);
  target.lastLongRunningWarnAgeMs =
    target.lastLongRunningWarnAgeMs === undefined || source.lastLongRunningWarnAgeMs === undefined
      ? undefined
      : Math.max(target.lastLongRunningWarnAgeMs, source.lastLongRunningWarnAgeMs);
  if (source.toolCallHistory?.length) {
    target.toolCallHistory = [...(target.toolCallHistory ?? []), ...source.toolCallHistory];
  }
  if (source.toolLoopWarningBuckets?.size) {
    const buckets = (target.toolLoopWarningBuckets ??= new Map());
    for (const [bucket, count] of source.toolLoopWarningBuckets) {
      buckets.set(bucket, Math.max(buckets.get(bucket) ?? 0, count));
    }
  }
  if (source.commandPollCounts?.size) {
    const counts = (target.commandPollCounts ??= new Map());
    for (const [command, value] of source.commandPollCounts) {
      const existing = counts.get(command);
      if (!existing || value.lastPollAt > existing.lastPollAt) {
        counts.set(command, value);
      }
    }
  }
}

/** Gets or creates diagnostic state, merging aliases that share a session id. */
export function getDiagnosticSessionState(ref: SessionRef): SessionState {
  pruneDiagnosticSessionStates();
  const key = resolveSessionKey(ref);
  const direct = diagnosticSessionStates.get(key);
  // This owner merges id aliases before assigning them; an exact direct hit is already canonical.
  const sessionIdEntry =
    ref.sessionId && direct?.sessionId !== ref.sessionId
      ? findStateEntryBySessionId(ref.sessionId)
      : undefined;
  const existing = direct ?? sessionIdEntry?.[1];
  if (existing) {
    if (direct && sessionIdEntry && sessionIdEntry[1] !== direct) {
      // A run may learn its stable session key after an id-only state exists; merge instead of losing counters.
      mergeSessionState(direct, sessionIdEntry[1]);
      diagnosticSessionStates.delete(sessionIdEntry[0]);
    } else if (!direct && ref.sessionKey && sessionIdEntry) {
      diagnosticSessionStates.delete(sessionIdEntry[0]);
      diagnosticSessionStates.set(key, existing);
    }
    if (ref.sessionId) {
      existing.sessionId = ref.sessionId;
    }
    if (ref.sessionKey) {
      existing.sessionKey = ref.sessionKey;
    }
    if (ref.sessionFile) {
      existing.sessionFile = ref.sessionFile;
    }
    return existing;
  }
  const created: SessionState = {
    sessionId: ref.sessionId,
    sessionKey: ref.sessionKey,
    sessionFile: ref.sessionFile,
    lastActivity: Date.now(),
    generation: 0,
    state: "idle",
    queueDepth: 0,
  };
  diagnosticSessionStates.set(key, created);
  pruneDiagnosticSessionStates();
  return created;
}

/** Looks up diagnostic state without creating a new entry. */
export function peekDiagnosticSessionState(ref: SessionRef): SessionState | undefined {
  const key = resolveSessionKey(ref);
  return (
    diagnosticSessionStates.get(key) ??
    (ref.sessionId ? findStateEntryBySessionId(ref.sessionId)?.[1] : undefined)
  );
}

/** Retires collector observations without resetting independent tool-loop or poll policy. */
export function retireDiagnosticSessionObservations(): void {
  for (const state of diagnosticSessionStates.values()) {
    // Recovery accepts one completion increment. A collector boundary must
    // advance beyond that exception before this session can collect fresh work.
    state.generation = (state.generation ?? 0) + 2;
    state.state = "idle";
    state.queueDepth = 0;
    state.activeQueuedTurn = false;
    state.lastActivity = Date.now();
    state.lastStuckWarnAgeMs = undefined;
    state.lastLongRunningWarnAgeMs = undefined;
  }
}

/** Clears all process-local diagnostic session state for tests. */
export function resetDiagnosticSessionStateForTest(): void {
  diagnosticSessionStates.clear();
  lastSessionPruneAt = 0;
}

/** Checks whether a generation/state snapshot still matches current diagnostic state. */
export function isDiagnosticSessionStateCurrent(params: {
  sessionId?: string;
  sessionKey?: string;
  generation?: number;
  state?: SessionStateValue;
}): boolean {
  if (params.generation === undefined) {
    return true;
  }
  const state = peekDiagnosticSessionState(params);
  if (!state) {
    return false;
  }
  return (
    (state.generation ?? 0) === params.generation &&
    (params.state === undefined || state.state === params.state)
  );
}
