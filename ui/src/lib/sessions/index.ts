import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type {
  FastMode,
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionRunStatus,
  SessionsCompactionBranchResult,
  SessionsCompactionListResult,
  SessionsCompactionRestoreResult,
  SessionsListResult,
  SessionsPatchResult,
  SessionWorkspaceGetResult,
  SessionWorkspaceListResult,
  SessionWorkspaceSetResult,
} from "../../api/types.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import {
  requestSessionCreate,
  resolveSessionCreateParams,
  type SessionCreateOutcome,
  type SessionCreateParams,
} from "./create.ts";
import { scopedAgentListParamsForSession } from "./navigation.ts";
import {
  readSessionChangedEvent,
  reconcileSessionChanged,
  reconcileSessionHistory,
  type SessionChangedResult,
  type SessionReconcileOptions,
} from "./reconcile.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
} from "./session-key.ts";
export {
  buildSessionUsageDateParams,
  requestSessionUsage,
  requestSessionUsageLogs,
  requestSessionUsageTimeSeries,
  requestSessionsUsage,
} from "./usage.ts";
export type { SessionUsageQuery } from "./usage.ts";

export type SessionState = {
  result: SessionsListResult | null;
  agentId: string | null;
  modelOverrides: Readonly<Record<string, string | null>>;
  loading: boolean;
  error: string | null;
  deletedSessions: readonly SessionDeleteTarget[];
  /** Gateway-owned custom group catalog in display order. */
  groups: readonly string[];
};

export type SessionListOptions = {
  agentId?: string;
  activeMinutes?: number;
  search?: string;
  offset?: number;
  limit?: number;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  configuredAgentsOnly?: boolean;
  showArchived?: boolean;
  append?: boolean;
};

type SessionRefreshOptions = SessionListOptions & {
  force?: boolean;
  // Sidebar startup hydration must not block session creation or drop the open session.
  backgroundHydrate?: boolean;
};

export type SessionRunTerminal = {
  sessionKeys: readonly string[];
  runId?: string | null;
  status: Exclude<SessionRunStatus, "running">;
  endedAt: number;
};

export type SessionPatch = {
  label?: string | null;
  category?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  fastMode?: FastMode | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
  archived?: boolean;
  pinned?: boolean;
  unread?: boolean;
};

type SessionDeleteOptions = {
  agentId?: string;
  deleteTranscript?: boolean;
};

type SessionDeleteTarget = {
  key: string;
  agentId?: string;
  deleteTranscript?: boolean;
};

/** Dirty/unpushed checkouts survive session deletion; callers surface them. */
export type SessionDeleteOutcome = {
  deleted: boolean;
  worktreePreserved?: { id: string; branch: string; path: string };
};

type SessionDeleteBatchResult = {
  deleted: string[];
  errors: string[];
  /** Dirty/unpushed checkouts kept by the gateway during this batch. */
  preservedWorktrees: Array<{ id: string; branch: string; path: string }>;
};

type SessionCompactResult = {
  ok?: boolean;
  compacted?: boolean;
  reason?: string;
  result?: { tokensBefore?: number; tokensAfter?: number };
};

type SessionSteerResult = {
  runId?: string;
  status?: unknown;
};

export type SessionResetOptions = {
  agentId?: string | null;
};

export type SessionResetResult = "completed" | "not-started" | "uncertain";

type SessionGateway = {
  readonly snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
    hello: GatewayHelloOk | null;
    assistantAgentId?: string | null;
    sessionKey?: string;
  };
  subscribe: (listener: (snapshot: SessionGateway["snapshot"]) => void) => () => void;
  subscribeEvents: (listener: (event: GatewayEventFrame) => void) => () => void;
};

type SessionRequestClient = Pick<GatewayBrowserClient, "request">;

type SessionConnectionScope = {
  client: GatewayBrowserClient;
  epoch: number;
};

type SessionMessageSubscription = {
  key: string;
  agentId?: string | null;
};

export type SessionCapability = {
  readonly state: SessionState;
  /** Advances only when a canonical sessions.list response is published. */
  readonly canonicalListRevision: number;
  list: (options?: SessionListOptions) => Promise<SessionsListResult | null>;
  reconcile: (
    row: GatewaySessionRow | undefined,
    defaults?: SessionsListResult["defaults"],
    options?: SessionReconcileOptions,
  ) => boolean;
  reconcileChanged: (payload: unknown, options?: SessionReconcileOptions) => SessionChangedResult;
  reconcileRunTerminal: (terminal: SessionRunTerminal) => boolean;
  refresh: (options?: SessionRefreshOptions) => Promise<void>;
  createResult: (params?: SessionCreateParams) => Promise<SessionCreateOutcome | null>;
  create: (params?: SessionCreateParams) => Promise<string | null>;
  patch: (
    key: string,
    patch: SessionPatch,
    options?: { agentId?: string },
  ) => Promise<SessionsPatchResult | null>;
  setModelOverride: (key: string, value: string | null | undefined) => void;
  delete: (key: string, options?: SessionDeleteOptions) => Promise<SessionDeleteOutcome>;
  deleteMany: (targets: readonly SessionDeleteTarget[]) => Promise<SessionDeleteBatchResult>;
  reset: (key: string, options?: SessionResetOptions) => Promise<SessionResetResult>;
  compact: (key: string, options?: { agentId?: string | null }) => Promise<SessionCompactResult>;
  steer: (
    key: string,
    message: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionSteerResult>;
  listFiles: (
    key: string,
    options?: { agentId?: string | null; path?: string; search?: string },
  ) => Promise<SessionWorkspaceListResult | null>;
  getFile: (
    key: string,
    path: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionWorkspaceGetResult | null>;
  setFile: (
    key: string,
    path: string,
    content: string,
    options: { agentId?: string | null; expectedHash: string },
  ) => Promise<SessionWorkspaceSetResult | null>;
  subscribeMessages: (
    key: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionMessageSubscription>;
  unsubscribeMessages: (subscription: SessionMessageSubscription) => Promise<void>;
  listCheckpoints: (
    key: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionCompactionCheckpoint[]>;
  branchCheckpoint: (
    key: string,
    checkpointId: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionsCompactionBranchResult>;
  restoreCheckpoint: (
    key: string,
    checkpointId: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionsCompactionRestoreResult>;
  /** Loads the gateway-owned group catalog once per connection. */
  groupsLoad: () => Promise<void>;
  /** Replaces the gateway-owned group catalog (order included). */
  groupsPut: (names: readonly string[]) => Promise<void>;
  /** Renames a group; the gateway repoints member sessions server-side. */
  groupsRename: (from: string, to: string) => Promise<void>;
  /** Deletes a group; the gateway clears member categories server-side. */
  groupsDelete: (name: string) => Promise<void>;
  subscribeCreated: (listener: (key: string) => void) => () => void;
  subscribe: (listener: (state: SessionState) => void) => () => void;
  dispose: () => void;
};

export { requestSessionCreate } from "./create.ts";
export type { SessionCreateOutcome, SessionCreateParams } from "./create.ts";
export { resolveSessionKey } from "./navigation.ts";
export {
  compareSessionRowsByUpdatedAt,
  filterSessionRows,
  filterVisibleSessionRows,
  getVisibleSessionRows,
  resolveSessionNavigation,
  scopedAgentIdForSession,
  scopedAgentListParamsForRefreshTarget,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
  searchForSession,
  visibleSessionMatches,
} from "./navigation.ts";
export { reconcileSessionHistory } from "./reconcile.ts";
export type { SessionChangedResult, SessionReconcileOptions } from "./reconcile.ts";
export type {
  SessionNavigation,
  SessionNavigationInput,
  SessionRefreshTarget,
  SessionScopeHost,
  SessionScopeHostWithKey,
} from "./navigation.ts";

const SESSION_LIST_PARAMS = {
  includeGlobal: true,
  includeUnknown: true,
  configuredAgentsOnly: true,
} as const;

function buildSessionRequestParams(
  key: string,
  agentId?: string | null,
): { key: string; agentId?: string } {
  const normalizedKey = key.trim();
  const normalizedAgentId = agentId?.trim();
  return {
    key: normalizedKey,
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
  };
}

function buildSessionListParams(options: SessionListOptions = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    ...SESSION_LIST_PARAMS,
  };
  if (options.limit === undefined) {
    params.limit = 50;
  } else if (options.limit > 0) {
    params.limit = Math.floor(options.limit);
  }
  if (options.includeGlobal !== undefined) {
    params.includeGlobal = options.includeGlobal;
  }
  if (options.includeUnknown !== undefined) {
    params.includeUnknown = options.includeUnknown;
  }
  if (options.configuredAgentsOnly !== undefined) {
    params.configuredAgentsOnly = options.configuredAgentsOnly;
  }
  if (options.showArchived === true) {
    params.archived = true;
  }
  const activeMinutes =
    options.showArchived === true
      ? 0
      : typeof options.activeMinutes === "number" && options.activeMinutes > 0
        ? Math.floor(options.activeMinutes)
        : 0;
  if (activeMinutes > 0) {
    params.activeMinutes = activeMinutes;
  }
  const agentId = options.agentId?.trim();
  const search = options.search?.trim();
  if (agentId) {
    params.agentId = agentId;
  }
  if (search) {
    params.search = search;
  }
  if (typeof options.offset === "number" && options.offset > 0) {
    params.offset = Math.floor(options.offset);
  }
  return params;
}

async function requestSessionList(
  client: SessionRequestClient,
  options: SessionListOptions = {},
): Promise<SessionsListResult | null> {
  const result = await client.request<SessionsListResult | undefined>(
    "sessions.list",
    buildSessionListParams(options),
  );
  return result ?? null;
}

function requestSessionPatch(
  client: SessionRequestClient,
  key: string,
  patch: SessionPatch,
  options: { agentId?: string | null } = {},
): Promise<SessionsPatchResult> {
  return client.request<SessionsPatchResult>("sessions.patch", {
    ...buildSessionRequestParams(key, options.agentId),
    ...patch,
  });
}

function requestSessionDelete(
  client: SessionRequestClient,
  key: string,
  options: SessionDeleteOptions = {},
): Promise<{ deleted?: boolean; worktreePreserved?: SessionDeleteOutcome["worktreePreserved"] }> {
  return client.request("sessions.delete", {
    ...buildSessionRequestParams(key, options.agentId),
    deleteTranscript: options.deleteTranscript ?? true,
  });
}

function requestSessionReset(
  client: SessionRequestClient,
  key: string,
  options: SessionResetOptions = {},
): Promise<void> {
  return client
    .request("sessions.reset", {
      ...buildSessionRequestParams(key, options.agentId),
    })
    .then(() => undefined);
}

function requestSessionCompact(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null } = {},
): Promise<SessionCompactResult> {
  return client.request<SessionCompactResult>("sessions.compact", {
    ...buildSessionRequestParams(key, options.agentId),
  });
}

function requestSessionSteer(
  client: SessionRequestClient,
  key: string,
  message: string,
  options: { agentId?: string | null } = {},
): Promise<SessionSteerResult> {
  return client.request<SessionSteerResult>("sessions.steer", {
    ...buildSessionRequestParams(key, options.agentId),
    message,
  });
}

function requestSessionFilesList(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null; path?: string; search?: string } = {},
): Promise<SessionWorkspaceListResult | null> {
  return client.request<SessionWorkspaceListResult | null>("sessions.files.list", {
    sessionKey: key,
    path: options.path ?? "",
    search: options.search ?? "",
    ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
  });
}

function requestSessionFile(
  client: SessionRequestClient,
  key: string,
  path: string,
  options: { agentId?: string | null } = {},
): Promise<SessionWorkspaceGetResult | null> {
  return client.request<SessionWorkspaceGetResult | null>("sessions.files.get", {
    sessionKey: key,
    path,
    ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
  });
}

function requestSessionFileSet(
  client: SessionRequestClient,
  key: string,
  path: string,
  content: string,
  options: { agentId?: string | null; expectedHash: string },
): Promise<SessionWorkspaceSetResult | null> {
  return client.request<SessionWorkspaceSetResult | null>("sessions.files.set", {
    sessionKey: key,
    path,
    content,
    expectedHash: options.expectedHash,
    ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
  });
}

function subscribeSessionGateway(client: SessionRequestClient): Promise<void> {
  return client.request("sessions.subscribe", {}).then(() => undefined);
}

async function subscribeSessionMessages(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null } = {},
): Promise<SessionMessageSubscription> {
  const result = await client.request("sessions.messages.subscribe", {
    ...buildSessionRequestParams(key, options.agentId),
  });
  const subscribedKey =
    result && typeof result === "object" && typeof (result as { key?: unknown }).key === "string"
      ? (result as { key: string }).key.trim()
      : "";
  return {
    key: subscribedKey || key.trim(),
    agentId: options.agentId?.trim() || null,
  };
}

export function unsubscribeSessionMessages(
  client: SessionRequestClient,
  subscription: SessionMessageSubscription,
): Promise<void> {
  return client
    .request(
      "sessions.messages.unsubscribe",
      buildSessionRequestParams(subscription.key, subscription.agentId),
    )
    .then(() => undefined);
}

async function listSessionCheckpoints(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsCompactionListResult> {
  return client.request<SessionsCompactionListResult>(
    "sessions.compaction.list",
    buildSessionRequestParams(key, options.agentId),
  );
}

function branchSessionCheckpoint(
  client: SessionRequestClient,
  key: string,
  checkpointId: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsCompactionBranchResult> {
  return client.request<SessionsCompactionBranchResult>("sessions.compaction.branch", {
    ...buildSessionRequestParams(key, options.agentId),
    checkpointId,
  });
}

function restoreSessionCheckpoint(
  client: SessionRequestClient,
  key: string,
  checkpointId: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsCompactionRestoreResult> {
  return client.request<SessionsCompactionRestoreResult>("sessions.compaction.restore", {
    ...buildSessionRequestParams(key, options.agentId),
    checkpointId,
  });
}

function appendSessionResults(
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

function isSessionStateEvent(event: GatewayEventFrame): boolean {
  return event.event === "sessions.changed" || event.event === "session.message";
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
      // Active rows without matching identity may describe a newer or embedded
      // run. Only terminalize an active row when this event owns its run ID.
      if (!runId || !row.activeRunIds?.includes(runId)) {
        return row;
      }
    }
    const remainingRunIds = runId ? row.activeRunIds?.filter((id) => id !== runId) : [];
    if (remainingRunIds?.length) {
      changed = true;
      return {
        ...row,
        activeRunIds: remainingRunIds,
        hasActiveRun: true,
        status: "running" as const,
      };
    }
    const endedAt = row.endedAt ?? terminal.endedAt;
    const runtimeMs =
      typeof row.startedAt === "number" ? Math.max(0, endedAt - row.startedAt) : row.runtimeMs;
    const activeRunIds = row.activeRunIds?.length ? [] : row.activeRunIds;
    const abortedLastRun = terminal.status === "killed" ? true : row.abortedLastRun;
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

export function createSessionCapability(gateway: SessionGateway): SessionCapability {
  let state: SessionState = {
    result: null,
    agentId: null,
    modelOverrides: {},
    loading: false,
    error: null,
    deletedSessions: [],
    groups: [],
  };
  let inFlight: Promise<void> | null = null;
  let queuedRefresh: SessionRefreshOptions | null = null;
  let canonicalListRevision = 0;
  let disposed = false;
  let connectionEpoch = 0;
  let connectionClient = gateway.snapshot.client;
  let connectionConnected = gateway.snapshot.connected;
  const pendingModelPatches = new Map<
    string,
    { token: symbol; previous: string | null | undefined }
  >();
  let subscribedClient: GatewayBrowserClient | null = null;
  let lastListOptions: SessionListOptions = {};
  const listeners = new Set<(next: SessionState) => void>();
  const createdListeners = new Set<(key: string) => void>();

  const captureConnection = (): SessionConnectionScope | null => {
    const snapshot = gateway.snapshot;
    return !disposed && snapshot.connected && snapshot.client
      ? { client: snapshot.client, epoch: connectionEpoch }
      : null;
  };

  const isCurrentConnection = (scope: SessionConnectionScope): boolean => {
    const snapshot = gateway.snapshot;
    return (
      !disposed &&
      connectionEpoch === scope.epoch &&
      snapshot.connected &&
      snapshot.client === scope.client
    );
  };

  const requestList = async (
    options: SessionListOptions = {},
  ): Promise<SessionsListResult | null> => {
    const scope = captureConnection();
    if (!scope) {
      return null;
    }
    const result = await requestSessionList(scope.client, options);
    return isCurrentConnection(scope) ? (result ?? null) : null;
  };

  const publish = (next: SessionState) => {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  };

  const setModelOverride = (key: string, value: string | null | undefined) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    const modelOverrides = { ...state.modelOverrides };
    if (value === undefined) {
      if (!Object.hasOwn(state.modelOverrides, normalizedKey)) {
        return;
      }
      delete modelOverrides[normalizedKey];
    } else {
      const normalizedValue = value === null ? null : value.trim();
      if (
        modelOverrides[normalizedKey] === normalizedValue &&
        Object.hasOwn(modelOverrides, normalizedKey)
      ) {
        return;
      }
      modelOverrides[normalizedKey] = normalizedValue;
    }
    publish({ ...state, modelOverrides });
  };

  const rollbackPendingModelPatches = () => {
    const pending = [...pendingModelPatches];
    pendingModelPatches.clear();
    for (const [key, operation] of pending) {
      setModelOverride(key, operation.previous);
    }
  };

  const load = async (options: SessionRefreshOptions) => {
    const scope = captureConnection();
    if (!scope) {
      return;
    }
    const { append = false, force: _force, backgroundHydrate = false, ...requestOptions } = options;
    lastListOptions = requestOptions;
    if (!backgroundHydrate) {
      publish({ ...state, loading: true, error: null, deletedSessions: [] });
    }
    try {
      const result = await requestSessionList(scope.client, requestOptions);
      if (!isCurrentConnection(scope)) {
        return;
      }
      let nextResult =
        result && append && requestOptions.offset && state.result
          ? appendSessionResults(state.result, result)
          : result;
      if (backgroundHydrate && nextResult) {
        const currentKey = gateway.snapshot.sessionKey?.trim();
        if (currentKey) {
          const currentAgentId = normalizeAgentId(
            parseAgentSessionKey(currentKey)?.agentId ??
              resolveUiSelectedGlobalAgentId(gateway.snapshot),
          );
          const previousCurrentRow =
            state.result?.sessions.find((row) => areUiSessionKeysEquivalent(row.key, currentKey)) ??
            (state.agentId === currentAgentId
              ? state.result?.sessions.find((row) =>
                  uiSessionRowMatchesSelectedChat(gateway.snapshot, row.key, currentKey),
                )
              : undefined);
          if (
            previousCurrentRow &&
            !nextResult.sessions.some((row) =>
              uiSessionRowMatchesSelectedChat(gateway.snapshot, row.key, currentKey),
            )
          ) {
            const sessions = [...nextResult.sessions, previousCurrentRow];
            nextResult = { ...nextResult, count: sessions.length, sessions };
          }
        }
      }
      canonicalListRevision += 1;
      publish({
        result: nextResult,
        agentId: requestOptions.agentId?.trim() ? normalizeAgentId(requestOptions.agentId) : null,
        modelOverrides: state.modelOverrides,
        loading: backgroundHydrate ? state.loading : false,
        error: null,
        deletedSessions: [],
        groups: state.groups,
      });
    } catch (error) {
      if (isCurrentConnection(scope)) {
        publish({
          ...state,
          loading: backgroundHydrate ? state.loading : false,
          error: String(error),
          deletedSessions: [],
        });
      }
    }
  };

  const drainRefreshQueue = async (options: SessionRefreshOptions) => {
    const epoch = connectionEpoch;
    let next: SessionRefreshOptions | null = options;
    while (next) {
      await load(next);
      if (disposed || connectionEpoch !== epoch) {
        return;
      }
      next = queuedRefresh;
      queuedRefresh = null;
    }
  };

  const refresh = (options: SessionRefreshOptions = {}) => {
    if (!gateway.snapshot.connected || !gateway.snapshot.client || disposed) {
      return Promise.resolve();
    }
    if (inFlight) {
      queuedRefresh = options;
      return inFlight;
    }
    const hasListOverrides = Object.entries(options).some(
      ([key, value]) => key !== "force" && key !== "backgroundHydrate" && value !== undefined,
    );
    if (state.result && !options.force && !hasListOverrides) {
      return Promise.resolve();
    }
    const request = drainRefreshQueue(options).finally(() => {
      if (inFlight === request) {
        inFlight = null;
      }
    });
    inFlight = request;
    return request;
  };

  const createResult = async (params: SessionCreateParams = {}) => {
    const scope = captureConnection();
    if (!scope || state.loading) {
      return null;
    }
    try {
      const { currentSessionKey, ...requestParams } = params;
      const result = await requestSessionCreate(scope.client, {
        ...requestParams,
        ...resolveSessionCreateParams(currentSessionKey, params.agentId),
      });
      if (!isCurrentConnection(scope)) {
        return null;
      }
      await refresh({ agentId: params.agentId, force: true });
      if (!isCurrentConnection(scope)) {
        return null;
      }
      // Creation can originate outside the sidebar. Notify presentation owners
      // after refresh so they can reconcile the new row without guessing from list churn.
      for (const listener of createdListeners) {
        listener(result.key);
      }
      return result;
    } catch (error) {
      if (isCurrentConnection(scope)) {
        publish({ ...state, error: String(error) });
      }
      return null;
    }
  };

  const create = async (params: SessionCreateParams = {}) =>
    (await createResult(params))?.key ?? null;

  const LEGACY_GROUPS_STORAGE_KEY = "openclaw:sessions:custom-groups";
  let groupsLoadedEpoch = -1;

  const readGroupNames = (payload: unknown): string[] => {
    const groups = (payload as { groups?: Array<{ name?: unknown }> } | null)?.groups;
    if (!Array.isArray(groups)) {
      return [];
    }
    return groups.flatMap((group) =>
      typeof group?.name === "string" && group.name.trim() ? [group.name.trim()] : [],
    );
  };

  const publishGroups = (groups: readonly string[]) => {
    if (groups.length === state.groups.length && groups.every((g, i) => g === state.groups[i])) {
      return;
    }
    publish({ ...state, groups: [...groups] });
  };

  const readLegacyStoredGroups = (): string[] => {
    try {
      const raw = getSafeLocalStorage()?.getItem(LEGACY_GROUPS_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? [
            ...new Set(
              parsed.flatMap((name) => {
                const normalized = typeof name === "string" ? name.trim() : "";
                return normalized ? [normalized] : [];
              }),
            ),
          ]
        : [];
    } catch {
      return [];
    }
  };

  const loadGroups = async (scope: SessionConnectionScope) => {
    try {
      const listed = await scope.client.request("sessions.groups.list", {});
      if (!isCurrentConnection(scope)) {
        return;
      }
      let names = readGroupNames(listed);
      // One-time migration: browser-local catalogs predate the gateway store.
      const legacy = readLegacyStoredGroups();
      if (names.length === 0 && legacy.length > 0) {
        const put = await scope.client.request("sessions.groups.put", { names: legacy });
        if (!isCurrentConnection(scope)) {
          return;
        }
        names = readGroupNames(put);
      }
      if (legacy.length > 0) {
        try {
          getSafeLocalStorage()?.removeItem(LEGACY_GROUPS_STORAGE_KEY);
        } catch {
          // The gateway catalog is canonical either way.
        }
      }
      publishGroups(names);
    } catch {
      // Older gateways without the groups RPC keep observed-category grouping.
    }
  };

  /** Idempotent per connection; list consumers call it when groups become visible. */
  const groupsLoad = async () => {
    const scope = captureConnection();
    if (!scope || groupsLoadedEpoch === scope.epoch) {
      return;
    }
    groupsLoadedEpoch = scope.epoch;
    await loadGroups(scope);
  };

  const groupsPut = async (names: readonly string[]) => {
    const scope = captureConnection();
    if (!scope) {
      return;
    }
    const result = await scope.client.request("sessions.groups.put", { names: [...names] });
    if (isCurrentConnection(scope)) {
      publishGroups(readGroupNames(result));
    }
  };

  const groupsRename = async (from: string, to: string) => {
    const scope = captureConnection();
    if (!scope) {
      return;
    }
    const result = await scope.client.request("sessions.groups.rename", { name: from, to });
    if (!isCurrentConnection(scope)) {
      return;
    }
    publishGroups(readGroupNames(result));
    await refresh({ ...lastListOptions, force: true });
  };

  const groupsDelete = async (name: string) => {
    const scope = captureConnection();
    if (!scope) {
      return;
    }
    const result = await scope.client.request("sessions.groups.delete", { name });
    if (!isCurrentConnection(scope)) {
      return;
    }
    publishGroups(readGroupNames(result));
    await refresh({ ...lastListOptions, force: true });
  };

  const patch = async (
    key: string,
    patchParams: SessionPatch,
    options: { agentId?: string } = {},
  ): Promise<SessionsPatchResult | null> => {
    const scope = captureConnection();
    if (!scope) {
      return null;
    }
    const hasModelPatch = Object.hasOwn(patchParams, "model");
    const normalizedKey = key.trim();
    const pendingModelPatch = pendingModelPatches.get(normalizedKey);
    const previousModelOverride = pendingModelPatch
      ? pendingModelPatch.previous
      : state.modelOverrides[normalizedKey];
    const modelPatchToken = Symbol();
    if (hasModelPatch) {
      pendingModelPatches.set(normalizedKey, {
        token: modelPatchToken,
        previous: previousModelOverride,
      });
      setModelOverride(key, patchParams.model);
    }
    const restoreModelOverride = () => {
      if (pendingModelPatches.get(normalizedKey)?.token !== modelPatchToken) {
        return;
      }
      pendingModelPatches.delete(normalizedKey);
      setModelOverride(key, previousModelOverride);
    };
    try {
      const result = await requestSessionPatch(scope.client, key, patchParams, options);
      if (!isCurrentConnection(scope)) {
        restoreModelOverride();
        return null;
      }
      await refresh({ agentId: options.agentId, force: true });
      if (!isCurrentConnection(scope)) {
        restoreModelOverride();
        return null;
      }
      if (pendingModelPatches.get(normalizedKey)?.token === modelPatchToken) {
        pendingModelPatches.delete(normalizedKey);
        setModelOverride(key, patchParams.model);
      }
      return result;
    } catch (error) {
      restoreModelOverride();
      if (!isCurrentConnection(scope)) {
        return null;
      }
      publish({ ...state, error: String(error) });
      throw error;
    }
  };

  const reconcile = (
    row: GatewaySessionRow | undefined,
    defaults?: SessionsListResult["defaults"],
    options?: SessionReconcileOptions,
  ): boolean => {
    const result = reconcileSessionHistory(state.result, row, defaults, options);
    if (result === state.result) {
      return false;
    }
    publish({
      ...state,
      result,
      agentId: options?.resultAgentId?.trim()
        ? normalizeAgentId(options.resultAgentId)
        : state.agentId,
    });
    return true;
  };

  const reconcileChanged = (
    payload: unknown,
    options?: SessionReconcileOptions,
  ): SessionChangedResult => {
    const reconciled = reconcileSessionChanged(state.result, payload, options);
    if (reconciled.applied && (reconciled.result !== state.result || reconciled.deletedKey)) {
      publish({
        ...state,
        result: reconciled.result,
        agentId: options?.resultAgentId?.trim()
          ? normalizeAgentId(options.resultAgentId)
          : state.agentId,
        error: null,
        deletedSessions: reconciled.deletedKey
          ? [{ key: reconciled.deletedKey, agentId: reconciled.agentId ?? undefined }]
          : [],
      });
    }
    return reconciled;
  };

  const reconcileRunTerminal = (terminal: SessionRunTerminal): boolean => {
    const result = reconcileSessionRunTerminal(state.result, terminal);
    if (result === state.result) {
      return false;
    }
    publish({ ...state, result, error: null });
    return true;
  };

  const remove = async (
    key: string,
    options: SessionDeleteOptions = {},
  ): Promise<SessionDeleteOutcome> => {
    const scope = captureConnection();
    if (!scope) {
      return { deleted: false };
    }
    try {
      const response = await requestSessionDelete(scope.client, key, options);
      if (!isCurrentConnection(scope)) {
        return { deleted: false };
      }
      publish({ ...state, deletedSessions: [{ key, agentId: options.agentId }] });
      setModelOverride(key, undefined);
      await refresh({ agentId: options.agentId, force: true });
      return {
        deleted: isCurrentConnection(scope),
        ...(response.worktreePreserved ? { worktreePreserved: response.worktreePreserved } : {}),
      };
    } catch (error) {
      if (!isCurrentConnection(scope)) {
        return { deleted: false };
      }
      publish({ ...state, error: String(error) });
      throw error;
    }
  };

  const removeMany = async (
    targets: readonly SessionDeleteTarget[],
  ): Promise<SessionDeleteBatchResult> => {
    const scope = captureConnection();
    if (!scope || targets.length === 0) {
      return { deleted: [], errors: [], preservedWorktrees: [] };
    }
    const deleted: string[] = [];
    const errors: string[] = [];
    const preservedWorktrees: SessionDeleteBatchResult["preservedWorktrees"] = [];
    for (const target of targets) {
      if (!isCurrentConnection(scope)) {
        break;
      }
      try {
        const response = await requestSessionDelete(scope.client, target.key, target);
        if (!isCurrentConnection(scope)) {
          break;
        }
        deleted.push(target.key);
        if (response.worktreePreserved) {
          preservedWorktrees.push(response.worktreePreserved);
        }
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (deleted.length > 0 && isCurrentConnection(scope)) {
      publish({
        ...state,
        deletedSessions: targets.filter((target) => deleted.includes(target.key)),
      });
      for (const key of deleted) {
        setModelOverride(key, undefined);
      }
      await refresh({ force: true });
    }
    return isCurrentConnection(scope)
      ? { deleted, errors, preservedWorktrees }
      : { deleted: [], errors: [], preservedWorktrees: [] };
  };

  const reset = async (
    key: string,
    options: SessionResetOptions = {},
  ): Promise<SessionResetResult> => {
    const scope = captureConnection();
    if (!scope) {
      return "not-started";
    }
    try {
      await requestSessionReset(scope.client, key, options);
      return isCurrentConnection(scope) ? "completed" : "uncertain";
    } catch (error) {
      if (isCurrentConnection(scope)) {
        publish({ ...state, error: String(error) });
      }
      // The gateway commits the new session identity before every awaited
      // post-reset lifecycle step finishes. Once requested, even a rejection
      // on the same connection cannot prove that the destructive reset did not
      // commit, so callers must never retry it automatically.
      return "uncertain";
    }
  };

  const compact = async (
    key: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionCompactResult> => {
    const scope = captureConnection();
    if (!scope) {
      throw new Error("Session compaction requires an active Gateway connection");
    }
    const result = await requestSessionCompact(scope.client, key, options);
    if (!isCurrentConnection(scope)) {
      throw new Error("Session compaction completed on a replaced Gateway connection");
    }
    return result;
  };

  const steer = async (
    key: string,
    message: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionSteerResult> => {
    const scope = captureConnection();
    if (!scope) {
      throw new Error("Session steering requires an active Gateway connection");
    }
    const result = await requestSessionSteer(scope.client, key, message, options);
    if (!isCurrentConnection(scope)) {
      throw new Error("Session steering completed on a replaced Gateway connection");
    }
    return result;
  };

  const listFiles = async (
    key: string,
    options: { agentId?: string | null; path?: string; search?: string } = {},
  ): Promise<SessionWorkspaceListResult | null> => {
    const scope = captureConnection();
    if (!scope) {
      return null;
    }
    const result = await requestSessionFilesList(scope.client, key, options);
    return isCurrentConnection(scope) ? result : null;
  };

  const getFile = async (
    key: string,
    path: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionWorkspaceGetResult | null> => {
    const scope = captureConnection();
    if (!scope) {
      return null;
    }
    const result = await requestSessionFile(scope.client, key, path, options);
    return isCurrentConnection(scope) ? result : null;
  };

  const setFile = async (
    key: string,
    path: string,
    content: string,
    options: { agentId?: string | null; expectedHash: string },
  ): Promise<SessionWorkspaceSetResult | null> => {
    const scope = captureConnection();
    if (!scope) {
      return null;
    }
    const result = await requestSessionFileSet(scope.client, key, path, content, options);
    return isCurrentConnection(scope) ? result : null;
  };

  const subscribeMessages = async (
    key: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionMessageSubscription> => {
    const scope = captureConnection();
    if (!scope) {
      throw new Error("Session message subscription requires an active Gateway connection");
    }
    const subscription = await subscribeSessionMessages(scope.client, key, options);
    if (!isCurrentConnection(scope)) {
      throw new Error("Session message subscription completed on a replaced Gateway connection");
    }
    return subscription;
  };

  const unsubscribeMessages = async (subscription: SessionMessageSubscription) => {
    const scope = captureConnection();
    if (!scope) {
      return;
    }
    await unsubscribeSessionMessages(scope.client, subscription);
  };

  const listCheckpoints = async (
    key: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionCompactionCheckpoint[]> => {
    const scope = captureConnection();
    if (!scope) {
      return [];
    }
    const result = await listSessionCheckpoints(scope.client, key, options);
    return isCurrentConnection(scope) ? (result.checkpoints ?? []) : [];
  };

  const branchCheckpoint = async (
    key: string,
    checkpointId: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionsCompactionBranchResult> => {
    const scope = captureConnection();
    if (!scope) {
      throw new Error("Session checkpoint operation requires an active Gateway connection");
    }
    const result = await branchSessionCheckpoint(scope.client, key, checkpointId, options);
    if (!isCurrentConnection(scope)) {
      throw new Error("Session checkpoint operation completed on a replaced Gateway connection");
    }
    await refresh({
      agentId: options.agentId ?? state.agentId ?? undefined,
      force: true,
    });
    if (!isCurrentConnection(scope)) {
      throw new Error("Session checkpoint operation completed on a replaced Gateway connection");
    }
    return result;
  };

  const restoreCheckpoint = async (
    key: string,
    checkpointId: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionsCompactionRestoreResult> => {
    const scope = captureConnection();
    if (!scope) {
      throw new Error("Session checkpoint operation requires an active Gateway connection");
    }
    const result = await restoreSessionCheckpoint(scope.client, key, checkpointId, options);
    if (!isCurrentConnection(scope)) {
      throw new Error("Session checkpoint operation completed on a replaced Gateway connection");
    }
    await refresh({
      agentId: options.agentId ?? state.agentId ?? undefined,
      force: true,
    });
    if (!isCurrentConnection(scope)) {
      throw new Error("Session checkpoint operation completed on a replaced Gateway connection");
    }
    return result;
  };

  const stopGateway = gateway.subscribe((next) => {
    const connectionChanged =
      next.client !== connectionClient || next.connected !== connectionConnected;
    connectionClient = next.client;
    connectionConnected = next.connected;
    if (connectionChanged) {
      connectionEpoch += 1;
      inFlight = null;
      queuedRefresh = null;
      rollbackPendingModelPatches();
    }
    if (!next.connected || !next.client) {
      subscribedClient = null;
      publish({
        result: null,
        agentId: null,
        modelOverrides: state.modelOverrides,
        loading: false,
        error: null,
        deletedSessions: [],
        groups: state.groups,
      });
      return;
    }
    if (subscribedClient !== next.client) {
      const scope = captureConnection();
      if (!scope) {
        return;
      }
      subscribedClient = scope.client;
      void (async () => {
        try {
          await subscribeSessionGateway(scope.client);
        } catch (error) {
          if (isCurrentConnection(scope)) {
            publish({ ...state, error: String(error) });
          }
        } finally {
          if (isCurrentConnection(scope)) {
            const sessionKey = gateway.snapshot.sessionKey?.trim();
            await refresh({
              ...(sessionKey ? scopedAgentListParamsForSession(gateway.snapshot, sessionKey) : {}),
              backgroundHydrate: true,
              force: true,
            });
          }
        }
      })();
      return;
    }
    void refresh();
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (isSessionStateEvent(event)) {
      const reconciled = reconcileSessionChanged(state.result, event.payload, {
        resultAgentId: state.agentId,
        showArchived: lastListOptions.showArchived,
      });
      const eventInfo = readSessionChangedEvent(event.payload);
      // Catalog mutations from other clients invalidate the per-connection
      // groups snapshot. Groups events carry no session key, so read the
      // reason straight off the payload instead of the parsed row info.
      const eventReason = (event.payload as { reason?: unknown } | null)?.reason;
      if (eventReason === "groups") {
        groupsLoadedEpoch = -1;
        void groupsLoad();
      }
      const hasActiveRun = reconciled.hasActiveRun ?? eventInfo?.hasActiveRun;
      const status = reconciled.status ?? eventInfo?.status;
      const runEnded =
        hasActiveRun === false || (status !== null && status !== undefined && status !== "running");
      if (event.event === "session.message" && !runEnded) {
        return;
      }
      if (reconciled.deletedKey) {
        // Preserve remote-deletion navigation before the canonical refresh
        // clears transient event state.
        publish({
          ...state,
          deletedSessions: [
            { key: reconciled.deletedKey, agentId: reconciled.agentId ?? undefined },
          ],
        });
      }
      // Gateway lists are filtered and windowed. Events cannot preserve server
      // membership or ordering, so the coalesced refresh remains canonical.
      void refresh({ ...lastListOptions, force: true });
    }
  });

  return {
    get state() {
      return state;
    },
    get canonicalListRevision() {
      return canonicalListRevision;
    },
    list: requestList,
    reconcile,
    reconcileChanged,
    reconcileRunTerminal,
    refresh,
    createResult,
    create,
    patch,
    setModelOverride,
    delete: remove,
    deleteMany: removeMany,
    reset,
    compact,
    steer,
    listFiles,
    getFile,
    setFile,
    subscribeMessages,
    unsubscribeMessages,
    listCheckpoints,
    branchCheckpoint,
    restoreCheckpoint,
    groupsLoad,
    groupsPut,
    groupsRename,
    groupsDelete,
    subscribeCreated(listener) {
      createdListeners.add(listener);
      return () => createdListeners.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      connectionEpoch += 1;
      connectionConnected = false;
      inFlight = null;
      queuedRefresh = null;
      subscribedClient = null;
      pendingModelPatches.clear();
      stopGateway();
      stopEvents();
      createdListeners.clear();
      listeners.clear();
    },
  };
}
