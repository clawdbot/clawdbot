/** Browser-safe identity and replay rules shared by Gateway conversation clients. */

export type SessionMessageEnvelope = {
  messageId?: unknown;
  messageSeq?: unknown;
  clientRunId?: unknown;
  runId?: unknown;
  idempotencyKey?: unknown;
};

export type SessionMessageIdentity = {
  role: string;
  id: string | null;
  sequence: number | null;
  idempotencyKey: string | null;
  runId: string | null;
  isImported: boolean;
  externalSource: string | null;
};

export type SessionProjectionScope = {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  lifecycleRevision?: number | string;
  activeLeafEntryId?: string | null;
};

export type SessionProjectionRunStatus =
  | "streaming"
  | "completed"
  | "error"
  | "aborted"
  | "timeout"
  | "yielded";

export type SessionProjectionRun = {
  runId: string;
  status: SessionProjectionRunStatus;
  message?: unknown;
  acceptedFinalMessageIdentities?: readonly string[];
  stopReason?: string;
  errorKind?: string;
  errorMessage?: string;
};

export type SessionProjectionEntry = {
  message: unknown;
  identity: SessionMessageIdentity | null;
  live: boolean;
  pending: boolean;
  pendingRunId: string | null;
};

export type SessionProjectionState = {
  scope: SessionProjectionScope;
  entries: readonly SessionProjectionEntry[];
  messages: readonly unknown[];
  runs: Readonly<Record<string, SessionProjectionRun>>;
  hasTransportGap: boolean;
};

const MAX_TRACKED_SESSION_RUNS = 200;
const RETAINED_SESSION_RUNS = 150;
const MAX_ACCEPTED_FINAL_MESSAGES_PER_RUN = 32;

type ScopedSessionProjectionEvent = {
  scope?: SessionProjectionScope;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  lifecycleRevision?: number | string;
  activeLeafEntryId?: string | null;
};

export type SessionProjectionEvent = ScopedSessionProjectionEvent &
  (
    | { type: "snapshotLoaded"; messages: readonly unknown[] }
    | ({
        type: "messagePersisted";
        message: unknown;
        envelope?: SessionMessageEnvelope;
      } & SessionMessageEnvelope)
    | {
        type: "sendPending";
        message: unknown;
        runId?: string;
        idempotencyKey?: string;
      }
    | { type: "sendAcknowledged"; runId?: string; idempotencyKey?: string }
    | { type: "runDelta"; runId: string; message?: unknown }
    | {
        type: "runTerminal";
        runId: string;
        status: Exclude<SessionProjectionRunStatus, "streaming">;
        message?: unknown;
        stopReason?: string;
        errorKind?: string;
        errorMessage?: string;
      }
    | { type: "sessionReset" }
    | { type: "transportGap" }
    | { type: "reconnected" }
  );

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonemptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** History and status markers carry transcript order even when they have no chat role. */
export function readSessionMessageSequence(
  message: unknown,
  envelope?: SessionMessageEnvelope,
): number | null {
  const metadata = readRecord(readRecord(message)?.["__openclaw"]);
  return readPositiveSafeInteger(metadata?.seq) ?? readPositiveSafeInteger(envelope?.messageSeq);
}

/** Run ownership normalizes a user-turn suffix without changing its persisted send key. */
export function normalizeSessionProjectionRunId(value: unknown): string | null {
  const runId = readNonemptyString(value);
  return runId?.endsWith(":user") ? runId.slice(0, -":user".length) || null : runId;
}

/** Persisted transcript facts win over envelope projections and provider-local import IDs. */
export function readSessionMessageIdentity(
  message: unknown,
  envelope?: SessionMessageEnvelope,
): SessionMessageIdentity | null {
  const record = readRecord(message);
  const role = readNonemptyString(record?.role)?.toLowerCase();
  if (!record || !role) {
    return null;
  }
  const metadata = readRecord(record["__openclaw"]);
  const importedFrom = readNonemptyString(metadata?.importedFrom);
  const cliSessionId = readNonemptyString(metadata?.cliSessionId);
  const externalId = readNonemptyString(metadata?.externalId);
  const idempotencyKey =
    readNonemptyString(metadata?.idempotencyKey) ??
    readNonemptyString(record.idempotencyKey) ??
    readNonemptyString(envelope?.idempotencyKey) ??
    readNonemptyString(envelope?.clientRunId);
  return {
    role,
    id: readNonemptyString(metadata?.id) ?? readNonemptyString(envelope?.messageId),
    sequence: readSessionMessageSequence(message, envelope),
    idempotencyKey,
    runId:
      normalizeSessionProjectionRunId(idempotencyKey) ??
      normalizeSessionProjectionRunId(envelope?.runId),
    isImported: Boolean(importedFrom || cliSessionId || externalId),
    // Imported IDs belong to their provider and CLI session, never the native ID namespace.
    externalSource:
      importedFrom && cliSessionId && externalId
        ? JSON.stringify([importedFrom, cliSessionId, externalId])
        : null,
  };
}

function createEntry(
  message: unknown,
  options?: { envelope?: SessionMessageEnvelope; live?: boolean; pendingRunId?: string | null },
): SessionProjectionEntry {
  const identity = readSessionMessageIdentity(message, options?.envelope);
  const pendingRunId = normalizeSessionProjectionRunId(options?.pendingRunId);
  return {
    message,
    identity,
    live: options?.live === true,
    pending: pendingRunId !== null,
    pendingRunId,
  };
}

export function createSessionProjection(
  scope: SessionProjectionScope = {},
  messages: readonly unknown[] = [],
): SessionProjectionState {
  const entries = messages.map((message) => createEntry(message));
  return {
    scope: { ...scope },
    entries,
    messages: entries.map((entry) => entry.message),
    runs: {},
    hasTransportGap: false,
  };
}

function scopesMatch(left: SessionProjectionScope, right: SessionProjectionScope): boolean {
  const keys = [
    "sessionKey",
    "sessionId",
    "agentId",
    "lifecycleRevision",
    "activeLeafEntryId",
  ] as const;
  return keys.every(
    (key) => left[key] === undefined || right[key] === undefined || left[key] === right[key],
  );
}

function readEventScope(event: ScopedSessionProjectionEvent): SessionProjectionScope {
  return {
    ...event.scope,
    ...(event.sessionKey === undefined ? {} : { sessionKey: event.sessionKey }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
    ...(event.lifecycleRevision === undefined
      ? {}
      : { lifecycleRevision: event.lifecycleRevision }),
    ...(event.activeLeafEntryId === undefined
      ? {}
      : { activeLeafEntryId: event.activeLeafEntryId }),
  };
}

function sameTranscriptIdentity(
  left: SessionMessageIdentity | null,
  right: SessionMessageIdentity | null,
): boolean {
  if (!left || !right || left.role !== right.role) {
    return false;
  }
  if (left.isImported || right.isImported) {
    if (!left.isImported || !right.isImported) {
      return false;
    }
    if (left.externalSource || right.externalSource) {
      return Boolean(left.externalSource && left.externalSource === right.externalSource);
    }
    // Partial provider IDs are unsafe, but a same-scope persisted sequence is authoritative.
    return left.sequence !== null && right.sequence !== null && left.sequence === right.sequence;
  }
  if (left.id && right.id) {
    return left.id === right.id;
  }
  // A missing durable ID cannot adopt another canonical row simply because a sequence agrees.
  if (left.id || right.id) {
    return false;
  }
  if (left.sequence !== null && right.sequence !== null) {
    return left.sequence === right.sequence;
  }
  // A run can publish several durable messages; its ID identifies ownership, not a row.
  return false;
}

function entryMatches(left: SessionProjectionEntry, right: SessionProjectionEntry): boolean {
  if (sameTranscriptIdentity(left.identity, right.identity)) {
    return true;
  }
  if (left.pending && right.pending) {
    return Boolean(
      left.identity?.role === right.identity?.role &&
      left.pendingRunId &&
      left.pendingRunId === right.pendingRunId,
    );
  }
  const pending = left.pending ? left : right.pending ? right : null;
  const authoritative = pending === left ? right : pending === right ? left : null;
  return Boolean(
    pending &&
    authoritative &&
    pending.identity?.role === authoritative.identity?.role &&
    !pending.identity?.isImported &&
    !authoritative.identity?.isImported &&
    pending.pendingRunId &&
    pending.pendingRunId === authoritative.identity?.runId,
  );
}

function snapshotEntryMatches(
  snapshot: SessionProjectionEntry,
  current: SessionProjectionEntry,
): boolean {
  if (entryMatches(snapshot, current)) {
    return true;
  }
  const persisted = snapshot.identity;
  const observed = current.identity;
  // Only current-scope history may promote an observed, sequence-only native live row.
  return Boolean(
    current.live &&
    !current.pending &&
    persisted &&
    observed &&
    persisted.role === observed.role &&
    !persisted.isImported &&
    !observed.isImported &&
    persisted.id &&
    !observed.id &&
    persisted.sequence !== null &&
    persisted.sequence === observed.sequence,
  );
}

function withEntries(
  state: SessionProjectionState,
  entries: readonly SessionProjectionEntry[],
): SessionProjectionState {
  return { ...state, entries, messages: entries.map((entry) => entry.message) };
}

function insertEntry(
  entries: readonly SessionProjectionEntry[],
  incoming: SessionProjectionEntry,
): SessionProjectionEntry[] {
  const sequence = incoming.identity?.sequence;
  if (sequence !== undefined && sequence !== null) {
    const nextIndex = entries.findIndex((entry) => {
      const candidate = entry.identity?.sequence;
      return candidate !== undefined && candidate !== null && candidate > sequence;
    });
    if (nextIndex >= 0) {
      return [...entries.slice(0, nextIndex), incoming, ...entries.slice(nextIndex)];
    }
  }
  return [...entries, incoming];
}

export function projectLiveSessionMessage(
  state: SessionProjectionState,
  message: unknown,
  envelope?: SessionMessageEnvelope,
  scope: SessionProjectionScope = {},
): SessionProjectionState {
  if (!scopesMatch(state.scope, scope)) {
    return state;
  }
  const incoming = createEntry(message, { envelope, live: true });
  if (!incoming.identity) {
    return state;
  }
  const existingIndex = state.entries.findIndex((entry) => entryMatches(entry, incoming));
  if (existingIndex < 0) {
    return withEntries(state, insertEntry(state.entries, incoming));
  }
  const existing = state.entries[existingIndex];
  if (existing && existing.message === message && existing.live && !existing.pending) {
    return state;
  }
  return withEntries(state, [
    ...state.entries.slice(0, existingIndex),
    incoming,
    ...state.entries.slice(existingIndex + 1),
  ]);
}

/** Only observed live events and this client's pending turns may survive an older snapshot. */
export function reconcileSessionProjectionSnapshot(
  state: SessionProjectionState,
  messages: readonly unknown[],
  scope: SessionProjectionScope = {},
): SessionProjectionState {
  if (!scopesMatch(state.scope, scope)) {
    return createSessionProjection(scope, messages);
  }
  let entries = messages.map((message) => createEntry(message));
  for (const current of state.entries) {
    if (
      (!current.live && !current.pending) ||
      entries.some((entry) => snapshotEntryMatches(entry, current))
    ) {
      continue;
    }
    entries = insertEntry(entries, current);
  }
  return {
    ...withEntries(state, entries),
    scope: { ...state.scope, ...scope },
    hasTransportGap: false,
  };
}

export function getSessionProjectionMessages(state: SessionProjectionState): readonly unknown[] {
  return state.messages;
}

function hasDisplayableSessionMessage(message: unknown): boolean {
  if (typeof message === "string") {
    return message.trim().length > 0;
  }
  const record = readRecord(message);
  if (!record) {
    return false;
  }
  if (typeof record.content === "string" && record.content.trim().length > 0) {
    return true;
  }
  if (Array.isArray(record.content)) {
    const hasDisplayableBlock = record.content.some((block) => {
      const entry = readRecord(block);
      if (!entry) {
        return typeof block === "string" && block.trim().length > 0;
      }
      return entry.type !== "text" || readNonemptyString(entry.text) !== null;
    });
    if (hasDisplayableBlock) {
      return true;
    }
  }
  const media = readRecord(record["__openclaw"])?.media;
  return Array.isArray(media) && media.length > 0;
}

function readSessionProjectionFinalMessageIdentity(message: unknown): string | null {
  if (!hasDisplayableSessionMessage(message)) {
    return null;
  }
  const identity = readSessionMessageIdentity(message);
  if (identity?.externalSource) {
    return `import:${identity.role}:${identity.externalSource}`;
  }
  if (identity?.id && !identity.isImported) {
    return `id:${identity.role}:${identity.id}`;
  }
  if (identity?.sequence !== null && identity?.sequence !== undefined) {
    return `seq:${identity.role}:${identity.sequence}`;
  }
  const record = readRecord(message);
  const metadata = readRecord(record?.["__openclaw"]);
  try {
    return `content:${JSON.stringify([
      identity?.role ?? "assistant",
      typeof message === "string" ? message : (record?.content ?? null),
      metadata?.media ?? null,
      identity?.isImported
        ? [
            metadata?.importedFrom ?? null,
            metadata?.cliSessionId ?? null,
            metadata?.externalId ?? null,
          ]
        : null,
    ])}`;
  } catch {
    return null;
  }
}

/** Replayed finals are recognized against this run's bounded canonical terminal history. */
export function hasSessionProjectionAcceptedFinal(
  run: SessionProjectionRun | undefined,
  message: unknown,
): boolean {
  if (!run) {
    return false;
  }
  const identity = readSessionProjectionFinalMessageIdentity(message);
  if (!identity) {
    return false;
  }
  return (
    run.acceptedFinalMessageIdentities?.includes(identity) === true ||
    readSessionProjectionFinalMessageIdentity(run.message) === identity
  );
}

function retainSessionProjectionRuns(
  runs: Readonly<Record<string, SessionProjectionRun>>,
): Readonly<Record<string, SessionProjectionRun>> {
  const entries = Object.entries(runs);
  if (entries.length <= MAX_TRACKED_SESSION_RUNS) {
    return runs;
  }
  const active = entries.filter(([, run]) => run.status === "streaming");
  const terminal = entries.filter(([, run]) => run.status !== "streaming");
  const terminalLimit = Math.max(0, RETAINED_SESSION_RUNS - active.length);
  const retainedTerminal = terminalLimit > 0 ? terminal.slice(-terminalLimit) : [];
  // Live streams are never expendable; completed runs are retained by completion order.
  return Object.fromEntries([...active, ...retainedTerminal]);
}

function updateRun(
  state: SessionProjectionState,
  incoming: SessionProjectionRun,
): SessionProjectionState {
  const incomingErrorMessage = readNonemptyString(incoming.errorMessage);
  const normalizedIncoming = { ...incoming };
  if (incomingErrorMessage) {
    normalizedIncoming.errorMessage = incomingErrorMessage;
  } else {
    delete normalizedIncoming.errorMessage;
  }
  const current = state.runs[incoming.runId];
  if (current && current.status !== "streaming") {
    const incomingFinalIdentity = readSessionProjectionFinalMessageIdentity(incoming.message);
    const incomingIsFinal = incoming.status === "completed" || incoming.status === "yielded";
    const canRecoverFinal =
      !hasDisplayableSessionMessage(current.message) ||
      (current.acceptedFinalMessageIdentities?.length ?? 0) > 0;
    const acceptFinal =
      incomingIsFinal &&
      (current.status === incoming.status || canRecoverFinal) &&
      incomingFinalIdentity !== null &&
      !hasSessionProjectionAcceptedFinal(current, incoming.message);
    // Distinct valid finals are remembered; the first delivered reply remains immutable.
    const recoverMessage =
      acceptFinal &&
      !hasDisplayableSessionMessage(current.message) &&
      hasDisplayableSessionMessage(incoming.message);
    const recoverError =
      readNonemptyString(current.errorMessage) === null && incomingErrorMessage !== null;
    if (!acceptFinal && !recoverError) {
      return state;
    }
    const firstFinalIdentity = readSessionProjectionFinalMessageIdentity(current.message);
    const previousFinalIdentities =
      current.acceptedFinalMessageIdentities ?? (firstFinalIdentity ? [firstFinalIdentity] : []);
    return {
      ...state,
      runs: {
        ...state.runs,
        [incoming.runId]: {
          ...current,
          ...(recoverMessage ? { message: incoming.message } : {}),
          ...(acceptFinal && incomingFinalIdentity
            ? {
                acceptedFinalMessageIdentities: [
                  ...previousFinalIdentities,
                  incomingFinalIdentity,
                ].slice(-MAX_ACCEPTED_FINAL_MESSAGES_PER_RUN),
              }
            : {}),
          ...(recoverError && incomingErrorMessage
            ? {
                errorMessage: incomingErrorMessage,
                ...(incoming.errorKind ? { errorKind: incoming.errorKind } : {}),
              }
            : {}),
        },
      },
    };
  }
  // Completing a previously active run moves it behind older completed diagnostics.
  const previousRuns =
    current && current.status === "streaming" && incoming.status !== "streaming"
      ? Object.fromEntries(Object.entries(state.runs).filter(([runId]) => runId !== incoming.runId))
      : state.runs;
  const acceptedFinalIdentity =
    incoming.status === "completed" || incoming.status === "yielded"
      ? readSessionProjectionFinalMessageIdentity(incoming.message)
      : null;
  return {
    ...state,
    runs: retainSessionProjectionRuns({
      ...previousRuns,
      [incoming.runId]: {
        ...current,
        ...normalizedIncoming,
        ...(acceptedFinalIdentity
          ? { acceptedFinalMessageIdentities: [acceptedFinalIdentity] }
          : {}),
        ...(incoming.message === undefined && current?.message !== undefined
          ? { message: current.message }
          : {}),
      },
    }),
  };
}

/** Reduces durable events, snapshots, and transport lifecycle without client-specific policy. */
export function reduceSessionProjection(
  state: SessionProjectionState,
  event: SessionProjectionEvent,
): SessionProjectionState {
  const scope = readEventScope(event);
  if (event.type === "snapshotLoaded") {
    // A delayed response cannot switch this reducer back into a reset or abandoned epoch.
    if (!scopesMatch(state.scope, scope)) {
      return state;
    }
    return reconcileSessionProjectionSnapshot(state, event.messages, scope);
  }
  if (event.type === "sessionReset") {
    if (
      !scopesMatch(
        {
          sessionKey: state.scope.sessionKey,
          sessionId: state.scope.sessionId,
          agentId: state.scope.agentId,
        },
        { sessionKey: scope.sessionKey, sessionId: scope.sessionId, agentId: scope.agentId },
      )
    ) {
      return state;
    }
    return createSessionProjection({ ...state.scope, ...scope });
  }
  if (!scopesMatch(state.scope, scope)) {
    return state;
  }
  switch (event.type) {
    case "messagePersisted":
      return projectLiveSessionMessage(state, event.message, event.envelope ?? event, scope);
    case "sendPending": {
      const pendingRunId = normalizeSessionProjectionRunId(event.idempotencyKey ?? event.runId);
      const incoming = createEntry(event.message, { pendingRunId });
      if (!pendingRunId || !incoming.identity) {
        return state;
      }
      const index = state.entries.findIndex((entry) => entryMatches(entry, incoming));
      return index < 0 ? withEntries(state, insertEntry(state.entries, incoming)) : state;
    }
    case "sendAcknowledged": {
      const runId = normalizeSessionProjectionRunId(event.idempotencyKey ?? event.runId);
      if (!runId) {
        return state;
      }
      // An acknowledgement is not persisted transcript evidence; retain the optimistic turn.
      return state;
    }
    case "runDelta":
      return updateRun(state, {
        runId: event.runId,
        status: "streaming",
        ...(event.message === undefined ? {} : { message: event.message }),
      });
    case "runTerminal":
      return updateRun(state, {
        runId: event.runId,
        status: event.status,
        ...(event.message === undefined ? {} : { message: event.message }),
        ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
        ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }),
        ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      });
    case "transportGap":
      return state.hasTransportGap ? state : { ...state, hasTransportGap: true };
    case "reconnected":
      // A successful reconnect cannot clear a known gap before authoritative history arrives.
      return state;
    default:
      return state;
  }
}
