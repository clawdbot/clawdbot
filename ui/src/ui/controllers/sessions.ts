import {
  reconcileChatRunFromCurrentSessionRow,
  type ChatRunUiStatus,
} from "../chat/run-lifecycle.ts";
import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
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

function beginSelectedSessionMessageSubscriptionSync(state: SessionsState): number {
  const key = state as object;
  const next = (selectedSessionMessageSubscriptionGenerations.get(key) ?? 0) + 1;
  selectedSessionMessageSubscriptionGenerations.set(key, next);
  return next;
}

function isCurrentSelectedSessionMessageSubscriptionSync(
  state: SessionsState & { sessionKey: string },
  params: { generation: number; client: GatewayBrowserClient; requestedKey: string },
): boolean {
  return (
    selectedSessionMessageSubscriptionGenerations.get(state as object) === params.generation &&
    state.client === params.client &&
    state.connected &&
    state.sessionKey.trim() === params.requestedKey
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
): Promise<void> {
  try {
    await client.request("sessions.messages.unsubscribe", { key });
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
  return Object.prototype.hasOwnProperty.call(record, key);
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

async function fetchSessionCompactionCheckpoints(state: SessionsState, key: string) {
  state.sessionsCheckpointLoadingKey = key;
  state.sessionsCheckpointErrorByKey = {
    ...state.sessionsCheckpointErrorByKey,
    [key]: "",
  };
  try {
    const result = await state.client?.request<SessionsCompactionListResult>(
      "sessions.compaction.list",
      { key },
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
    const result = await client.request<T>(method, { key, checkpointId });
    await loadSessions(state);
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

  const previousRows = state.sessionsResult.sessions;
  const existingIndex = previousRows.findIndex((row) => row.key === key);
  if (payload.reason === "delete") {
    if (existingIndex < 0) {
      return { applied: false };
    }
    state.sessionsResult = {
      ...state.sessionsResult,
      count: Math.max(0, state.sessionsResult.count - 1),
      sessions: previousRows.filter((row) => row.key !== key),
    };
    invalidateCheckpointCacheForKey(state, key);
    return { applied: true, change: "deleted" };
  }
  const existing = existingIndex >= 0 ? previousRows[existingIndex] : undefined;
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
    if (!hasOwn(source, field)) {
      continue;
    }
    const value = source[field];
    if (value === undefined) {
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
  if (!state.sessionsShowArchived && isArchivedSessionRow(nextRow)) {
    if (existingIndex < 0) {
      return { applied: false };
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
  const selectedKeyChanged = previousSelectedKey !== null && previousSelectedKey !== nextKey;
  const shouldUnsubscribePrevious = previousCanonicalKey !== null && selectedKeyChanged;
  const shouldSubscribe =
    opts?.force === true ||
    selectedKeyChanged ||
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
    });
  try {
    if (shouldUnsubscribePrevious && previousCanonicalKey) {
      await client.request("sessions.messages.unsubscribe", { key: previousCanonicalKey });
      if (isCurrent()) {
        state.chatSessionMessageSubscriptionKey = null;
        state.chatSessionMessageSubscriptionRequestedKey = null;
      }
    }
    if (!shouldSubscribe || !isCurrent()) {
      return;
    }
    const result = await client.request("sessions.messages.subscribe", { key: nextKey });
    const subscribedKey = readSubscribedSessionMessageKey(result, nextKey);
    if (!isCurrent()) {
      if (normalizeSubscriptionKey(state.chatSessionMessageSubscriptionKey) !== subscribedKey) {
        await unsubscribeSelectedSessionMessageBestEffort(client, subscribedKey);
      }
      return;
    }
    state.chatSessionMessageSubscriptionRequestedKey = nextKey;
    state.chatSessionMessageSubscriptionKey = subscribedKey;
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
      : (overrides?.activeMinutes ?? toNumber(state.sessionsFilterActive, 0));
    const limit = overrides?.limit ?? toNumber(state.sessionsFilterLimit, 0);
    const configuredAgentsOnly = overrides?.configuredAgentsOnly ?? true;
    const params: Record<string, unknown> = {
      includeGlobal,
      includeUnknown,
      configuredAgentsOnly,
    };
    const agentId = overrides?.agentId?.trim();
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
  const params: Record<string, unknown> = { key };
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
    await loadSessions(state);
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
        await client.request("sessions.delete", { key, deleteTranscript: true });
        deleted.push(key);
      } catch (err) {
        deleteErrors.push(String(err));
      }
    }
  });
  if (deleted.length > 0 && !refreshedDuringDelete) {
    await loadSessions(state);
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
