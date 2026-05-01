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

export type SessionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  sessionsExpandedCheckpointKey: string | null;
  sessionsCheckpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  sessionsCheckpointLoadingKey: string | null;
  sessionsCheckpointBusyKey: string | null;
  sessionsCheckpointErrorByKey: Record<string, string>;
};

type LoadSessionsOverrides = {
  activeMinutes?: number;
  limit?: number;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
};

type CreateSessionParams = {
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
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

const SESSION_EVENT_ROW_FIELDS = [
  "abortedLastRun",
  "childSessions",
  "compactionCheckpointCount",
  "contextTokens",
  "displayName",
  "endedAt",
  "elevatedLevel",
  "fastMode",
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
  return value === "direct" || value === "group" || value === "global" || value === "unknown"
    ? value
    : undefined;
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

export function applySessionsChangedEvent(state: SessionsState, payload: unknown): boolean {
  if (!isRecord(payload) || !state.sessionsResult) {
    return false;
  }
  const eventSession = isRecord(payload.session) ? payload.session : null;
  const source = eventSession ?? payload;
  const key =
    (typeof source.key === "string" && source.key.trim()) ||
    (typeof payload.sessionKey === "string" && payload.sessionKey.trim()) ||
    (typeof payload.key === "string" && payload.key.trim()) ||
    "";
  if (!key) {
    return false;
  }

  const previousRows = state.sessionsResult.sessions;
  const existingIndex = previousRows.findIndex((row) => row.key === key);
  const existing = existingIndex >= 0 ? previousRows[existingIndex] : undefined;
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
  if (nextRow.totalTokensFresh === false && !hasOwn(source, "totalTokens")) {
    delete nextRow.totalTokens;
  }

  const sessions =
    existingIndex >= 0
      ? previousRows.map((row, index) => (index === existingIndex ? nextRow : row))
      : [nextRow, ...previousRows];
  const eventTs = typeof payload.ts === "number" && Number.isFinite(payload.ts) ? payload.ts : null;
  state.sessionsResult = {
    ...state.sessionsResult,
    ts: eventTs == null ? state.sessionsResult.ts : Math.max(state.sessionsResult.ts, eventTs),
    count: existingIndex >= 0 ? state.sessionsResult.count : state.sessionsResult.count + 1,
    sessions,
  };

  if (previousCheckpointSignature !== checkpointSummarySignature(nextRow)) {
    invalidateCheckpointCacheForKey(state, key);
  }
  return true;
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
    const activeMinutes = overrides?.activeMinutes ?? toNumber(state.sessionsFilterActive, 0);
    const limit = overrides?.limit ?? toNumber(state.sessionsFilterLimit, 0);
    const params: Record<string, unknown> = {
      includeGlobal,
      includeUnknown,
    };
    if (activeMinutes > 0) {
      params.activeMinutes = activeMinutes;
    }
    if (limit > 0) {
      params.limit = limit;
    }
    const res = await client.request<SessionsListResult | undefined>("sessions.list", params);
    if (res) {
      state.sessionsResult = res;
      const nextKeys = new Set(res.sessions.map((row) => row.key));
      for (const key of Object.keys(state.sessionsCheckpointItemsByKey)) {
        if (!nextKeys.has(key)) {
          invalidateCheckpointCacheForKey(state, key);
        }
      }
      let expandedNeedsRefetch = false;
      for (const row of res.sessions) {
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
    "Create a new child session from this pre-compaction checkpoint?",
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
    "Restore this session to the selected pre-compaction checkpoint?\n\nThis replaces the current active transcript for the session key.",
  );
}
