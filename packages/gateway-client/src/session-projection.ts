/** Browser-safe identity and replay rules shared by Gateway conversation clients. */

import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { reduceSessionProjectionRunEventImpl } from "./session-projection-run-event.js";

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

export type SessionProjectionSnapshotOptions = {
  shouldIncludeMessage?: (message: unknown) => boolean;
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

export type SessionProjectionGatewayRunEvent = {
  state?: unknown;
  yielded?: unknown;
} & Partial<Record<"runId" | "message" | "stopReason" | "errorKind" | "errorMessage", unknown>>;

export type SessionProjectionRunTransition = {
  projection: SessionProjectionState;
  previousRun: SessionProjectionRun | undefined;
  currentRun: SessionProjectionRun | undefined;
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
const SESSION_PROJECTION_SCOPE_KEYS = [
  "sessionKey",
  "sessionId",
  "agentId",
  "lifecycleRevision",
  "activeLeafEntryId",
] as const;

type ScopedSessionProjectionEvent = SessionProjectionScope & { scope?: SessionProjectionScope };

export type SessionProjectionEvent = ScopedSessionProjectionEvent &
  (
    | {
        type: "snapshotLoaded";
        messages: readonly unknown[];
        options?: SessionProjectionSnapshotOptions;
      }
    | ({
        type: "messagePersisted";
        message: unknown;
        envelope?: SessionMessageEnvelope;
      } & SessionMessageEnvelope)
    | { type: "sendPending"; message: unknown; runId?: string; idempotencyKey?: string }
    | {
        type: "sendAcknowledged";
        runId?: string;
        idempotencyKey?: string;
        previousRunId?: string;
      }
    | { type: "sendFailed"; runId: string }
    | { type: "runDelta"; runId: string; message?: unknown }
    | (Omit<SessionProjectionRun, "acceptedFinalMessageIdentities"> & {
        type: "runTerminal";
        status: Exclude<SessionProjectionRunStatus, "streaming">;
      })
    | { type: "sessionReset" }
    | { type: "transportGap" }
    | { type: "reconnected" }
  );

function readNonemptyString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
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

/** Local turns have no durable transcript metadata beyond their own optional send key. */
export function isLocallyOptimisticSessionMessage(message: unknown): boolean {
  const identity = readSessionMessageIdentity(message);
  if (!identity || (identity.role !== "user" && identity.role !== "assistant")) {
    return false;
  }
  const metadata = readRecord(readRecord(message)?.["__openclaw"]);
  return !metadata || Object.keys(metadata).every((key) => key === "idempotencyKey");
}

function createEntry(
  message: unknown,
  options?: { envelope?: SessionMessageEnvelope; live?: boolean; pendingRunId?: string | null },
): SessionProjectionEntry {
  const identity = readSessionMessageIdentity(message, options?.envelope);
  const inferredPendingRunId =
    options?.live !== true && isLocallyOptimisticSessionMessage(message) ? identity?.runId : null;
  const pendingRunId = normalizeSessionProjectionRunId(
    options?.pendingRunId ?? inferredPendingRunId,
  );
  return {
    message,
    identity,
    live: options?.live === true,
    pending: pendingRunId !== null,
    pendingRunId,
  };
}

function createProjectionEntries(messages: readonly unknown[]): SessionProjectionEntry[] {
  let pendingUserRunId: string | null = null;
  return messages.map((message) => {
    const entry = createEntry(message);
    if (entry.identity?.role === "user") {
      pendingUserRunId = entry.pending ? entry.pendingRunId : null;
      return entry;
    }
    if (
      pendingUserRunId &&
      entry.identity?.role === "assistant" &&
      !entry.pending &&
      isLocallyOptimisticSessionMessage(message)
    ) {
      return createEntry(message, { pendingRunId: pendingUserRunId });
    }
    if (!isLocallyOptimisticSessionMessage(message)) {
      pendingUserRunId = null;
    }
    return entry;
  });
}

export function createSessionProjection(
  scope: SessionProjectionScope = {},
  messages: readonly unknown[] = [],
): SessionProjectionState {
  const entries = createProjectionEntries(messages);
  return {
    scope: { ...scope },
    entries,
    messages: entries.map((entry) => entry.message),
    runs: {},
    hasTransportGap: false,
  };
}

function scopesMatch(left: SessionProjectionScope, right: SessionProjectionScope): boolean {
  return SESSION_PROJECTION_SCOPE_KEYS.every(
    (key) => left[key] === undefined || right[key] === undefined || left[key] === right[key],
  );
}

function readEventScope(event: ScopedSessionProjectionEvent): SessionProjectionScope {
  const scope: SessionProjectionScope = { ...event.scope };
  for (const key of SESSION_PROJECTION_SCOPE_KEYS) {
    if (event[key] !== undefined) {
      Object.assign(scope, { [key]: event[key] });
    }
  }
  return scope;
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
  if (left.id || right.id) {
    // A missing durable ID cannot adopt another canonical row by sequence alone.
    return Boolean(left.id && right.id && left.id === right.id);
  }
  // A run can publish several durable messages; its ID identifies ownership, not a row.
  return left.sequence !== null && right.sequence !== null && left.sequence === right.sequence;
}

function entryMatches(
  left: SessionProjectionEntry,
  right: SessionProjectionEntry,
  allowSnapshotPromotion = false,
): boolean {
  if (sameTranscriptIdentity(left.identity, right.identity)) {
    return true;
  }
  const durableEntry = left.identity?.id ? left : right.identity?.id ? right : null;
  const provisionalEntry = durableEntry === left ? right : durableEntry === right ? left : null;
  if (
    durableEntry?.live &&
    provisionalEntry?.live &&
    durableEntry.identity?.role === "assistant" &&
    provisionalEntry.identity?.role === "assistant" &&
    !durableEntry.identity.isImported &&
    !provisionalEntry.identity.isImported &&
    !provisionalEntry.identity.id &&
    durableEntry.identity.runId &&
    durableEntry.identity.runId === provisionalEntry.identity.runId
  ) {
    return true;
  }
  const persisted = left.identity;
  const observed = right.identity;
  if (
    allowSnapshotPromotion &&
    right.live &&
    persisted &&
    observed &&
    persisted.role === observed.role &&
    !persisted.isImported &&
    !observed.isImported &&
    persisted.id &&
    !observed.id &&
    ((persisted.sequence !== null && persisted.sequence === observed.sequence) ||
      (persisted.role === "assistant" &&
        observed.sequence === null &&
        persisted.runId !== null &&
        persisted.runId === observed.runId))
  ) {
    // Only current-scope history can promote an observed native sequence or assistant run.
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
    pending.identity &&
    authoritative.identity &&
    pending.identity.role === authoritative.identity.role &&
    !pending.identity.isImported &&
    !authoritative.identity.isImported &&
    pending.pendingRunId &&
    pending.pendingRunId === authoritative.identity.runId &&
    (pending.identity.sequence === null ||
      authoritative.identity.sequence === null ||
      pending.identity.sequence === authoritative.identity.sequence),
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
  runs?: Readonly<Record<string, SessionProjectionRun>>,
): SessionProjectionEntry[] {
  const sequence = incoming.identity?.sequence;
  let nextIndex =
    sequence === undefined || sequence === null
      ? -1
      : entries.findIndex((entry) => {
          const candidate = entry.identity?.sequence;
          return candidate !== undefined && candidate !== null && candidate > sequence;
        });
  if (nextIndex < 0 && incoming.identity?.role === "user" && incoming.identity.runId) {
    const runId = incoming.identity.runId;
    const terminalMessage = runs?.[runId]?.message;
    nextIndex = entries.findIndex(
      (entry) =>
        entry.identity?.role === "assistant" &&
        (entry.identity.runId === runId || entry.message === terminalMessage),
    );
  }
  return nextIndex < 0
    ? [...entries, incoming]
    : [...entries.slice(0, nextIndex), incoming, ...entries.slice(nextIndex)];
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
    return withEntries(state, insertEntry(state.entries, incoming, state.runs));
  }
  const existing = state.entries[existingIndex];
  if (existing && existing.message === message && existing.live && !existing.pending) {
    return state;
  }
  if (existing && !existing.pending && existing.identity?.id && !incoming.identity.id) {
    // A terminal projection carries no transcript identity; adopting it over the
    // durable row would lose the ID every later snapshot reconciles against.
    return state;
  }
  if (existing?.pending && incoming.identity.sequence !== null) {
    const sequence = incoming.identity.sequence;
    const violatesOrder = state.entries.some(
      ({ identity }, index) =>
        identity?.sequence != null &&
        (index < existingIndex ? identity.sequence > sequence : identity.sequence < sequence),
    );
    return withEntries(
      state,
      violatesOrder
        ? insertEntry(
            state.entries.filter((_, index) => index !== existingIndex),
            incoming,
            state.runs,
          )
        : state.entries.toSpliced(existingIndex, 1, incoming),
    );
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
  options: SessionProjectionSnapshotOptions = {},
): SessionProjectionState {
  const visibleMessages = options.shouldIncludeMessage
    ? messages.filter(options.shouldIncludeMessage)
    : messages;
  if (!scopesMatch(state.scope, scope)) {
    return createSessionProjection(scope, visibleMessages);
  }
  let entries = createProjectionEntries(visibleMessages);
  for (const current of state.entries) {
    if (
      (!current.live && !current.pending) ||
      options.shouldIncludeMessage?.(current.message) === false ||
      entries.filter((entry) => entryMatches(entry, current, true)).length === 1
    ) {
      continue;
    }
    entries = insertEntry(entries, current, state.runs);
  }
  return {
    ...withEntries(state, entries),
    scope: { ...state.scope, ...scope },
    hasTransportGap: false,
  };
}

function hasDisplayableSessionMessage(message: unknown): boolean {
  if (typeof message === "string") {
    return message.trim().length > 0;
  }
  const record = readRecord(message);
  if (!record) {
    return false;
  }
  const displayableBlocks =
    Array.isArray(record.content) &&
    record.content.some((block) => {
      const entry = readRecord(block);
      return entry
        ? entry.type !== "text" || readNonemptyString(entry.text) !== null
        : typeof block === "string" && block.trim().length > 0;
    });
  const media = readRecord(record["__openclaw"])?.media;
  return Boolean(
    (typeof record.content === "string" && record.content.trim()) ||
    displayableBlocks ||
    (Array.isArray(media) && media.length > 0),
  );
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
  const identity = readSessionProjectionFinalMessageIdentity(message);
  return Boolean(
    identity &&
    run &&
    (run.acceptedFinalMessageIdentities?.includes(identity) ||
      readSessionProjectionFinalMessageIdentity(run.message) === identity),
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
    const recoverMessage = acceptFinal && !hasDisplayableSessionMessage(current.message);
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
    return scopesMatch(state.scope, scope)
      ? reconcileSessionProjectionSnapshot(state, event.messages, scope, event.options)
      : state;
  }
  if (event.type === "sessionReset") {
    const { sessionKey, sessionId, agentId } = state.scope;
    return scopesMatch({ sessionKey, sessionId, agentId }, scope)
      ? createSessionProjection({ ...state.scope, ...scope })
      : state;
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
      const seed = state.entries.find((entry) => entry.message === event.message);
      // Explicit send ownership may promote its same native seed. Durable and
      // imported rows stay authoritative so send failure cannot remove them.
      if (
        seed &&
        !seed.pending &&
        incoming.identity.id === null &&
        !incoming.identity.isImported &&
        incoming.identity.runId === pendingRunId
      ) {
        return withEntries(
          state,
          state.entries.map((entry) =>
            entry === seed ? { ...seed, pending: true, pendingRunId } : entry,
          ),
        );
      }
      return seed || state.entries.some((entry) => entryMatches(entry, incoming))
        ? state
        : withEntries(state, insertEntry(state.entries, incoming, state.runs));
    }
    case "sendAcknowledged": {
      const runId = normalizeSessionProjectionRunId(event.idempotencyKey ?? event.runId);
      const previousRunId = normalizeSessionProjectionRunId(event.previousRunId);
      if (!runId || !previousRunId || previousRunId === runId) {
        // An acknowledgement is not transcript evidence; retain pending until persistence.
        return state;
      }
      let changed = false;
      const entries = state.entries.flatMap((entry) => {
        if (!entry.pending || entry.pendingRunId !== previousRunId) {
          return [entry];
        }
        changed = true;
        const rekeyed = { ...entry, pendingRunId: runId };
        return state.entries.some(
          (candidate) => !candidate.pending && entryMatches(rekeyed, candidate),
        )
          ? []
          : [rekeyed];
      });
      return changed ? withEntries(state, entries) : state;
    }
    case "sendFailed": {
      const runId = normalizeSessionProjectionRunId(event.runId);
      const entries = state.entries.filter(
        (entry) => !entry.pending || entry.pendingRunId !== runId,
      );
      return entries.length === state.entries.length ? state : withEntries(state, entries);
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

/** Normalizes Gateway run envelopes once for every browser and terminal adapter. */
export function reduceSessionProjectionRunEvent(
  projection: SessionProjectionState,
  event: SessionProjectionGatewayRunEvent,
  scope: SessionProjectionScope = {},
): SessionProjectionRunTransition | null {
  return reduceSessionProjectionRunEventImpl(projection, event, scope);
}
