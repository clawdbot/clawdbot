import { SESSIONS_LIST_OWNER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";
import { appendSessionResults, reconcileRosterPresentationMetadata } from "./reconcile.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionGateway,
  SessionListOptions,
  SessionListScope,
  SessionListSnapshot,
  SessionRefreshOptions,
  SessionState,
} from "./session-capability.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
} from "./session-key.ts";
import {
  buildSessionListParams,
  DEFAULT_SESSION_LIST_QUERY,
  requestSessionList,
  requestSessionListParams,
} from "./session-requests.ts";

type SessionRosterRefreshHost = {
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  observerError: () => string | null;
  bootstrap: (
    scope: SessionConnectionScope,
    list: Readonly<Record<string, unknown>>,
  ) => Promise<SessionsListResult | null>;
  decorate: (result: SessionsListResult | null) => SessionsListResult | null;
  onCanonicalList: (
    result: SessionsListResult | null,
    requestRevision: number,
    agentId?: string,
    observed?: SessionsListResult | null,
  ) => void;
};

type ManagedSessionListRefresh = {
  append: boolean;
  offset?: number;
  invalidated?: true;
};

type ManagedSessionListQuery = Readonly<Record<string, unknown>> & { readonly limit: number };

type ManagedSessionList = {
  key: string;
  query: ManagedSessionListQuery;
  retainedLimit: number;
  connectionEpoch: number | null;
  snapshot: SessionListSnapshot;
  listeners: Set<(snapshot: SessionListSnapshot) => void>;
  coordinator: ReturnType<typeof createSessionEventRefreshCoordinator>;
  pending: Promise<void> | null;
  queued: ManagedSessionListRefresh | null;
};

function normalizeManagedSessionListQuery(options: SessionListOptions): ManagedSessionListQuery {
  const { offset: _offset, append: _append, ...queryOptions } = options;
  const limit =
    typeof options.limit === "number" && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_SESSION_LIST_QUERY.limit;
  return Object.freeze({ ...buildSessionListParams({ ...queryOptions, limit }), limit });
}

function managedSessionListAgentId(entry: ManagedSessionList): string | undefined {
  return typeof entry.query.agentId === "string" ? entry.query.agentId : undefined;
}

function isPrimarySessionListQuery(options: SessionListScope): boolean {
  if (options.includeDerivedTitles === false || options.includeLastMessage === false) {
    return false;
  }
  const query = normalizeManagedSessionListQuery(options);
  return (
    query.archived === undefined &&
    !query.spawnedBy &&
    !query.boardFace &&
    !query.activeMinutes &&
    !query.search &&
    !query.ownerId &&
    query.involvingMe !== true &&
    query.includeGlobal === true &&
    query.includeUnknown === true &&
    query.configuredAgentsOnly === true
  );
}

function preserveCurrentSessionRow(
  result: SessionsListResult,
  state: SessionState,
  snapshot: SessionGateway["snapshot"],
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
    uiSessionRowMatchesSelectedChat(snapshot, row.key, currentKey);
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

function retainSessionPaginationWindow(
  options: SessionListOptions,
  offset: number | undefined,
  result: SessionsListResult | null,
  nextResult: SessionsListResult,
  snapshot: SessionGateway["snapshot"],
): SessionListOptions {
  const ownerFirstPage =
    Boolean(snapshot.selfUser?.id.trim()) && isPrimarySessionListQuery(options);
  const retainedListLimit =
    ownerFirstPage && result && typeof offset === "number"
      ? offset + result.sessions.length
      : nextResult.sessions.length;
  // Retain the shared pagination window, excluding owner rows merged ahead of it.
  return {
    ...options,
    limit: Math.max(options.limit ?? DEFAULT_SESSION_LIST_QUERY.limit, retainedListLimit),
  };
}

export function createSessionRosterRefresh(host: SessionRosterRefreshHost) {
  let requestRevision = 0;
  let inFlight: Promise<void> | null = null;
  let queuedExplicitRefresh: SessionRefreshOptions | null = null;
  let eventRefreshQueued = false;
  let lastListOptions: SessionListOptions = {};
  let listOptionsSource: "none" | "seeded" | "foreground" = "none";
  const observesPageLifecycle =
    typeof document !== "undefined" && typeof globalThis.addEventListener === "function";
  let pageActive = !observesPageLifecycle || document.visibilityState !== "hidden";
  const managedLists = new Map<string, ManagedSessionList>();

  const publishManagedList = (entry: ManagedSessionList, snapshot: SessionListSnapshot): void => {
    entry.snapshot = snapshot;
    entry.listeners.forEach((listener) => listener(snapshot));
  };

  const managedList = (scope: SessionListScope): ManagedSessionList => {
    const query = normalizeManagedSessionListQuery(scope);
    const key = JSON.stringify(query);
    const current = managedLists.get(key);
    if (current) {
      return current;
    }
    const entry: ManagedSessionList = {
      key,
      query,
      retainedLimit: query.limit,
      connectionEpoch: null,
      snapshot: { result: null, agentId: null, loading: false, error: null },
      listeners: new Set(),
      coordinator: createSessionEventRefreshCoordinator({
        active: pageActive,
        refresh: () => refreshManagedList(entry, { append: false, invalidated: true }),
      }),
      pending: null,
      queued: null,
    };
    managedLists.set(key, entry);
    return entry;
  };

  const refreshManagedList = (
    entry: ManagedSessionList,
    refresh: ManagedSessionListRefresh,
  ): Promise<void> => {
    const scope = host.connection.capture();
    if (!scope) {
      return Promise.resolve();
    }
    if (entry.pending) {
      if (refresh.invalidated) {
        entry.queued = refresh;
      }
      return entry.pending;
    }
    if (refresh.append && !entry.snapshot.result) {
      return Promise.resolve();
    }
    if (!refresh.append) {
      entry.coordinator.absorb();
    }
    const isCurrent = () =>
      managedLists.get(entry.key) === entry && host.connection.isCurrent(scope);
    const drain = async () => {
      let next: ManagedSessionListRefresh | null = refresh;
      while (next && isCurrent()) {
        const requestParams = {
          ...entry.query,
          limit: next.append ? entry.query.limit : entry.retainedLimit,
          ...(next.append && next.offset !== undefined ? { offset: next.offset } : {}),
        };
        publishManagedList(entry, { ...entry.snapshot, loading: true, error: null });
        try {
          const result = await requestSessionListParams(scope.client, requestParams);
          if (!isCurrent()) {
            return;
          }
          const previous = entry.snapshot.result;
          const nextResult =
            result && next.append && requestParams.offset && previous
              ? appendSessionResults(previous, result)
              : reconcileRosterPresentationMetadata(result, previous);
          const decorated = host.decorate(nextResult);
          if (decorated) {
            entry.retainedLimit = Math.max(entry.retainedLimit, decorated.sessions.length);
          }
          entry.connectionEpoch = scope.epoch;
          publishManagedList(entry, {
            result: decorated,
            agentId: managedSessionListAgentId(entry) ?? null,
            loading: false,
            error: null,
          });
        } catch (error) {
          if (!isCurrent()) {
            return;
          }
          publishManagedList(entry, {
            ...entry.snapshot,
            loading: false,
            error: formatUiError(error),
          });
        }
        if (!isCurrent()) {
          return;
        }
        const queued = entry.queued;
        entry.queued = null;
        next = pageActive ? queued : null;
      }
    };
    const pending = drain().finally(() => {
      if (entry.pending === pending) {
        entry.pending = null;
      }
    });
    entry.pending = pending;
    return pending;
  };

  const list = async (options: SessionListOptions = {}): Promise<SessionsListResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      const result = await requestSessionList(scope.client, options);
      return host.connection.isCurrent(scope) ? host.decorate(result ?? null) : null;
    } catch (error) {
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      throw error;
    }
  };

  const load = async (
    options: SessionRefreshOptions,
    bootstrap = false,
  ): Promise<SessionsListResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const issuedRevision = ++requestRevision;
    const { append = false, force: _force, backgroundHydrate = false, ...requestOptions } = options;
    // Every canonical roster replaces visible session names, so omitted title
    // enrichment must inherit the UI default instead of publishing fallback ids.
    requestOptions.includeDerivedTitles ??= true;
    const durableListOptions: SessionListOptions = { ...requestOptions };
    // Pagination is request-local; replacements retain filters but restart at page one.
    delete durableListOptions.offset;
    if (!backgroundHydrate) {
      lastListOptions = durableListOptions;
      listOptionsSource = "foreground";
    } else if (listOptionsSource === "none") {
      lastListOptions = durableListOptions;
      listOptionsSource = "seeded";
    }
    if (!backgroundHydrate) {
      const error = host.observerError();
      host.publish(
        { ...host.readState(), loading: true, error, deletedSessions: [] },
        error ? "session-observer" : undefined,
      );
    }
    try {
      const listParams = buildSessionListParams(requestOptions);
      let result = bootstrap ? await host.bootstrap(scope, listParams) : null;
      if (bootstrap && !host.connection.isCurrent(scope)) {
        return null;
      }
      result ??= await requestSessionListParams(scope.client, listParams);
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      const currentState = host.readState();
      const mergeWithCurrent = append && typeof requestOptions.offset === "number";
      let nextResult =
        result && mergeWithCurrent && currentState.result
          ? appendSessionResults(currentState.result, result)
          : reconcileRosterPresentationMetadata(result, currentState.result);
      if (append && nextResult && !backgroundHydrate) {
        lastListOptions = retainSessionPaginationWindow(
          durableListOptions,
          requestOptions.offset,
          result,
          nextResult,
          host.snapshot(),
        );
      }
      if (nextResult) {
        nextResult = preserveCurrentSessionRow(
          nextResult,
          currentState,
          host.snapshot(),
          backgroundHydrate,
        );
      }
      nextResult = host.decorate(nextResult);
      host.onCanonicalList(nextResult, issuedRevision, requestOptions.agentId, result);
      const state = host.readState();
      const error = host.observerError();
      host.publish(
        {
          result: nextResult,
          agentId: requestOptions.agentId?.trim() ? normalizeAgentId(requestOptions.agentId) : null,
          modelOverrides: state.modelOverrides,
          loading: backgroundHydrate ? state.loading : false,
          error,
          deletedSessions: [],
          groups: state.groups,
          groupSettings: state.groupSettings,
          sectionOrder: state.sectionOrder,
        },
        error ? "session-observer" : undefined,
      );
      return result;
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        const state = host.readState();
        host.publish(
          {
            ...state,
            loading: backgroundHydrate ? state.loading : false,
            error: formatUiError(error),
            deletedSessions: [],
          },
          "operation",
        );
      }
      return null;
    }
  };

  const absorbPendingEventRefresh = () => {
    eventRefreshCoordinator.absorb();
    eventRefreshQueued = false;
  };

  const takeNextQueuedRefresh = (): SessionRefreshOptions | null => {
    const explicitRefresh = queuedExplicitRefresh;
    queuedExplicitRefresh = null;
    if (explicitRefresh) {
      // Replacement absorbs earlier events; append still needs its trailing replacement.
      if (explicitRefresh.append !== true) {
        absorbPendingEventRefresh();
      }
      return explicitRefresh;
    }
    if (!eventRefreshQueued) {
      return null;
    }
    if (!pageActive) {
      return null;
    }
    eventRefreshQueued = false;
    return { ...lastListOptions, force: true };
  };

  const prepareRefreshOptions = (options: SessionRefreshOptions): SessionRefreshOptions => {
    if (
      !host.snapshot().selfUser?.id.trim() ||
      options.append === true ||
      !isPrimarySessionListQuery(options)
    ) {
      return options;
    }
    const limit = Math.max(
      SESSIONS_LIST_OWNER_LIMIT,
      typeof options.limit === "number" && options.limit > 0
        ? Math.floor(options.limit)
        : DEFAULT_SESSION_LIST_QUERY.limit,
    );
    return {
      ...options,
      ownerFirst: true,
      limit,
    };
  };

  const drainRefreshQueue = async (options: SessionRefreshOptions, bootstrap: boolean) => {
    const scope = host.connection.capture();
    if (!scope) {
      return;
    }
    let bootstrapPending = bootstrap;
    let next: SessionRefreshOptions | null = options;
    while (next) {
      await load(prepareRefreshOptions(next), bootstrapPending);
      bootstrapPending = false;
      if (!host.connection.isCurrent(scope)) {
        return;
      }
      next = takeNextQueuedRefresh();
    }
  };

  const startRefresh = (options: SessionRefreshOptions, bootstrap = false) => {
    const request = drainRefreshQueue(options, bootstrap).finally(() => {
      if (inFlight === request) {
        inFlight = null;
      }
    });
    inFlight = request;
    return request;
  };

  const refreshInternal = (options: SessionRefreshOptions, bootstrap: boolean): Promise<void> => {
    if (!host.connection.capture()) {
      return Promise.resolve();
    }
    if (inFlight) {
      queuedExplicitRefresh = options;
      return inFlight;
    }
    const hasListOverrides = Object.entries(options).some(
      ([key, value]) => key !== "force" && key !== "backgroundHydrate" && value !== undefined,
    );
    if (host.readState().result && !options.force && !hasListOverrides) {
      return Promise.resolve();
    }
    if (options.append !== true) {
      absorbPendingEventRefresh();
    }
    return startRefresh(options, bootstrap);
  };

  const refresh = (options: SessionRefreshOptions = {}): Promise<void> =>
    refreshInternal(options, false);

  const refreshFromEvent = () => {
    if (!host.connection.capture()) {
      return Promise.resolve();
    }
    if (inFlight) {
      eventRefreshQueued = true;
      return inFlight;
    }
    eventRefreshQueued = false;
    return startRefresh({ ...lastListOptions, force: true });
  };

  const eventRefreshCoordinator = createSessionEventRefreshCoordinator({
    active: pageActive,
    refresh: refreshFromEvent,
  });

  const handlePageLifecycle = (event: Event) => {
    const markDirty = event.type === "pagehide";
    pageActive = !markDirty && document.visibilityState !== "hidden";
    eventRefreshCoordinator.setActive(pageActive, markDirty || inFlight !== null);
    for (const entry of managedLists.values()) {
      entry.coordinator.setActive(pageActive, markDirty || entry.pending !== null);
    }
  };

  const updatePageLifecycleListeners = (add: boolean) => {
    const method = add ? "addEventListener" : "removeEventListener";
    document[method]("visibilitychange", handlePageLifecycle);
    globalThis[method]("pagehide", handlePageLifecycle);
    globalThis[method]("pageshow", handlePageLifecycle);
  };
  if (observesPageLifecycle) {
    updatePageLifecycleListeners(true);
  }

  const refreshReplacement = (agentId?: string | null): Promise<void> => {
    const options = { ...lastListOptions };
    const normalizedAgentId = agentId?.trim();
    if (normalizedAgentId) {
      options.agentId = normalizedAgentId;
    }
    return refresh({ ...options, force: true });
  };

  return {
    get requestRevision() {
      return requestRevision;
    },
    list,
    listSnapshot(scope: SessionListScope): SessionListSnapshot {
      if (isPrimarySessionListQuery(scope)) {
        const { result, agentId, loading, error } = host.readState();
        return { result, agentId, loading, error };
      }
      return (
        managedLists.get(JSON.stringify(normalizeManagedSessionListQuery(scope)))?.snapshot ?? {
          result: null,
          agentId: null,
          loading: false,
          error: null,
        }
      );
    },
    subscribeList(scope: SessionListScope, listener: (snapshot: SessionListSnapshot) => void) {
      const entry = managedList(scope);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0 || managedLists.get(entry.key) !== entry) {
          return;
        }
        const release = () => {
          if (entry.listeners.size === 0 && managedLists.get(entry.key) === entry) {
            entry.coordinator.dispose();
            managedLists.delete(entry.key);
          }
        };
        // Route replacement may briefly remove every subscriber while this query still owns a request.
        if (entry.pending) {
          void entry.pending.finally(release);
        } else {
          release();
        }
      };
    },
    refreshList(options: SessionRefreshOptions = {}): Promise<void> {
      if (isPrimarySessionListQuery(options)) {
        return refresh(options);
      }
      const entry = managedList(options);
      return refreshManagedList(entry, {
        append: options.append === true,
        ...(options.force === true && options.append !== true ? { invalidated: true } : {}),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
      });
    },
    isPrimaryList: isPrimarySessionListQuery,
    async refreshManagedLists() {
      const scope = host.connection.capture();
      if (!scope) {
        return;
      }
      await Promise.all(
        [...managedLists.values()]
          .filter((entry) => entry.listeners.size > 0 && entry.connectionEpoch !== scope.epoch)
          .map((entry) => refreshManagedList(entry, { append: false })),
      );
    },
    refresh,
    bootstrap(options: SessionRefreshOptions) {
      return refreshInternal(options, true);
    },
    refreshReplacement,
    /** The row as currently published. The archived/all sidebars render their
     * own snapshot, so a displayed row can be absent from the primary state.
     * Lists refresh independently, so when both hold the row the primary one
     * wins rather than guessing which snapshot the caller was looking at. */
    publishedRow(key: string): GatewaySessionRow | undefined {
      const primary = host.readState().result?.sessions.find((row) => row.key === key);
      if (primary) {
        return primary;
      }
      for (const entry of managedLists.values()) {
        const row = entry.snapshot.result?.sessions.find((candidate) => candidate.key === key);
        if (row) {
          return row;
        }
      }
      return undefined;
    },
    /** Republishes every held list through `decorate` so a UI-owned overlay
     * reaches the archived/all snapshots too, not just the primary state. */
    redecorateLists() {
      const state = host.readState();
      const result = host.decorate(state.result);
      if (result !== state.result) {
        host.publish({ ...state, result });
      }
      for (const entry of managedLists.values()) {
        const decorated = host.decorate(entry.snapshot.result);
        if (decorated !== entry.snapshot.result) {
          publishManagedList(entry, { ...entry.snapshot, result: decorated });
        }
      }
    },
    setOwnerFilter(ownerId: string | null) {
      const options = {
        ...lastListOptions,
        ownerId: ownerId?.trim() || undefined,
        involvingMe: undefined,
      };
      delete options.offset;
      return refresh({ ...options, force: true });
    },
    setInvolvingMeFilter(enabled: boolean) {
      const options = {
        ...lastListOptions,
        ownerId: undefined,
        involvingMe: enabled || undefined,
      };
      delete options.offset;
      return refresh({ ...options, force: true });
    },
    lastOptions: () => lastListOptions,
    // Gateway-owned membership filters require an authoritative list refresh.
    canApplyPrimarySnapshot: () => isPrimarySessionListQuery(lastListOptions),
    scheduleEvent(options: { agentId?: string | null; primarySnapshotApplied?: boolean } = {}) {
      if (!options.primarySnapshotApplied) {
        eventRefreshCoordinator.schedule();
      }
      const agentId = options.agentId ? normalizeAgentId(options.agentId) : null;
      for (const entry of managedLists.values()) {
        const queryAgentId = managedSessionListAgentId(entry);
        if (!agentId || !queryAgentId || normalizeAgentId(queryAgentId) === agentId) {
          entry.coordinator.schedule();
        }
      }
    },
    reset() {
      eventRefreshCoordinator.reset();
      inFlight = null;
      queuedExplicitRefresh = null;
      eventRefreshQueued = false;
      for (const entry of managedLists.values()) {
        entry.coordinator.reset();
        entry.pending = entry.queued = null;
        if (entry.listeners.size === 0) {
          entry.coordinator.dispose();
          managedLists.delete(entry.key);
          continue;
        }
        if (entry.snapshot.loading || entry.snapshot.error) {
          publishManagedList(entry, { ...entry.snapshot, loading: false, error: null });
        }
      }
    },
    dispose() {
      eventRefreshCoordinator.dispose();
      if (observesPageLifecycle) {
        updatePageLifecycleListeners(false);
      }
      inFlight = null;
      queuedExplicitRefresh = null;
      eventRefreshQueued = false;
      for (const entry of managedLists.values()) {
        entry.coordinator.dispose();
        entry.listeners.clear();
      }
      managedLists.clear();
    },
  };
}
