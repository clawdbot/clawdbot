import { asNullableRecord as recordOrNull } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as stringValue } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow, SessionRunStatus, SessionsListResult } from "../../api/types.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import {
  compareSessionRowsByUpdatedAt,
  sessionMatchesArchivedFilter,
  type SessionArchivedFilter,
} from "./navigation.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
  type UiSessionDefaultsHost,
} from "./session-key.ts";

export type SessionReconcileOptions = {
  resultAgentId?: string | null;
  selectedGlobalAgentId?: string | null;
  archivedFilter?: SessionArchivedFilter;
};

export type SessionChangedResult = {
  applied: boolean;
  key?: string;
  agentId?: string | null;
  runId?: string | null;
  clientRunId?: string | null;
  hasActiveRun?: boolean | null;
  status?: SessionRunStatus | null;
  isChatTurn?: boolean;
  row?: GatewaySessionRow;
  deletedKey?: string;
  result: SessionsListResult | null;
};

export type SessionRunTerminal = {
  sessionKeys: readonly string[];
  runId?: string | null;
  /** Latest session status after this owned model run leaves the active registry. */
  status: SessionRunStatus;
  endedAt: number;
};

/** Merge canonical and filtered pages with the same cursor/deduplication contract. */
export function appendSessionResults(
  previous: SessionsListResult,
  page: SessionsListResult,
): SessionsListResult {
  const seen = new Set<string>();
  const sessions = [...previous.sessions, ...page.sessions].filter((row) => {
    if (!row.key || seen.has(row.key)) {
      return false;
    }
    seen.add(row.key);
    return true;
  });
  const totalCount = page.totalCount ?? previous.totalCount;
  const hasMore =
    page.hasMore ??
    (typeof totalCount === "number" && Number.isFinite(totalCount)
      ? sessions.length < totalCount
      : false);
  return {
    ...page,
    count: sessions.length,
    totalCount,
    hasMore,
    nextOffset: page.nextOffset ?? (hasMore ? sessions.length : null),
    sessions,
  };
}

type SessionChangedEventInfo = {
  key: string;
  reason: string | null;
  sessionId?: string;
  updatedAt: number | null;
  hasPermissionMode: boolean;
  thinkingLevel?: string | null;
  agentId: string | null;
  runId: string | null;
  clientRunId: string | null;
  hasActiveRun: boolean | null;
  status: SessionRunStatus | null;
  archived: boolean | null;
  isChatTurn: boolean;
};

type ThinkingMetadataCarrier = {
  modelProvider?: string | null;
  model?: string | null;
  agentRuntime?: { id: string } | null;
  thinkingLevels?: Array<{ id: string; label: string }>;
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

function sanitizeSessionRow(row: GatewaySessionRow): GatewaySessionRow {
  const next: Partial<GatewaySessionRow> = {};
  for (const [key, value] of Object.entries(row) as Array<[keyof GatewaySessionRow, unknown]>) {
    if (value === undefined) {
      continue;
    }
    if (key === "totalTokensFresh" && value === false && row.totalTokens === undefined) {
      continue;
    }
    next[key] = value as never;
  }
  return next as GatewaySessionRow;
}

function isPersistedSessionRow(row: GatewaySessionRow): boolean {
  const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
  return Boolean(sessionId || typeof row.updatedAt === "number");
}

function thinkingMetadataIdentityMatches(
  incoming: ThinkingMetadataCarrier,
  existing: ThinkingMetadataCarrier,
): boolean {
  const incomingRuntime = incoming.agentRuntime?.id?.trim();
  const existingRuntime = existing.agentRuntime?.id?.trim();
  // Provider profiles can differ by runtime for the same model (for example Luna Ultra).
  return !(
    (incoming.modelProvider &&
      existing.modelProvider &&
      incoming.modelProvider !== existing.modelProvider) ||
    (incoming.model && existing.model && incoming.model !== existing.model) ||
    (incomingRuntime && existingRuntime && incomingRuntime !== existingRuntime)
  );
}

function preserveRicherThinkingMetadata<T extends ThinkingMetadataCarrier>(
  incoming: T,
  existing: ThinkingMetadataCarrier | undefined,
): T {
  if (existing && !thinkingMetadataIdentityMatches(incoming, existing)) {
    return incoming;
  }
  const existingLevels = existing?.thinkingLevels;
  if (!existingLevels?.length || (incoming.thinkingLevels?.length ?? 0) >= existingLevels.length) {
    return incoming;
  }
  return {
    ...incoming,
    thinkingLevels: existingLevels,
    ...(existing?.thinkingOptions ? { thinkingOptions: existing.thinkingOptions } : {}),
    ...(incoming.thinkingDefault === undefined && existing?.thinkingDefault !== undefined
      ? { thinkingDefault: existing.thinkingDefault }
      : {}),
  };
}

export function preserveRosterPresentationMetadata(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow | undefined,
): GatewaySessionRow {
  if (
    !existing ||
    !incoming.sessionId ||
    incoming.sessionId !== existing.sessionId ||
    (incoming.derivedTitle !== undefined && incoming.lastMessagePreview !== undefined)
  ) {
    return incoming;
  }
  return {
    ...incoming,
    ...(incoming.derivedTitle === undefined && existing.derivedTitle !== undefined
      ? { derivedTitle: existing.derivedTitle }
      : {}),
    ...(incoming.lastMessagePreview === undefined && existing.lastMessagePreview !== undefined
      ? { lastMessagePreview: existing.lastMessagePreview }
      : {}),
  };
}

export function reconcileRosterPresentationMetadata(
  incoming: SessionsListResult | null,
  existing: SessionsListResult | null,
): SessionsListResult | null {
  if (!incoming || !existing) {
    return incoming;
  }
  const existingByKey = new Map(existing.sessions.map((session) => [session.key, session]));
  let changed = false;
  const sessions = incoming.sessions.map((session) => {
    const reconciled = preserveRosterPresentationMetadata(session, existingByKey.get(session.key));
    changed ||= reconciled !== session;
    return reconciled;
  });
  return changed ? { ...incoming, sessions } : incoming;
}

export function preserveCurrentSessionRow(
  result: SessionsListResult,
  state: { result: SessionsListResult | null; agentId: string | null },
  snapshot: UiSessionDefaultsHost & { sessionKey?: string },
  backgroundHydrate: boolean,
): SessionsListResult {
  const currentKey = snapshot.sessionKey?.trim();
  if (!currentKey) {
    return result;
  }
  const parsedAgentId = parseAgentSessionKey(currentKey)?.agentId;
  const currentAgentId = normalizeAgentId(
    parsedAgentId ?? resolveUiSelectedGlobalAgentId(snapshot),
  );
  if (!parsedAgentId && normalizeAgentId(state.agentId ?? "") !== currentAgentId) {
    return result;
  }
  const matchesCurrent = (row: GatewaySessionRow) =>
    uiSessionRowMatchesSelectedChat(snapshot, row.key, currentKey, row.agentId);
  const previousCurrentRow = state.result?.sessions.find(matchesCurrent);
  if (
    previousCurrentRow &&
    (backgroundHydrate || previousCurrentRow.archived === true) &&
    !result.sessions.some(matchesCurrent)
  ) {
    const sessions = [...result.sessions, previousCurrentRow];
    return { ...result, count: sessions.length, sessions };
  }
  return result;
}

function stripThinkingMetadata<T extends ThinkingMetadataCarrier>(value: T): T {
  const next = { ...value };
  delete next.thinkingLevels;
  delete next.thinkingOptions;
  delete next.thinkingDefault;
  return next;
}

/** Same-content merge detection; row values are wire scalars/plain objects, so one level suffices. */
function isShallowEqualSessionRow(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow,
): boolean {
  const incomingKeys = Object.keys(incoming);
  if (incomingKeys.length !== Object.keys(existing).length) {
    return false;
  }
  return incomingKeys.every((key) => {
    const a = (incoming as Record<string, unknown>)[key];
    const b = (existing as Record<string, unknown>)[key];
    return (
      a === b ||
      (a !== null && b !== null && typeof a === "object" && typeof b === "object"
        ? JSON.stringify(a) === JSON.stringify(b)
        : false)
    );
  });
}

function isOlderSessionSnapshot(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow | undefined,
): boolean {
  return (
    typeof incoming.updatedAt === "number" &&
    typeof existing?.updatedAt === "number" &&
    incoming.updatedAt < existing.updatedAt
  );
}

function isStaleForActiveSession(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow | undefined,
): boolean {
  if (!existing || !isSessionRunActive(existing) || isSessionRunActive(incoming)) {
    return false;
  }
  const incomingUpdatedAt = incoming.updatedAt ?? 0;
  return (
    (existing.updatedAt ?? 0) >= incomingUpdatedAt ||
    (typeof existing.startedAt === "number" && existing.startedAt >= incomingUpdatedAt)
  );
}

function matchesExistingSession(
  existing: GatewaySessionRow,
  incoming: GatewaySessionRow,
  selectedGlobalAgentId: string | null,
): boolean {
  if (areUiSessionKeysEquivalent(existing.key, incoming.key)) {
    return true;
  }
  if (!isUiGlobalSessionKey(incoming.key) || existing.kind !== "global") {
    return false;
  }
  const parsed = parseAgentSessionKey(existing.key);
  return (
    parsed?.agentId !== undefined &&
    normalizeAgentId(parsed.agentId) === normalizeAgentId(selectedGlobalAgentId ?? "")
  );
}

function sessionAgentId(
  row: GatewaySessionRow,
  selectedGlobalAgentId: string | null,
): string | null {
  const parsed = parseAgentSessionKey(row.key);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  if (row.kind === "global" && selectedGlobalAgentId?.trim()) {
    return normalizeAgentId(selectedGlobalAgentId);
  }
  return null;
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function sessionRunStatus(value: unknown): SessionRunStatus | null {
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

type ParsedSessionChangedEvent = readonly [
  info: SessionChangedEventInfo,
  event: Record<string, unknown>,
  source: Record<string, unknown>,
  reason: string | null,
];

function parseSessionChangedEvent(payload: unknown): ParsedSessionChangedEvent | null {
  const event = recordOrNull(payload);
  if (!event) {
    return null;
  }
  const source = recordOrNull(event.session) ?? event;
  const key =
    stringValue(recordValue(source, "key")) ?? stringValue(recordValue(event, "sessionKey"));
  if (!key) {
    return null;
  }
  const reason =
    stringValue(recordValue(event, "reason")) ?? stringValue(recordValue(source, "reason")) ?? null;
  const phase =
    stringValue(recordValue(event, "phase")) ?? stringValue(recordValue(source, "phase"));
  const hasActiveRun =
    typeof recordValue(source, "hasActiveRun") === "boolean"
      ? (recordValue(source, "hasActiveRun") as boolean)
      : typeof recordValue(event, "hasActiveRun") === "boolean"
        ? (recordValue(event, "hasActiveRun") as boolean)
        : null;
  const updatedAt = recordValue(source, "updatedAt");
  const thinkingLevel = recordValue(source, "thinkingLevel");
  return [
    {
      key,
      reason,
      sessionId: stringValue(recordValue(source, "sessionId")),
      updatedAt: typeof updatedAt === "number" ? updatedAt : null,
      hasPermissionMode: Object.hasOwn(source, "permissionMode"),
      thinkingLevel:
        typeof thinkingLevel === "string"
          ? thinkingLevel
          : thinkingLevel === null
            ? null
            : undefined,
      agentId: stringValue(recordValue(event, "agentId")) ?? null,
      runId:
        stringValue(recordValue(event, "runId")) ??
        stringValue(recordValue(source, "runId")) ??
        null,
      clientRunId:
        stringValue(recordValue(event, "clientRunId")) ??
        stringValue(recordValue(source, "clientRunId")) ??
        null,
      hasActiveRun,
      status:
        sessionRunStatus(recordValue(source, "status")) ??
        sessionRunStatus(recordValue(event, "status")),
      archived:
        typeof recordValue(source, "archived") === "boolean"
          ? (recordValue(source, "archived") as boolean)
          : null,
      isChatTurn:
        phase === "start" ||
        phase === "message" ||
        phase === "end" ||
        phase === "error" ||
        reason === "send" ||
        reason === "steer",
    },
    event,
    source,
    reason,
  ];
}

export function readSessionChangedEvent(payload: unknown): SessionChangedEventInfo | null {
  return parseSessionChangedEvent(payload)?.[0] ?? null;
}

// Null source confirms inheritance; omission on a lifecycle event preserves selection.
const NULLABLE_SESSION_ROW_FIELDS = new Set<string>([
  "updatedAt",
  "activeLeafEntryId",
  "modelOverrideSource",
]);

export function reconcileSessionChanged(
  result: SessionsListResult | null,
  payload: unknown,
  options: SessionReconcileOptions = {},
): SessionChangedResult {
  const parsed = parseSessionChangedEvent(payload);
  if (!parsed) {
    return { applied: false, result };
  }
  const [info, event, source, reason] = parsed;
  const { key } = info;
  const {
    agentId: _agentId,
    clientRunId: _clientRunId,
    compacted: _compacted,
    key: _key,
    phase: _phase,
    reason: _reason,
    runId: _runId,
    session: _session,
    sessionKey: _sessionKey,
    ts: _ts,
    ...rowFields
  } = source;
  // Ownerless raw global and projection-free legacy aliases only invalidate the
  // canonical roster; optimistic merging could apply a retired private owner's
  // lifecycle event to whichever agent is currently selected.
  if (
    !info.agentId &&
    (isUiGlobalSessionKey(key) || (!parseAgentSessionKey(key) && !Object.keys(rowFields).length))
  ) {
    return { applied: false, key, agentId: null, result };
  }
  // Key-only notifications cannot identify which generation disappeared.
  if (reason === "delete" && !info.sessionId) {
    return { applied: false, key, agentId: info.agentId, result };
  }
  const selectedGlobalAgentId = info.agentId ?? options.selectedGlobalAgentId ?? null;
  const existing = result?.sessions.find((candidate) =>
    matchesExistingSession(
      candidate,
      { key, kind: "global", updatedAt: null },
      selectedGlobalAgentId,
    ),
  );

  if (reason === "delete") {
    if (!result || !existing) {
      return { applied: true, result, key, agentId: info.agentId, deletedKey: key };
    }
    if (existing.sessionId !== info.sessionId) {
      return { applied: false, result, key, agentId: info.agentId };
    }
    const sessions = result.sessions.filter((candidate) => candidate !== existing);
    return {
      applied: true,
      key,
      agentId: info.agentId,
      result: {
        ...result,
        count: sessions.length,
        sessions,
      },
      deletedKey: existing.key,
    };
  }
  if (!result) {
    return { applied: false, result };
  }
  // The gateway wire folds cron/spawn-child into "direct" before projection
  // (session-utils-row.ts, #115299); cron detection is isCronSessionKey.
  const kind =
    rowFields.kind === "direct" ||
    rowFields.kind === "group" ||
    rowFields.kind === "global" ||
    rowFields.kind === "unknown"
      ? rowFields.kind
      : existing?.kind;
  const updatedAt =
    typeof rowFields.updatedAt === "number" ? rowFields.updatedAt : existing?.updatedAt;
  const sessionId = stringValue(rowFields.sessionId) ?? existing?.sessionId;
  if (!kind || (!existing && sessionId === undefined && typeof updatedAt !== "number")) {
    return { applied: false, result };
  }
  const eventResult = {
    applied: true as const,
    key,
    agentId: info.agentId,
    runId: info.runId,
    clientRunId: info.clientRunId,
    hasActiveRun: info.hasActiveRun,
    status: info.status,
    isChatTurn: info.isChatTurn,
  };
  // Events are broadcast independently of sessions.list filters and windows.
  // They may update listed rows, but only a canonical list may admit a new row.
  if (!existing) {
    return { ...eventResult, result };
  }
  const incomingRuntime = recordOrNull(rowFields.agentRuntime);
  const incomingThinkingIdentity: ThinkingMetadataCarrier = {
    modelProvider: stringValue(rowFields.modelProvider),
    model: stringValue(rowFields.model),
    ...(incomingRuntime ? { agentRuntime: { id: stringValue(incomingRuntime.id) ?? "" } } : {}),
  };
  const existingFields = !thinkingMetadataIdentityMatches(incomingThinkingIdentity, existing)
    ? stripThinkingMetadata(existing)
    : existing;
  const row = {
    ...existingFields,
    ...rowFields,
    key: existing.key,
    kind,
    updatedAt: updatedAt ?? null,
    ...(sessionId ? { sessionId } : {}),
  } as GatewaySessionRow;
  // The gateway emits explicit null tombstones so subscribed clients clear
  // fields during merge-reconcile (session-event-payload.ts). Row fields are
  // typed optional-not-null, so every null tombstone deletes — a hand-kept
  // field list here drifts as new tombstoned fields ship (it already had:
  // toolOverrides/observerDigest/controlOwnerSessionKey/restartRecoveryStatus/
  // goal leaked null). Only the fields below are legitimately nullable in the
  // schema, where null is the value itself rather than a clear instruction.
  for (const [field, value] of Object.entries(rowFields)) {
    if (value === null && !NULLABLE_SESSION_ROW_FIELDS.has(field)) {
      delete row[field as keyof GatewaySessionRow];
    }
  }
  const next = reconcileSessionHistory(result, row, undefined, {
    ...options,
    selectedGlobalAgentId,
  });
  if (!next) {
    return { applied: false, result };
  }
  const eventTs = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : null;
  const timestamped = eventTs !== null && eventTs > next.ts ? { ...next, ts: eventTs } : next;
  const previousOwner = existing.owner?.actor;
  const nextOwner = row.owner?.actor;
  const ownershipChanged =
    (Object.hasOwn(rowFields, "owner") || Object.hasOwn(rowFields, "createdActor")) &&
    (previousOwner?.type !== nextOwner?.type ||
      previousOwner?.id !== nextOwner?.id ||
      previousOwner?.label !== nextOwner?.label ||
      existing.owner?.assignedAt !== row.owner?.assignedAt);
  // The facet covers unloaded pages, so an ownership event invalidates it until
  // the session capability's canonical list refresh supplies a complete replacement.
  const reconciledResult = ownershipChanged ? { ...timestamped, owners: undefined } : timestamped;
  const reconciledRow = reconciledResult.sessions.find((candidate) =>
    matchesExistingSession(
      candidate,
      { key, kind: "global", updatedAt: null },
      selectedGlobalAgentId,
    ),
  );
  return {
    ...eventResult,
    row: reconciledRow,
    result: reconciledResult,
  };
}

export function reconcileSessionHistory(
  result: SessionsListResult | null,
  row: GatewaySessionRow | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  options: SessionReconcileOptions = {},
  preserveMatchingExistingRow = false,
): SessionsListResult | null {
  if (!row?.key) {
    return result;
  }
  const session = sanitizeSessionRow(row);
  const archivedFilter = options.archivedFilter ?? "active";
  const selectedGlobalAgentId = options.selectedGlobalAgentId ?? null;
  const resultAgentId = options.resultAgentId?.trim()
    ? normalizeAgentId(options.resultAgentId)
    : null;
  const incomingAgentId = sessionAgentId(session, selectedGlobalAgentId);
  const isOutsideResultScope =
    resultAgentId !== null && incomingAgentId !== null && incomingAgentId !== resultAgentId;
  if (!result) {
    if ((!isPersistedSessionRow(session) || isOutsideResultScope) && !defaults) {
      return null;
    }
    const sessions =
      isPersistedSessionRow(session) &&
      !isOutsideResultScope &&
      sessionMatchesArchivedFilter(session, archivedFilter)
        ? [session]
        : [];
    return {
      ts: Date.now(),
      path: "",
      count: sessions.length,
      defaults: defaults ?? {
        modelProvider: null,
        model: null,
        contextTokens: null,
      },
      sessions,
    };
  }

  const existing = result.sessions.find((candidate) =>
    matchesExistingSession(candidate, session, selectedGlobalAgentId),
  );
  const nextDefaults = defaults
    ? preserveRicherThinkingMetadata(defaults, result.defaults)
    : result.defaults;
  // Lineage and repeated events can supply the current defaults. Preserve
  // result identity when nothing changes so shared subscribers stay quiet.
  const resultWithDefaults =
    nextDefaults === result.defaults ? result : { ...result, defaults: nextDefaults };
  if (preserveMatchingExistingRow && existing) {
    return resultWithDefaults;
  }
  if (isOlderSessionSnapshot(session, existing)) {
    return result;
  }
  if (isOutsideResultScope || (!existing && !isPersistedSessionRow(session))) {
    return resultWithDefaults;
  }
  const visibleKey = existing?.key ?? session.key;
  const visibleSession = preserveRosterPresentationMetadata(
    preserveRicherThinkingMetadata(
      visibleKey === session.key ? session : { ...session, key: visibleKey },
      existing,
    ),
    existing,
  );
  if (isStaleForActiveSession(visibleSession, existing)) {
    return resultWithDefaults;
  }
  if (
    existing &&
    isShallowEqualSessionRow(visibleSession, existing) &&
    sessionMatchesArchivedFilter(visibleSession, archivedFilter)
  ) {
    return resultWithDefaults;
  }
  const sessions = sessionMatchesArchivedFilter(visibleSession, archivedFilter)
    ? [
        ...result.sessions.filter((candidate) => candidate.key !== visibleKey),
        visibleSession,
      ].toSorted(compareSessionRowsByUpdatedAt)
    : result.sessions.filter((candidate) => candidate.key !== visibleKey);
  return {
    ...result,
    defaults: nextDefaults,
    count: sessions.length,
    sessions,
  };
}

export function reconcileSessionRunTerminal(
  result: SessionsListResult | null,
  terminal: SessionRunTerminal,
): SessionsListResult | null {
  const keys = terminal.sessionKeys.map((key) => key.trim()).filter(Boolean);
  if (!result || keys.length === 0) {
    return result;
  }
  const runId = terminal.runId?.trim() || null;
  let changed = false;
  const sessions = result.sessions.map((row): GatewaySessionRow => {
    if (!keys.some((key) => areUiSessionKeysEquivalent(row.key, key))) {
      return row;
    }
    if (row.hasActiveRun === true || isSessionRunActive(row)) {
      // Active identity belongs to the originating model run, not a newer overlap.
      if (!runId || !row.activeRunIds?.includes(runId)) {
        return row;
      }
    }
    const remainingRunIds = runId ? row.activeRunIds?.filter((id) => id !== runId) : [];
    if (remainingRunIds?.length) {
      changed = true;
      return { ...row, activeRunIds: remainingRunIds, hasActiveRun: true, status: "running" };
    }
    const endedAt = row.endedAt ?? terminal.endedAt;
    const runtimeMs =
      typeof row.startedAt === "number" ? Math.max(0, endedAt - row.startedAt) : row.runtimeMs;
    const activeRunIds = row.activeRunIds?.length ? [] : row.activeRunIds;
    const abortedLastRun =
      terminal.status === "killed"
        ? true
        : terminal.status === "running"
          ? false
          : row.abortedLastRun;
    if (
      row.hasActiveRun === false &&
      row.status === terminal.status &&
      row.endedAt === endedAt &&
      row.runtimeMs === runtimeMs &&
      row.activeRunIds === activeRunIds &&
      row.abortedLastRun === abortedLastRun
    ) {
      return row;
    }
    changed = true;
    return {
      ...row,
      activeRunIds,
      hasActiveRun: false,
      status: terminal.status,
      endedAt,
      runtimeMs,
      abortedLastRun,
    };
  });
  return changed ? { ...result, sessions } : result;
}
