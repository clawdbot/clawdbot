import {
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
  type ChatRunUiStatus,
} from "../chat/run-lifecycle.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../gateway.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../session-key.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import type {
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsCompactionBranchResult,
  SessionsCompactionListResult,
  SessionsCompactionRestoreResult,
  SessionsListResult,
} from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

type SessionsChatRunState = {
  sessionKey?: string;
  chatRunId?: string | null;
  chatStream?: string | null;
  chatStreamStartedAt?: number | null;
  requestUpdate?: () => void;
};

export type SessionsState = SessionsChatRunState & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsResultAgentId?: string | null;
  chatAgentSessionRowsByAgent?: Record<string, SessionsListResult["sessions"]>;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  sessionsShowArchived: boolean;
  sessionsExpandedCheckpointKey: string | null;
  sessionsCheckpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  sessionsCheckpointLoadingKey: string | null;
  sessionsCheckpointBusyKey: string | null;
  sessionsCheckpointErrorByKey: Record<string, string>;
  chatSessionMessageSubscriptionKey?: string | null;
  chatSessionMessageSubscriptionRequestedKey?: string | null;
  chatSessionMessageSubscriptionAgentId?: string | null;
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null } | null;
  hello?: GatewayHelloOk | null;
};

export type LoadSessionsOverrides = {
  agentId?: string;
  activeMinutes?: number;
  limit?: number;
  offset?: number;
  search?: string;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  showArchived?: boolean;
  configuredAgentsOnly?: boolean;
  append?: boolean;
  publishChatRunStatus?: boolean;
};

type CreateSessionParams = {
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
  emitCommandHooks?: boolean;
};

type CreateSessionResult = {
  key?: string;
};

type SessionsLoadControl = {
  loading: boolean;
  pending: { overrides?: LoadSessionsOverrides } | null;
  ownsStateLoading: boolean;
};

const sessionsLoadControls = new WeakMap<object, SessionsLoadControl>();
const selectedSessionMessageSubscriptionGenerations = new WeakMap<object, number>();

function hasCurrentChatSession(
  state: SessionsState,
): state is SessionsState & { sessionKey: string } {
  return typeof state.sessionKey === "string" && state.sessionKey.trim() !== "";
}

function normalizeSubscriptionKey(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
}

function resolveSelectedGlobalAliasAgentId(
  state: SessionsState,
  key: string | null | undefined,
): string | null {
  const row = state.sessionsResult?.sessions.find((session) => session.key === key);
  return resolveUiGlobalAliasAgentId(state, key, {
    rowKind: row?.kind,
    requireGlobalRowForMainAlias: true,
  });
}

function resolveSelectedSessionMessageSubscriptionAgentId(
  state: SessionsState,
  key: string,
): string | null {
  if (isUiGlobalSessionKey(key)) {
    return resolveSelectedGlobalAgentId(state);
  }
  return resolveSelectedGlobalAliasAgentId(state, key);
}

function resolveSelectedGlobalAgentId(state: SessionsState): string {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return resolveUiSelectedGlobalAgentId(state);
}

function resolveChatHistorySessionResultAgentId(
  state: SessionsState,
  row: GatewaySessionRow,
): string | null {
  const parsed = parseAgentSessionKey(row.key);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return isUiGlobalSessionKey(row.key) ? resolveSelectedGlobalAgentId(state) : null;
}

function resolveDefaultGlobalAgentId(state: SessionsState): string {
  return resolveUiDefaultAgentId(state);
}

function sessionsChangedGlobalAgentMatches(
  state: SessionsState,
  payload: Record<string, unknown>,
  key: string,
): boolean {
  if (!isUiGlobalSessionKey(key)) {
    return true;
  }
  const eventSession = isRecord(payload.session) ? payload.session : null;
  const eventAgentId = readSessionsChangedEventAgentId(payload, eventSession);
  const selectedAgentId = resolveSelectedGlobalAgentId(state);
  if (eventAgentId) {
    return eventAgentId === selectedAgentId;
  }
  return selectedAgentId === resolveDefaultGlobalAgentId(state);
}

function readSessionsChangedEventAgentId(
  payload: Record<string, unknown>,
  eventSession: Record<string, unknown> | null,
): string | null {
  const rawAgentId =
    (typeof payload.agentId === "string" && payload.agentId.trim()) ||
    (typeof eventSession?.agentId === "string" && eventSession.agentId.trim());
  return rawAgentId ? normalizeAgentId(rawAgentId) : null;
}

function sessionsChangedResultScopeMatches(
  state: SessionsState,
  payload: Record<string, unknown>,
  eventSession: Record<string, unknown> | null,
  key: string,
  existing: GatewaySessionRow | undefined,
): boolean {
  const resultAgentId =
    typeof state.sessionsResultAgentId === "string" && state.sessionsResultAgentId.trim()
      ? normalizeAgentId(state.sessionsResultAgentId)
      : null;
  if (!resultAgentId) {
    return true;
  }
  const eventAgentId = readSessionsChangedEventAgentId(payload, eventSession);
  if (eventAgentId) {
    return eventAgentId === resultAgentId;
  }
  const parsed = parseAgentSessionKey(key);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId) === resultAgentId;
  }
  return Boolean(existing);
}

function buildSelectedSessionMessageSubscriptionParams(state: SessionsState, key: string) {
  const agentId = resolveSelectedSessionMessageSubscriptionAgentId(state, key);
  return {
    key,
    ...(agentId ? { agentId } : {}),
  };
}

function buildSelectedSessionRequestParams(state: SessionsState, key: string) {
  const agentId = resolveSelectedSessionMessageSubscriptionAgentId(state, key);
  return {
    key,
    ...(agentId ? { agentId } : {}),
  };
}

function beginSelectedSessionMessageSubscriptionSync(state: SessionsState): number {
  const key = state as object;
  const next = (selectedSessionMessageSubscriptionGenerations.get(key) ?? 0) + 1;
  selectedSessionMessageSubscriptionGenerations.set(key, next);
  return next;
}

function isCurrentSelectedSessionMessageSubscriptionSync(
  state: SessionsState & { sessionKey: string },
  params: {
    generation: number;
    client: GatewayBrowserClient;
    requestedKey: string;
    requestedAgentId?: string | null;
  },
): boolean {
  return (
    selectedSessionMessageSubscriptionGenerations.get(state as object) === params.generation &&
    state.client === params.client &&
    state.connected &&
    state.sessionKey.trim() === params.requestedKey &&
    resolveSelectedSessionMessageSubscriptionAgentId(state, params.requestedKey) ===
      (params.requestedAgentId ?? null)
  );
}

function readSubscribedSessionMessageKey(result: unknown, fallbackKey: string): string {
  const key =
    result && typeof result === "object" && typeof (result as { key?: unknown }).key === "string"
      ? (result as { key: string }).key.trim()
      : "";
  return key || fallbackKey;
}

async function unsubscribeSelectedSessionMessageBestEffort(
  client: GatewayBrowserClient,
  key: string,
  agentId?: string | null,
): Promise<void> {
  try {
    await client.request("sessions.messages.unsubscribe", {
      key,
      ...(isUiGlobalSessionKey(key) && agentId ? { agentId } : {}),
    });
  } catch {
    // Best-effort cleanup for stale async subscription completions.
  }
}

function sessionPatchTargetsCurrentChatRun(
  state: SessionsState & { sessionKey: string },
  options: { changedSessionKey: string; eventRunId?: string },
): boolean {
  if (state.sessionKey !== options.changedSessionKey) {
    return false;
  }
  if (
    options.eventRunId !== undefined &&
    state.chatRunId &&
    state.chatRunId !== options.eventRunId
  ) {
    return false;
  }
  if (options.eventRunId === undefined && state.chatRunId) {
    return false;
  }
  return true;
}

const SESSION_EVENT_ROW_FIELDS = [
  "abortedLastRun",
  "childSessions",
  "compactionCheckpointCount",
  "contextTokens",
  "displayName",
  "endedAt",
  "elevatedLevel",
  "fastMode",
  "goal",
  "hasActiveRun",
  "inputTokens",
  "kind",
  "label",
  "latestCompactionCheckpoint",
  "model",
  "modelProvider",
  "outputTokens",
  "reasoningLevel",
  "runtimeMs",
  "sessionId",
  "spawnedBy",
  "startedAt",
  "status",
  "archived",
  "subject",
  "surface",
  "systemSent",
  "thinkingDefault",
  "thinkingLevel",
  "thinkingLevels",
  "thinkingOptions",
  "totalTokens",
  "totalTokensFresh",
  "updatedAt",
  "verboseLevel",
] as const satisfies readonly (keyof GatewaySessionRow)[];

function getSessionsLoadControl(state: SessionsState): SessionsLoadControl {
  const key = state as object;
  let control = sessionsLoadControls.get(key);
  if (!control) {
    control = { loading: false, ownsStateLoading: false, pending: null };
    sessionsLoadControls.set(key, control);
  }
  return control;
}

function takePendingSessionsLoad(
  control: SessionsLoadControl,
): { overrides?: LoadSessionsOverrides } | null {
  const pending = control.pending;
  control.pending = null;
  return pending;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function sanitizeChatHistorySessionRow(row: GatewaySessionRow): GatewaySessionRow {
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

export function parseSessionsFilterInteger(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return 0;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function normalizeSessionsFilterOverride(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Number.isSafeInteger(value) ? value : 0;
}

function normalizeSessionKind(value: unknown): GatewaySessionRow["kind"] | undefined {
  return value === "cron" ||
    value === "direct" ||
    value === "group" ||
    value === "global" ||
    value === "unknown"
    ? value
    : undefined;
}

export function isArchivedSessionRow(row: GatewaySessionRow): boolean {
  return row.archived === true;
}

function filterAvailableSessionRows(
  rows: GatewaySessionRow[],
  options: { showArchived: boolean },
): GatewaySessionRow[] {
  return rows.filter((row) => row.key && (options.showArchived || !isArchivedSessionRow(row)));
}

function projectSessionsResultForAvailability(
  result: SessionsListResult,
  options: { showArchived: boolean },
): SessionsListResult {
  const sessions = filterAvailableSessionRows(result.sessions, options);
  return {
    ...result,
    count: sessions.length,
    sessions,
  };
}

function appendSessionsResult(
  previous: SessionsListResult,
  page: SessionsListResult,
): SessionsListResult {
  const seen = new Set<string>();
  const sessions: SessionsListResult["sessions"] = [];
  for (const row of [...previous.sessions, ...page.sessions]) {
    if (!row.key || seen.has(row.key)) {
      continue;
    }
    seen.add(row.key);
    sessions.push(row);
  }
  const totalCount = page.totalCount ?? previous.totalCount;
  const hasMore =
    page.hasMore ??
    (typeof totalCount === "number" && Number.isFinite(totalCount)
      ? sessions.length < totalCount
      : false);
  const nextOffset =
    page.nextOffset !== undefined ? page.nextOffset : hasMore ? sessions.length : null;
  return {
    ...page,
    count: sessions.length,
    totalCount,
    hasMore,
    nextOffset,
    sessions,
  };
}

function compareSessionRowsByUpdatedAt(a: GatewaySessionRow, b: GatewaySessionRow): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

type ThinkingMetadataCarrier = {
  modelProvider?: string | null;
  model?: string | null;
  thinkingLevels?: Array<{ id: string; label: string }>;
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

function thinkingMetadataModelMatches(
  incoming: ThinkingMetadataCarrier,
  existing: ThinkingMetadataCarrier,
): boolean {
  const incomingProvider = incoming.modelProvider;
  const existingProvider = existing.modelProvider;
  if (incomingProvider && existingProvider && incomingProvider !== existingProvider) {
    return false;
  }
  const incomingModel = incoming.model;
  const existingModel = existing.model;
  return !(incomingModel && existingModel && incomingModel !== existingModel);
}

function preserveRicherThinkingMetadata<T extends ThinkingMetadataCarrier>(
  incoming: T,
  existing: ThinkingMetadataCarrier | undefined,
): T {
  if (existing && !thinkingMetadataModelMatches(incoming, existing)) {
    return incoming;
  }
  const existingLevels = existing?.thinkingLevels;
  if (!existingLevels?.length) {
    return incoming;
  }
  const incomingLevels = incoming.thinkingLevels;
  if (incomingLevels && incomingLevels.length >= existingLevels.length) {
    return incoming;
  }
  const existingThinkingDefault = existing?.thinkingDefault;
  return {
    ...incoming,
    thinkingLevels: existingLevels,
    ...(existing?.thinkingOptions ? { thinkingOptions: existing.thinkingOptions } : {}),
    ...(incoming.thinkingDefault === undefined && existingThinkingDefault !== undefined
      ? { thinkingDefault: existingThinkingDefault }
      : {}),
  };
}

function historyRowIsStaleForActiveSession(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow | undefined,
): boolean {
  if (!existing || !isSessionRunActive(existing) || isSessionRunActive(incoming)) {
    return false;
  }
  const existingUpdatedAt = existing.updatedAt ?? 0;
  const incomingUpdatedAt = incoming.updatedAt ?? 0;
  if (existingUpdatedAt >= incomingUpdatedAt) {
    return true;
  }
  const existingStartedAt = typeof existing.startedAt === "number" ? existing.startedAt : 0;
  return existingStartedAt >= incomingUpdatedAt;
}

function isPersistedChatHistorySessionRow(row: GatewaySessionRow): boolean {
  const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
  return Boolean(sessionId || typeof row.updatedAt === "number");
}

function sessionRowMatchesChatHistoryRow(
  state: SessionsState,
  existing: GatewaySessionRow,
  incoming: GatewaySessionRow,
): boolean {
  if (areUiSessionKeysEquivalent(existing.key, incoming.key)) {
    return true;
  }
  return (
    isUiGlobalSessionKey(incoming.key) &&
    resolveSelectedGlobalAliasAgentId(state, existing.key) === resolveSelectedGlobalAgentId(state)
  );
}

function checkpointSummarySignature(
  row:
    | {
        compactionCheckpointCount?: number;
        latestCompactionCheckpoint?: { checkpointId?: string; createdAt?: number } | null;
      }
    | undefined,
): string {
  return `${row?.compactionCheckpointCount ?? 0}:${
    row?.latestCompactionCheckpoint?.checkpointId ?? ""
  }:${row?.latestCompactionCheckpoint?.createdAt ?? 0}`;
}

function invalidateCheckpointCacheForKey(state: SessionsState, key: string) {
  if (
    !(key in state.sessionsCheckpointItemsByKey) &&
    !(key in state.sessionsCheckpointErrorByKey)
  ) {
    return;
  }
  const nextItems = { ...state.sessionsCheckpointItemsByKey };
  const nextErrors = { ...state.sessionsCheckpointErrorByKey };
  delete nextItems[key];
  delete nextErrors[key];
  state.sessionsCheckpointItemsByKey = nextItems;
  state.sessionsCheckpointErrorByKey = nextErrors;
}

function invalidateCachedChatAgentSessionRow(state: SessionsState, key: string): boolean {
  const rowsByAgent = state.chatAgentSessionRowsByAgent;
  if (!rowsByAgent) {
    return false;
  }
  let removed = false;
  for (const [agentId, rows] of Object.entries(rowsByAgent)) {
    const nextRows = rows.filter((row) => row.key !== key);
    if (nextRows.length === rows.length) {
      continue;
    }
    rowsByAgent[agentId] = nextRows;
    removed = true;
  }
  return removed;
}

function resolveCachedChatAgentSessionRowAgentId(
  state: SessionsState,
  row: GatewaySessionRow,
): string | null {
  if (row.kind === "global" || row.kind === "unknown" || row.kind === "cron") {
    return null;
  }
  if (isSubagentSessionKey(row.key) || row.spawnedBy) {
    return null;
  }
  const parsed = parseAgentSessionKey(row.key);
  return normalizeAgentId(parsed?.agentId ?? state.agentsList?.defaultId ?? "main");
}

function upsertCachedChatAgentSessionRow(state: SessionsState, row: GatewaySessionRow): boolean {
  if (!state.sessionsShowArchived && isArchivedSessionRow(row)) {
    return invalidateCachedChatAgentSessionRow(state, row.key);
  }
  const agentId = resolveCachedChatAgentSessionRowAgentId(state, row);
  if (!agentId) {
    return false;
  }
  state.chatAgentSessionRowsByAgent ??= {};
  const existingRows = state.chatAgentSessionRowsByAgent[agentId] ?? [];
  state.chatAgentSessionRowsByAgent[agentId] = [
    row,
    ...existingRows.filter((r) => r.key !== row.key),
  ].toSorted(compareSessionRowsByUpdatedAt);
  return true;
}

async function fetchSessionCompactionCheckpoints(state: SessionsState, key: string) {
  state.sessionsCheckpointLoadingKey = key;
  state.sessionsCheckpointErrorByKey = {
    ...state.sessionsCheckpointErrorByKey,
    [key]: "",
  };
  try {
    const result = await state.client?.request<SessionsCompactionListResult>(
      "sessions.compaction.list",
      buildSelectedSessionRequestParams(state, key),
    );
    if (result) {
      state.sessionsCheckpointItemsByKey = {
        ...state.sessionsCheckpointItemsByKey,
        [key]: result.checkpoints ?? [],
      };
    }
  } catch (err) {
    state.sessionsCheckpointErrorByKey = {
      ...state.sessionsCheckpointErrorByKey,
      [key]: String(err),
    };
  } finally {
    if (state.sessionsCheckpointLoadingKey === key) {
      state.sessionsCheckpointLoadingKey = null;
    }
  }
}

async function withSessionsLoading(
  state: SessionsState,
  run: () => Promise<void>,
): Promise<boolean> {
  if (state.sessionsLoading) {
    return false;
  }
  const control = getSessionsLoadControl(state);
  state.sessionsLoading = true;
  state.sessionsError = null;
  let drainedPendingRefresh = false;
  try {
    await run();
  } finally {
    state.sessionsLoading = false;
    const pending = takePendingSessionsLoad(control);
    if (pending && state.client && state.connected) {
      await loadSessions(state, pending.overrides);
      drainedPendingRefresh = true;
    }
  }
  return drainedPendingRefresh;
}

async function runCompactionMutation<T>(
  state: SessionsState,
  key: string,
  checkpointId: string,
  method: "sessions.compaction.branch" | "sessions.compaction.restore",
  confirmMessage: string,
): Promise<T | null> {
  if (!state.client || !state.connected || !window.confirm(confirmMessage)) {
    return null;
  }
  const client = state.client;
  state.sessionsCheckpointBusyKey = checkpointId;
  try {
    const result = await client.request<T>(method, {
      ...buildSelectedSessionRequestParams(state, key),
      checkpointId,
    });
    await loadSessions(
      state,
      isUiGlobalSessionKey(key) ? { agentId: resolveSelectedGlobalAgentId(state) } : undefined,
    );
    return result;
  } catch (err) {
    state.sessionsError = String(err);
    return null;
  } finally {
    if (state.sessionsCheckpointBusyKey === checkpointId) {
      state.sessionsCheckpointBusyKey = null;
    }
  }
}

export type SessionsChangedApplyResult =
  | { applied: false }
  | {
      applied: true;
      change: "deleted" | "inserted" | "updated";
      clearedChatRun?: boolean;
      clearedChatRunStatus?: Pick<ChatRunUiStatus, "phase" | "runId" | "sessionKey">;
    };

export function applySessionsChangedEvent(
  state: SessionsState,
  payload: unknown,
): SessionsChangedApplyResult {
  if (!isRecord(payload) || !state.sessionsResult) {
    return { applied: false };
  }
  const eventSession = isRecord(payload.session) ? payload.session : null;
  const source = eventSession ?? payload;
  const key =
    (typeof source.key === "string" && source.key.trim()) ||
    (typeof payload.sessionKey === "string" && payload.sessionKey.trim()) ||
    (typeof payload.key === "string" && payload.key.trim()) ||
    "";
  if (!key) {
    return { applied: false };
  }
  if (!sessionsChangedGlobalAgentMatches(state, payload, key)) {
    return { applied: false };
  }

  const previousRows = state.sessionsResult.sessions;
  const existingIndex = previousRows.findIndex((row) => row.key === key);
  const existing = existingIndex >= 0 ? previousRows[existingIndex] : undefined;
  if (payload.reason === "delete") {
    const removedCachedRow = invalidateCachedChatAgentSessionRow(state, key);
    if (
      !sessionsChangedGlobalAgentMatches(state, payload, key) ||
      !sessionsChangedResultScopeMatches(state, payload, eventSession, key, existing)
    ) {
      return removedCachedRow ? { applied: true, change: "deleted" } : { applied: false };
    }
    if (existingIndex < 0) {
      return removedCachedRow ? { applied: true, change: "deleted" } : { applied: false };
    }
    state.sessionsResult = {
      ...state.sessionsResult,
      count: Math.max(0, state.sessionsResult.count - 1),
      sessions: previousRows.filter((row) => row.key !== key),
    };
    invalidateCheckpointCacheForKey(state, key);
    return { applied: true, change: "deleted" };
  }
  const matchesResultScope =
    sessionsChangedGlobalAgentMatches(state, payload, key) &&
    sessionsChangedResultScopeMatches(state, payload, eventSession, key, existing);
  const hasReliableSource =
    existingIndex >= 0 || eventSession !== null || typeof source.sessionId === "string";
  if (!hasReliableSource) {
    return { applied: false };
  }
  const previousCheckpointSignature = checkpointSummarySignature(existing);
  const fallbackKind = normalizeSessionKind(source.kind) ?? existing?.kind ?? "unknown";
  const nextRow: GatewaySessionRow = {
    ...(existing ?? { key, kind: fallbackKind, updatedAt: null }),
    key,
    kind: fallbackKind,
  };
  const mutableNext = nextRow as unknown as Record<string, unknown>;
  for (const field of SESSION_EVENT_ROW_FIELDS) {
    const hasField = hasOwn(source, field);
    const hasTopLevelGoalClear =
      field === "goal" && hasOwn(payload, "goal") && payload.goal === null;
    if (!hasField && !hasTopLevelGoalClear) {
      continue;
    }
    const value = hasTopLevelGoalClear ? null : source[field];
    if (value === undefined || (field === "goal" && value === null)) {
      delete mutableNext[field];
    } else {
      mutableNext[field] = value;
    }
  }
  if (!hasOwn(source, "hasActiveRun") && nextRow.status) {
    if (nextRow.status === "running") {
      if (payload.phase === "start") {
        nextRow.hasActiveRun = true;
      }
    } else {
      nextRow.hasActiveRun = false;
    }
  }
  if (nextRow.totalTokensFresh === false && !hasOwn(source, "totalTokens")) {
    delete nextRow.totalTokens;
  }
  if (!matchesResultScope) {
    return upsertCachedChatAgentSessionRow(state, nextRow)
      ? { applied: true, change: existingIndex >= 0 ? "updated" : "inserted" }
      : { applied: false };
  }
  if (!state.sessionsShowArchived && isArchivedSessionRow(nextRow)) {
    const removedCachedRow = invalidateCachedChatAgentSessionRow(state, key);
    if (existingIndex < 0) {
      return removedCachedRow ? { applied: true, change: "deleted" } : { applied: false };
    }
    state.sessionsResult = {
      ...state.sessionsResult,
      count: Math.max(0, state.sessionsResult.count - 1),
      sessions: previousRows.filter((row) => row.key !== key),
    };
    invalidateCheckpointCacheForKey(state, key);
    return { applied: true, change: "deleted" };
  }

  const nextRows =
    existingIndex >= 0
      ? previousRows.map((row, index) => (index === existingIndex ? nextRow : row))
      : [nextRow, ...previousRows];
  const sessions = nextRows.toSorted(compareSessionRowsByUpdatedAt);
  const eventTs = typeof payload.ts === "number" && Number.isFinite(payload.ts) ? payload.ts : null;
  const eventRunId =
    typeof payload.clientRunId === "string" && payload.clientRunId.trim()
      ? payload.clientRunId.trim()
      : typeof payload.runId === "string" && payload.runId.trim()
        ? payload.runId.trim()
        : undefined;
  state.sessionsResult = {
    ...state.sessionsResult,
    ts: eventTs == null ? state.sessionsResult.ts : Math.max(state.sessionsResult.ts, eventTs),
    count: existingIndex >= 0 ? state.sessionsResult.count : state.sessionsResult.count + 1,
    sessions,
  };
  const hasCurrentSession = hasCurrentChatSession(state);
  const currentChatRunId = state.chatRunId ?? null;
  const currentChatSessionKey = hasCurrentSession ? state.sessionKey : null;
  const clearedChatRun =
    nextRow.hasActiveRun !== true &&
    hasCurrentSession &&
    sessionPatchTargetsCurrentChatRun(state, {
      changedSessionKey: key,
      eventRunId,
    }) &&
    reconcileChatRunFromCurrentSessionRow(state, {
      publishRunStatus: false,
    });

  if (previousCheckpointSignature !== checkpointSummarySignature(nextRow)) {
    invalidateCheckpointCacheForKey(state, key);
  }
  return {
    applied: true,
    change: existingIndex >= 0 ? "updated" : "inserted",
    ...(clearedChatRun ? { clearedChatRun: true } : {}),
    ...(clearedChatRun && currentChatSessionKey != null
      ? {
          clearedChatRunStatus: {
            phase: nextRow.status === "done" ? "done" : "interrupted",
            runId: currentChatRunId,
            sessionKey: currentChatSessionKey,
          },
        }
      : {}),
  };
}

export function applyChatHistorySessionInfo(
  state: SessionsState,
  row: GatewaySessionRow | undefined,
  defaults?: SessionsListResult["defaults"],
): boolean {
  if (!row?.key) {
    return false;
  }
  const session = sanitizeChatHistorySessionRow(row);
  if (!state.sessionsResult) {
    if (!isPersistedChatHistorySessionRow(session)) {
      if (!defaults) {
        return false;
      }
      state.sessionsResult = {
        ts: Date.now(),
        path: "",
        count: 0,
        defaults,
        sessions: [],
      };
      return true;
    }
    const sessions = state.sessionsShowArchived || !isArchivedSessionRow(session) ? [session] : [];
    state.sessionsResult = {
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
    state.sessionsResultAgentId = resolveChatHistorySessionResultAgentId(state, session);
    upsertCachedChatAgentSessionRow(state, session);
    if (hasCurrentChatSession(state)) {
      const reconciled = reconcileChatRunFromSessionRow(state, session, { publishRunStatus: true });
      if (!reconciled) {
        reconcileChatRunFromCurrentSessionRow(state, { publishRunStatus: true });
      }
    }
    return true;
  }
  const existingVisibleSession = state.sessionsResult.sessions.find((existing) =>
    sessionRowMatchesChatHistoryRow(state, existing, session),
  );
  if (!existingVisibleSession && !isPersistedChatHistorySessionRow(session)) {
    if (defaults) {
      state.sessionsResult = {
        ...state.sessionsResult,
        defaults: preserveRicherThinkingMetadata(defaults, state.sessionsResult.defaults),
      };
      return true;
    }
    return false;
  }
  if (defaults) {
    state.sessionsResult = {
      ...state.sessionsResult,
      defaults: preserveRicherThinkingMetadata(defaults, state.sessionsResult.defaults),
    };
  }
  const visibleKey = existingVisibleSession?.key ?? session.key;
  const keyedVisibleSession =
    visibleKey === session.key ? session : { ...session, key: visibleKey };
  const visibleSession = preserveRicherThinkingMetadata(
    keyedVisibleSession,
    existingVisibleSession,
  );
  if (historyRowIsStaleForActiveSession(visibleSession, existingVisibleSession)) {
    return true;
  }
  const applied = applySessionsChangedEvent(state, {
    session: visibleSession,
    sessionKey: visibleSession.key,
    ...(isUiGlobalSessionKey(visibleSession.key)
      ? { agentId: resolveSelectedGlobalAgentId(state) }
      : {}),
  });
  if (applied.applied) {
    upsertCachedChatAgentSessionRow(state, visibleSession);
    if (hasCurrentChatSession(state)) {
      const reconciled = reconcileChatRunFromSessionRow(state, visibleSession, {
        publishRunStatus: true,
      });
      if (!reconciled) {
        reconcileChatRunFromCurrentSessionRow(state, { publishRunStatus: true });
      }
    }
    return true;
  }
  const cached = upsertCachedChatAgentSessionRow(state, visibleSession);
  if (hasCurrentChatSession(state)) {
    const reconciled =
      reconcileChatRunFromSessionRow(state, visibleSession, { publishRunStatus: true }) ||
      (cached && reconcileChatRunFromCurrentSessionRow(state, { publishRunStatus: true }));
    return cached || reconciled;
  }
  return cached;
}

export async function subscribeSessions(state: SessionsState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    await state.client.request("sessions.subscribe", {});
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export async function syncSelectedSessionMessageSubscription(
  state: SessionsState & { sessionKey: string },
  opts?: { force?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const nextKey = state.sessionKey.trim();
  if (!nextKey) {
    return;
  }
  const generation = beginSelectedSessionMessageSubscriptionSync(state);
  const previousRequestedKey = normalizeSubscriptionKey(
    state.chatSessionMessageSubscriptionRequestedKey,
  );
  const previousCanonicalKey = normalizeSubscriptionKey(state.chatSessionMessageSubscriptionKey);
  const previousSelectedKey = previousRequestedKey ?? previousCanonicalKey;
  const nextSubscriptionAgentId = resolveSelectedSessionMessageSubscriptionAgentId(state, nextKey);
  const selectedAgentChanged =
    nextSubscriptionAgentId !== null &&
    previousSelectedKey === nextKey &&
    (state.chatSessionMessageSubscriptionAgentId ?? null) !== nextSubscriptionAgentId;
  const selectedKeyChanged = previousSelectedKey !== null && previousSelectedKey !== nextKey;
  const shouldUnsubscribePrevious =
    previousCanonicalKey !== null && (selectedKeyChanged || selectedAgentChanged);
  const shouldSubscribe =
    opts?.force === true ||
    selectedKeyChanged ||
    selectedAgentChanged ||
    previousCanonicalKey === null ||
    previousRequestedKey === null;
  if (!shouldUnsubscribePrevious && !shouldSubscribe) {
    return;
  }
  const isCurrent = () =>
    isCurrentSelectedSessionMessageSubscriptionSync(state, {
      generation,
      client,
      requestedKey: nextKey,
      requestedAgentId: nextSubscriptionAgentId,
    });
  try {
    if (shouldUnsubscribePrevious && previousCanonicalKey) {
      await client.request("sessions.messages.unsubscribe", {
        key: previousCanonicalKey,
        ...(isUiGlobalSessionKey(previousCanonicalKey) &&
        state.chatSessionMessageSubscriptionAgentId
          ? { agentId: state.chatSessionMessageSubscriptionAgentId }
          : {}),
      });
      if (isCurrent()) {
        state.chatSessionMessageSubscriptionKey = null;
        state.chatSessionMessageSubscriptionRequestedKey = null;
        state.chatSessionMessageSubscriptionAgentId = null;
      }
    }
    if (!shouldSubscribe || !isCurrent()) {
      return;
    }
    const subscriptionParams = buildSelectedSessionMessageSubscriptionParams(state, nextKey);
    const result = await client.request("sessions.messages.subscribe", subscriptionParams);
    const subscribedKey = readSubscribedSessionMessageKey(result, nextKey);
    const subscribedAgentId = "agentId" in subscriptionParams ? subscriptionParams.agentId : null;
    if (!isCurrent()) {
      const staleKeyChanged =
        normalizeSubscriptionKey(state.chatSessionMessageSubscriptionKey) !== subscribedKey;
      const staleAgentChanged =
        isUiGlobalSessionKey(subscribedKey) &&
        (state.chatSessionMessageSubscriptionAgentId ?? null) !== subscribedAgentId;
      if (staleKeyChanged || staleAgentChanged) {
        await unsubscribeSelectedSessionMessageBestEffort(client, subscribedKey, subscribedAgentId);
      }
      return;
    }
    state.chatSessionMessageSubscriptionRequestedKey = nextKey;
    state.chatSessionMessageSubscriptionKey = subscribedKey;
    state.chatSessionMessageSubscriptionAgentId = subscribedAgentId;
  } catch (err) {
    if (isCurrent()) {
      state.sessionsError = String(err);
    }
  }
}

export async function loadSessions(state: SessionsState, overrides?: LoadSessionsOverrides) {
  if (!state.client || !state.connected) {
    return;
  }
  const control = getSessionsLoadControl(state);
  if (control.loading) {
    control.pending = { overrides };
    return;
  }
  if (state.sessionsLoading) {
    control.pending = { overrides };
    return;
  }
  const client = state.client;
  control.loading = true;
  control.ownsStateLoading = true;
  state.sessionsLoading = true;
  state.sessionsError = null;
  let currentOverrides: LoadSessionsOverrides | undefined = overrides;
  try {
    for (;;) {
      control.pending = null;
      await loadSessionsOnce(state, client, currentOverrides);
      const pending = takePendingSessionsLoad(control);
      if (!pending || !state.client || !state.connected) {
        break;
      }
      currentOverrides = pending.overrides;
    }
  } finally {
    control.loading = false;
    control.pending = null;
    if (control.ownsStateLoading) {
      state.sessionsLoading = false;
      control.ownsStateLoading = false;
    }
  }
}

async function loadSessionsOnce(
  state: SessionsState,
  client: NonNullable<SessionsState["client"]>,
  overrides?: LoadSessionsOverrides,
) {
  await (async () => {
    const previousRows = new Map(
      (state.sessionsResult?.sessions ?? []).map((row) => [row.key, row] as const),
    );
    const includeGlobal = overrides?.includeGlobal ?? state.sessionsIncludeGlobal;
    const includeUnknown = overrides?.includeUnknown ?? state.sessionsIncludeUnknown;
    const showArchived = overrides?.showArchived ?? state.sessionsShowArchived;
    const activeMinutes = showArchived
      ? 0
      : (normalizeSessionsFilterOverride(overrides?.activeMinutes) ??
        parseSessionsFilterInteger(state.sessionsFilterActive));
    const limit =
      normalizeSessionsFilterOverride(overrides?.limit) ??
      parseSessionsFilterInteger(state.sessionsFilterLimit);
    const configuredAgentsOnly = overrides?.configuredAgentsOnly ?? true;
    const params: Record<string, unknown> = {
      includeGlobal,
      includeUnknown,
      configuredAgentsOnly,
    };
    const agentId = overrides?.agentId?.trim();
    const resultAgentId = agentId ? normalizeAgentId(agentId) : null;
    if (agentId) {
      params.agentId = agentId;
    }
    if (activeMinutes > 0) {
      params.activeMinutes = activeMinutes;
    }
    if (limit > 0) {
      params.limit = limit;
    }
    const offset =
      typeof overrides?.offset === "number" && Number.isFinite(overrides.offset)
        ? Math.max(0, Math.floor(overrides.offset))
        : 0;
    if (offset > 0) {
      params.offset = offset;
    }
    const search = overrides?.search?.trim();
    if (search) {
      params.search = search;
    }
    const res = await client.request<SessionsListResult | undefined>("sessions.list", params);
    if (res) {
      const projected = projectSessionsResultForAvailability(res, { showArchived });
      state.sessionsResult =
        overrides?.append === true && offset > 0 && state.sessionsResult
          ? appendSessionsResult(state.sessionsResult, projected)
          : projected;
      state.sessionsResultAgentId = resultAgentId;
      if (hasCurrentChatSession(state)) {
        reconcileChatRunFromCurrentSessionRow(state, {
          publishRunStatus: overrides?.publishChatRunStatus !== false,
        });
      }
      const nextKeys = new Set(state.sessionsResult.sessions.map((row) => row.key));
      for (const key of Object.keys(state.sessionsCheckpointItemsByKey)) {
        if (!nextKeys.has(key)) {
          invalidateCheckpointCacheForKey(state, key);
        }
      }
      let expandedNeedsRefetch = false;
      for (const row of state.sessionsResult.sessions) {
        const previous = previousRows.get(row.key);
        if (checkpointSummarySignature(previous) !== checkpointSummarySignature(row)) {
          invalidateCheckpointCacheForKey(state, row.key);
          if (state.sessionsExpandedCheckpointKey === row.key) {
            expandedNeedsRefetch = true;
          }
        }
      }
      const expandedKey = state.sessionsExpandedCheckpointKey;
      if (
        expandedKey &&
        nextKeys.has(expandedKey) &&
        (expandedNeedsRefetch || !state.sessionsCheckpointItemsByKey[expandedKey])
      ) {
        await fetchSessionCompactionCheckpoints(state, expandedKey);
      }
    }
  })().catch((err: unknown) => {
    if (!isMissingOperatorReadScopeError(err)) {
      state.sessionsError = String(err);
      return;
    }
    state.sessionsResult = null;
    state.sessionsError = formatMissingOperatorReadScopeMessage("sessions");
  });
}

export async function patchSession(
  state: SessionsState,
  key: string,
  patch: {
    label?: string | null;
    thinkingLevel?: string | null;
    fastMode?: boolean | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const params: Record<string, unknown> = {
    key,
    ...(isUiGlobalSessionKey(key) ? { agentId: resolveSelectedGlobalAgentId(state) } : {}),
  };
  for (const field of [
    "label",
    "thinkingLevel",
    "fastMode",
    "verboseLevel",
    "reasoningLevel",
  ] as const) {
    if (field in patch) {
      params[field] = patch[field];
    }
  }
  try {
    await state.client.request("sessions.patch", params);
    await loadSessions(
      state,
      isUiGlobalSessionKey(key) ? { agentId: resolveSelectedGlobalAgentId(state) } : undefined,
    );
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export async function createSessionAndRefresh(
  state: SessionsState,
  params: CreateSessionParams = {},
  refreshOverrides?: LoadSessionsOverrides,
): Promise<string | null> {
  if (!state.client || !state.connected || state.sessionsLoading) {
    return null;
  }
  const client = state.client;
  let createdKey: string | null = null;
  try {
    await withSessionsLoading(state, async () => {
      const result = await client.request<CreateSessionResult>("sessions.create", params);
      const key = typeof result?.key === "string" ? result.key.trim() : "";
      if (!key) {
        throw new Error("sessions.create returned no key");
      }
      createdKey = key;
      await loadSessions(state, refreshOverrides);
    });
  } catch (err) {
    state.sessionsError = String(err);
    return null;
  }
  return createdKey;
}

export async function deleteSessionsAndRefresh(
  state: SessionsState,
  keys: string[],
): Promise<string[]> {
  if (!state.client || !state.connected || keys.length === 0) {
    return [];
  }
  const client = state.client;
  if (state.sessionsLoading) {
    return [];
  }
  const confirmed = window.confirm(
    `Delete ${keys.length} ${keys.length === 1 ? "session" : "sessions"}?\n\nThis will delete the session entries and archive their transcripts.`,
  );
  if (!confirmed) {
    return [];
  }
  const deleted: string[] = [];
  const deleteErrors: string[] = [];
  const refreshedDuringDelete = await withSessionsLoading(state, async () => {
    for (const key of keys) {
      try {
        await client.request("sessions.delete", {
          key,
          ...(isUiGlobalSessionKey(key) ? { agentId: resolveSelectedGlobalAgentId(state) } : {}),
          deleteTranscript: true,
        });
        deleted.push(key);
      } catch (err) {
        deleteErrors.push(String(err));
      }
    }
  });
  if (deleted.length > 0 && !refreshedDuringDelete) {
    const selectedGlobalDeleted = deleted.some((key) => isUiGlobalSessionKey(key));
    await loadSessions(
      state,
      selectedGlobalDeleted ? { agentId: resolveSelectedGlobalAgentId(state) } : undefined,
    );
  }
  if (deleteErrors.length > 0) {
    state.sessionsError = deleteErrors.join("; ");
  }
  return deleted;
}

export async function toggleSessionCompactionCheckpoints(state: SessionsState, key: string) {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    return;
  }
  if (state.sessionsExpandedCheckpointKey === trimmedKey) {
    state.sessionsExpandedCheckpointKey = null;
    return;
  }
  state.sessionsExpandedCheckpointKey = trimmedKey;
  if (state.sessionsCheckpointItemsByKey[trimmedKey]) {
    return;
  }
  await fetchSessionCompactionCheckpoints(state, trimmedKey);
}

export async function branchSessionFromCheckpoint(
  state: SessionsState,
  key: string,
  checkpointId: string,
): Promise<string | null> {
  const result = await runCompactionMutation<SessionsCompactionBranchResult>(
    state,
    key,
    checkpointId,
    "sessions.compaction.branch",
    "Create a new child session from this compacted checkpoint?",
  );
  return result?.key ?? null;
}

export async function restoreSessionFromCheckpoint(
  state: SessionsState,
  key: string,
  checkpointId: string,
) {
  await runCompactionMutation<SessionsCompactionRestoreResult>(
    state,
    key,
    checkpointId,
    "sessions.compaction.restore",
    "Restore this session to the selected compacted checkpoint?\n\nThis replaces the current active transcript for the session key.",
  );
}
