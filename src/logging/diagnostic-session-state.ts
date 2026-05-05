export type SessionStateValue = "idle" | "processing" | "waiting";

export type SessionState = {
  sessionId?: string;
  sessionKey?: string;
  lastActivity: number;
  generation?: number;
  lastStuckWarnAgeMs?: number;
  lastLongRunningWarnAgeMs?: number;
  state: SessionStateValue;
  queueDepth: number;
  toolCallHistory?: ToolCallRecord[];
  toolLoopWarningBuckets?: Map<string, number>;
  commandPollCounts?: Map<string, { count: number; lastPollAt: number }>;
};

export type ToolCallRecord = {
  toolName: string;
  argsHash: string;
  toolCallId?: string;
  runId?: string;
  resultHash?: string;
  unknownToolName?: string;
  timestamp: number;
};

export type SessionRef = {
  sessionId?: string;
  sessionKey?: string;
};

export const diagnosticSessionStates = new Map<string, SessionState>();

const SESSION_STATE_TTL_MS = 30 * 60 * 1000;
const SESSION_STATE_PRUNE_INTERVAL_MS = 60 * 1000;
const SESSION_STATE_MAX_ENTRIES = 2000;

let lastSessionPruneAt = 0;

export function pruneDiagnosticSessionStates(now = Date.now(), force = false): void {
  const shouldPruneForSize = diagnosticSessionStates.size > SESSION_STATE_MAX_ENTRIES;
  if (!force && !shouldPruneForSize && now - lastSessionPruneAt < SESSION_STATE_PRUNE_INTERVAL_MS) {
    return;
  }
  lastSessionPruneAt = now;

  for (const [key, state] of diagnosticSessionStates.entries()) {
    const ageMs = now - state.lastActivity;
    const isIdle = state.state === "idle";
    if (isIdle && state.queueDepth <= 0 && ageMs > SESSION_STATE_TTL_MS) {
      diagnosticSessionStates.delete(key);
    }
  }

  if (diagnosticSessionStates.size <= SESSION_STATE_MAX_ENTRIES) {
    return;
  }
  const excess = diagnosticSessionStates.size - SESSION_STATE_MAX_ENTRIES;
  const ordered = Array.from(diagnosticSessionStates.entries()).toSorted(
    (a, b) => a[1].lastActivity - b[1].lastActivity,
  );
  for (let i = 0; i < excess; i += 1) {
    const key = ordered[i]?.[0];
    if (!key) {
      break;
    }
    diagnosticSessionStates.delete(key);
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
  if (sourceIsNewer || sourceIsSameAgeAndMoreActive) {
    target.state = source.state;
  }
  target.generation = Math.max(target.generation ?? 0, source.generation ?? 0);
  target.lastActivity = Math.max(target.lastActivity, source.lastActivity);
  target.queueDepth += source.queueDepth;
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

export function getDiagnosticSessionState(ref: SessionRef): SessionState {
  pruneDiagnosticSessionStates();
  const key = resolveSessionKey(ref);
  const direct = diagnosticSessionStates.get(key);
  const sessionIdEntry = ref.sessionId ? findStateEntryBySessionId(ref.sessionId) : undefined;
  const existing = direct ?? sessionIdEntry?.[1];
  if (existing) {
    if (direct && sessionIdEntry && sessionIdEntry[1] !== direct) {
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
    return existing;
  }
  const created: SessionState = {
    sessionId: ref.sessionId,
    sessionKey: ref.sessionKey,
    lastActivity: Date.now(),
    generation: 0,
    state: "idle",
    queueDepth: 0,
  };
  diagnosticSessionStates.set(key, created);
  pruneDiagnosticSessionStates(Date.now(), true);
  return created;
}

export function peekDiagnosticSessionState(ref: SessionRef): SessionState | undefined {
  const key = resolveSessionKey(ref);
  return (
    diagnosticSessionStates.get(key) ??
    (ref.sessionId ? findStateEntryBySessionId(ref.sessionId)?.[1] : undefined)
  );
}

export function getDiagnosticSessionStateCountForTest(): number {
  return diagnosticSessionStates.size;
}

export function resetDiagnosticSessionStateForTest(): void {
  diagnosticSessionStates.clear();
  lastSessionPruneAt = 0;
}

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
