import type { GatewaySessionRow, SessionRunStatus, SessionsListResult } from "../../api/types.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import { compareSessionRowsByUpdatedAt } from "./navigation.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "./session-key.ts";

export type SessionReconcileOptions = {
  resultAgentId?: string | null;
  selectedGlobalAgentId?: string | null;
  showArchived?: boolean;
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

type SessionChangedEventInfo = {
  key: string;
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

function stripThinkingMetadata<T extends ThinkingMetadataCarrier>(value: T): T {
  const next = { ...value };
  delete next.thinkingLevels;
  delete next.thinkingOptions;
  delete next.thinkingDefault;
  return next;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

type ParsedSessionChangedEvent = SessionChangedEventInfo & {
  event: Record<string, unknown>;
  source: Record<string, unknown>;
  reason: string | null;
};

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
  return {
    event,
    source,
    key,
    reason,
    agentId: stringValue(recordValue(event, "agentId")) ?? null,
    runId:
      stringValue(recordValue(event, "runId")) ?? stringValue(recordValue(source, "runId")) ?? null,
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
  };
}

export function readSessionChangedEvent(payload: unknown): SessionChangedEventInfo | null {
  const parsed = parseSessionChangedEvent(payload);
  if (!parsed) {
    return null;
  }
  return {
    key: parsed.key,
    agentId: parsed.agentId,
    runId: parsed.runId,
    clientRunId: parsed.clientRunId,
    hasActiveRun: parsed.hasActiveRun,
    status: parsed.status,
    archived: parsed.archived,
    isChatTurn: parsed.isChatTurn,
  };
}

export function reconcileSessionChanged(
  result: SessionsListResult | null,
  payload: unknown,
  options: SessionReconcileOptions = {},
): SessionChangedResult {
  const parsed = parseSessionChangedEvent(payload);
  if (!parsed) {
    return { applied: false, result };
  }
  const { event, source, key, reason } = parsed;
  if (reason === "delete" && !result) {
    return {
      applied: true,
      key,
      agentId: parsed.agentId,
      deletedKey: key,
      result,
    };
  }
  if (!result) {
    return { applied: false, result };
  }
  const selectedGlobalAgentId = parsed.agentId ?? options.selectedGlobalAgentId ?? null;
  const existing = result.sessions.find((candidate) =>
    matchesExistingSession(
      candidate,
      { key, kind: "global", updatedAt: null },
      selectedGlobalAgentId,
    ),
  );

  if (reason === "delete") {
    if (!existing) {
      return { applied: true, result, key, agentId: parsed.agentId, deletedKey: key };
    }
    const sessions = result.sessions.filter((candidate) => candidate !== existing);
    return {
      applied: true,
      key,
      agentId: parsed.agentId,
      result: {
        ...result,
        count: sessions.length,
        sessions,
      },
      deletedKey: existing.key,
    };
  }

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
  const kind =
    rowFields.kind === "cron" ||
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
  const incomingRuntime = recordOrNull(rowFields.agentRuntime);
  const incomingThinkingIdentity: ThinkingMetadataCarrier = {
    modelProvider: stringValue(rowFields.modelProvider),
    model: stringValue(rowFields.model),
    ...(incomingRuntime ? { agentRuntime: { id: stringValue(incomingRuntime.id) ?? "" } } : {}),
  };
  const existingFields =
    existing && !thinkingMetadataIdentityMatches(incomingThinkingIdentity, existing)
      ? stripThinkingMetadata(existing)
      : existing;
  const row = {
    ...existingFields,
    ...rowFields,
    key: existing?.key ?? key,
    kind,
    updatedAt: updatedAt ?? null,
    ...(sessionId ? { sessionId } : {}),
  } as GatewaySessionRow;
  if (rowFields.archivedAt === null) {
    delete row.archivedAt;
  }
  if (rowFields.pinnedAt === null) {
    delete row.pinnedAt;
  }
  if (rowFields.label === null) {
    delete row.label;
  }
  if (rowFields.category === null) {
    delete row.category;
  }
  if (rowFields.displayName === null) {
    delete row.displayName;
  }
  if (rowFields.thinkingLevel === null) {
    delete row.thinkingLevel;
  }
  const next = reconcileSessionHistory(result, row, undefined, {
    ...options,
    selectedGlobalAgentId,
  });
  if (!next) {
    return { applied: false, result };
  }
  const eventTs = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : null;
  const reconciledResult = eventTs === null ? next : { ...next, ts: Math.max(next.ts, eventTs) };
  const reconciledRow = reconciledResult.sessions.find((candidate) =>
    matchesExistingSession(
      candidate,
      { key, kind: "global", updatedAt: null },
      selectedGlobalAgentId,
    ),
  );
  return {
    applied: true,
    key,
    agentId: parsed.agentId,
    runId: parsed.runId,
    clientRunId: parsed.clientRunId,
    hasActiveRun: parsed.hasActiveRun,
    status: parsed.status,
    isChatTurn: parsed.isChatTurn,
    row: reconciledRow,
    result: reconciledResult,
  };
}

export function reconcileSessionHistory(
  result: SessionsListResult | null,
  row: GatewaySessionRow | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  options: SessionReconcileOptions = {},
): SessionsListResult | null {
  if (!row?.key) {
    return result;
  }
  const session = sanitizeSessionRow(row);
  const showArchived = options.showArchived === true;
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
      (session.archived === true) === showArchived
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
  if (isOlderSessionSnapshot(session, existing)) {
    return result;
  }
  const nextDefaults = defaults
    ? preserveRicherThinkingMetadata(defaults, result.defaults)
    : result.defaults;
  if (isOutsideResultScope || (!existing && !isPersistedSessionRow(session))) {
    return defaults ? { ...result, defaults: nextDefaults } : result;
  }
  const visibleKey = existing?.key ?? session.key;
  const visibleSession = preserveRicherThinkingMetadata(
    visibleKey === session.key ? session : { ...session, key: visibleKey },
    existing,
  );
  if (isStaleForActiveSession(visibleSession, existing)) {
    return { ...result, defaults: nextDefaults };
  }
  const sessions =
    (visibleSession.archived === true) === showArchived
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
