import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";
import {
  appendSessionResults,
  preserveCurrentSessionRow,
  reconcileRosterPresentationMetadata,
} from "./reconcile.ts";
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
import { normalizeAgentId } from "./session-key.ts";
import {
  completeSessionRefreshWaiters,
  findPublishedSession,
  isPrimarySessionListQuery,
  isSameSessionListQuery,
  prepareSessionRefreshOptions,
  retainSessionPaginationWindow,
  sessionListQueryAgentId,
  type QueuedSessionRefresh,
} from "./session-list-query.ts";
import {
  buildSessionListParams,
  normalizeManagedSessionListQuery,
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
  decorate: (
    result: SessionsListResult | null,
    owner: { scope: SessionListScope },
  ) => SessionsListResult | null;
  reconcileList: (
    result: SessionsListResult | null,
    issuedRevision: number,
    agentId?: string,
  ) => SessionsListResult | null;
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

export type SessionRefreshOutcome =
  | { status: "refreshed" | "stale" }
  | { status: "failed"; error: string };

type ManagedSessionList = {
  key: string;
  query: ReturnType<typeof normalizeManagedSessionListQuery>;
  scope: SessionListScope;
  retainedLimit: number;
  connectionEpoch: number | null;
  snapshot: SessionListSnapshot;
  listeners: Set<(snapshot: SessionListSnapshot) => void>;
  coordinator: ReturnType<typeof createSessionEventRefreshCoordinator>;
  pending: Promise<void> | null;
  queued: ManagedSessionListRefresh | null;
};

function isForegroundReplacement(options: SessionRefreshOptions): boolean {
  return options.append !== true && options.backgroundHydrate !== true;
}

export function createSessionRosterRefresh(host: SessionRosterRefreshHost) {
  let requestRevision = 0;
  // A queued foreground replacement owns publication; older loads may only finish for callers.
  let foregroundPublicationGeneration = 0;
  let inFlight: Promise<SessionsListResult | null> | null = null;
  let refreshOutcomeRevision = 0;
  let lastRefreshOutcome: SessionRefreshOutcome = { status: "stale" };
  let queuedExplicitRefresh: (QueuedSessionRefresh & { isErrorCurrent?: () => boolean }) | null =
    null;
  let eventRefreshQueued = false;
  let lastListOptions: SessionListOptions = {};
  let primaryList: { scope: SessionListScope } = { scope: {} };
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
      scope: Object.freeze({ ...scope }),
      retainedLimit: query.limit,
      connectionEpoch: null,
      snapshot: { result: null, agentId: null, loading: false, error: null },
      listeners: new Set(),
      coordinator: createSessionEventRefreshCoordinator({
        active: false,
        refresh: () => refreshManagedList(entry, { append: false, invalidated: true }),
      }),
      pending: null,
      queued: null,
    };
    managedLists.set(key, entry);
    return entry;
  };

  const subscribeManagedList = (
    entry: ManagedSessionList,
    listener: (snapshot: SessionListSnapshot) => void,
  ) => {
    const subscribed = (snapshot: SessionListSnapshot) => listener(snapshot);
    entry.listeners.add(subscribed);
    entry.coordinator.setActive(pageActive);
    return () => {
      entry.listeners.delete(subscribed);
      if (entry.listeners.size > 0 || managedLists.get(entry.key) !== entry) {
        return;
      }
      // Keep invalidation dormant until observed again, without runnable queued work.
      entry.coordinator.setActive(false, entry.queued !== null);
      entry.queued = null;
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
  };

  const invalidateManagedLists = (agentId?: string | null) => {
    const normalizedAgentId = agentId ? normalizeAgentId(agentId) : null;
    for (const entry of managedLists.values()) {
      const queryAgentId = sessionListQueryAgentId(entry.query);
      if (
        !normalizedAgentId ||
        !queryAgentId ||
        normalizeAgentId(queryAgentId) === normalizedAgentId
      ) {
        entry.coordinator.schedule();
      }
    }
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
          const issuedRevision = ++requestRevision;
          const response = await requestSessionListParams(scope.client, requestParams);
          if (!isCurrent()) {
            return;
          }
          if (!response) {
            throw new Error("The session query did not return a result. Try again.");
          }
          const result = host.reconcileList(
            response,
            issuedRevision,
            sessionListQueryAgentId(entry.query),
          );
          const previous = entry.snapshot.result;
          const nextResult =
            result && next.append && requestParams.offset && previous
              ? appendSessionResults(previous, result)
              : reconcileRosterPresentationMetadata(result, previous);
          const decorated = host.decorate(nextResult, entry);
          if (decorated) {
            entry.retainedLimit = Math.max(entry.retainedLimit, decorated.sessions.length);
          }
          entry.connectionEpoch = scope.epoch;
          publishManagedList(entry, {
            result: decorated,
            agentId: sessionListQueryAgentId(entry.query) ?? null,
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
    // Loading listeners can request a refresh before the first RPC starts.
    // Claim the pending owner first so those requests enter its trailing queue.
    let settleRefresh!: (refresh: Promise<void>) => void;
    const pending = new Promise<void>((resolve) => {
      settleRefresh = resolve;
    }).finally(() => {
      if (entry.pending === pending) {
        entry.pending = null;
      }
    });
    entry.pending = pending;
    settleRefresh(drain());
    return pending;
  };

  const list = async (options: SessionListOptions = {}): Promise<SessionsListResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      const issuedRevision = ++requestRevision;
      const result = await requestSessionList(scope.client, options);
      return host.connection.isCurrent(scope)
        ? host.decorate(host.reconcileList(result ?? null, issuedRevision, options.agentId), {
            scope: options,
          })
        : null;
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
    isErrorCurrent?: () => boolean,
  ): Promise<SessionsListResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const publicationGeneration = foregroundPublicationGeneration;
    const isCurrent = () =>
      host.connection.isCurrent(scope) && publicationGeneration === foregroundPublicationGeneration;
    const { append = false, force: _force, backgroundHydrate = false, ...requestOptions } = options;
    const durableListOptions: SessionListOptions = { ...requestOptions };
    // Pagination is request-local; replacements retain filters but restart at page one.
    delete durableListOptions.offset;
    if (!backgroundHydrate) {
      lastListOptions = durableListOptions;
      listOptionsSource = "foreground";
    } else if (bootstrap || listOptionsSource === "none") {
      // Reconnect may select a different agent; later event refreshes must use that query.
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
      let issuedRevision = ++requestRevision;
      let result = bootstrap ? await host.bootstrap(scope, listParams) : null;
      if (bootstrap && !isCurrent()) {
        return null;
      }
      if (!result) {
        // A subscribe acknowledgement without rows starts a separate canonical read.
        if (bootstrap) {
          issuedRevision = ++requestRevision;
        }
        result = await requestSessionListParams(scope.client, listParams);
      }
      if (!isCurrent()) {
        return null;
      }
      result = host.reconcileList(result, issuedRevision, requestOptions.agentId);
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
      // Append extends this window; a different query replaces its rollback owner.
      if (!isSameSessionListQuery(primaryList.scope, durableListOptions, mergeWithCurrent)) {
        primaryList = { scope: durableListOptions };
      }
      primaryList.scope = append ? lastListOptions : durableListOptions;
      nextResult = host.decorate(nextResult, primaryList);
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
      lastRefreshOutcome = { status: "refreshed" };
      refreshOutcomeRevision += 1;
      return result;
    } catch (error) {
      const message = formatUiError(error);
      const ownsError = isErrorCurrent?.() !== false;
      if (isCurrent()) {
        const state = host.readState();
        host.publish(
          {
            ...state,
            loading: backgroundHydrate ? state.loading : false,
            error: ownsError ? message : state.error,
            deletedSessions: [],
          },
          ownsError ? "operation" : undefined,
        );
      }
      lastRefreshOutcome =
        isCurrent() && ownsError ? { status: "failed", error: message } : { status: "stale" };
      refreshOutcomeRevision += 1;
      return null;
    }
  };

  const absorbPendingEventRefresh = () => {
    eventRefreshCoordinator.absorb();
    eventRefreshQueued = false;
  };

  const startRefresh = (
    options: SessionRefreshOptions,
    bootstrap = false,
    isErrorCurrent?: () => boolean,
  ): Promise<SessionsListResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return Promise.resolve(null);
    }
    // Claim inFlight before load publishes; each caller awaits its own load, never later events.
    let settleRefresh!: (refresh: Promise<SessionsListResult | null>) => void;
    const request = new Promise<SessionsListResult | null>((resolve) => {
      settleRefresh = resolve;
    }).finally(() => {
      if (inFlight !== request) {
        return;
      }
      inFlight = null;
      const queued = queuedExplicitRefresh;
      queuedExplicitRefresh = null;
      if (queued) {
        // Replacement absorbs earlier events; append still needs its trailing replacement.
        if (queued.options.append !== true) {
          absorbPendingEventRefresh();
        }
        const snapshot = host.snapshot();
        const nextOptions = prepareSessionRefreshOptions(queued.options, snapshot);
        const next = host.connection.isCurrent(scope)
          ? startRefresh(nextOptions, false, queued.isErrorCurrent)
          : null;
        completeSessionRefreshWaiters(queued, nextOptions, next, snapshot);
      } else if (eventRefreshQueued && pageActive && host.connection.isCurrent(scope)) {
        eventRefreshQueued = false;
        void startRefresh({ ...lastListOptions, force: true });
      }
    });
    inFlight = request;
    settleRefresh(
      load(prepareSessionRefreshOptions(options, host.snapshot()), bootstrap, isErrorCurrent),
    );
    return request;
  };

  const refreshInternal = (
    options: SessionRefreshOptions,
    bootstrap: boolean,
    isErrorCurrent?: () => boolean,
  ): Promise<SessionsListResult | null> => {
    if (!host.connection.capture()) {
      return Promise.resolve(null);
    }
    const foregroundReplacement = isForegroundReplacement(options);
    if (inFlight) {
      if (foregroundReplacement) {
        foregroundPublicationGeneration += 1;
      }
      return new Promise<SessionsListResult | null>((complete) => {
        if (queuedExplicitRefresh) {
          // Once queued, a foreground owner stays authoritative over weaker refreshes.
          if (foregroundReplacement || !isForegroundReplacement(queuedExplicitRefresh.options)) {
            queuedExplicitRefresh.options = options;
            queuedExplicitRefresh.isErrorCurrent = isErrorCurrent;
          }
          queuedExplicitRefresh.completions.push({ options, complete });
        } else {
          queuedExplicitRefresh = { options, isErrorCurrent, completions: [{ options, complete }] };
        }
      });
    }
    const hasListOverrides = Object.entries(options).some(
      ([key, value]) => key !== "force" && key !== "backgroundHydrate" && value !== undefined,
    );
    if (host.readState().result && !options.force && !hasListOverrides) {
      return Promise.resolve(host.readState().result);
    }
    if (foregroundReplacement) {
      foregroundPublicationGeneration += 1;
    }
    if (options.append !== true) {
      absorbPendingEventRefresh();
    }
    return startRefresh(options, bootstrap, isErrorCurrent);
  };

  const refresh = async (options: SessionRefreshOptions = {}): Promise<void> => {
    await refreshInternal(options, false);
  };

  const refreshFromEvent = async (): Promise<void> => {
    if (!host.connection.capture()) {
      return;
    }
    if (inFlight) {
      eventRefreshQueued = true;
      await inFlight;
      return;
    }
    eventRefreshQueued = false;
    await startRefresh({ ...lastListOptions, force: true });
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
      if (entry.listeners.size > 0) {
        entry.coordinator.setActive(pageActive, markDirty || entry.pending !== null);
      }
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

  const refreshReplacementOwned = (
    agentId?: string | null,
    isErrorCurrent?: () => boolean,
  ): Promise<SessionsListResult | null> => {
    const options = { ...lastListOptions };
    if (agentId?.trim()) {
      options.agentId = agentId.trim();
    }
    return refreshInternal({ ...options, force: true }, false, isErrorCurrent);
  };
  const refreshReplacement = (agentId?: string | null) => refreshReplacementOwned(agentId);
  const refreshReplacementResult = (
    agentId?: string | null,
    isErrorCurrent?: () => boolean,
  ): Promise<SessionRefreshOutcome> => {
    const previousOutcomeRevision = refreshOutcomeRevision;
    return refreshReplacementOwned(agentId, isErrorCurrent).then(() =>
      refreshOutcomeRevision > previousOutcomeRevision ? lastRefreshOutcome : { status: "stale" },
    );
  };
  const publishedSession = (matches: Parameters<typeof findPublishedSession>[2]) =>
    findPublishedSession(host.readState(), managedLists.values(), matches);
  return {
    primaryList: () => primaryList,
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
      return subscribeManagedList(managedList(scope), listener);
    },
    observeList: (scope: SessionListScope, listener: (snapshot: SessionListSnapshot) => void) => {
      const entry = managedList(scope);
      const unsubscribe = subscribeManagedList(entry, listener);
      let disposed = false;
      const check = () => {
        if (disposed || managedLists.get(entry.key) !== entry) {
          throw new Error("This session query has been disposed.");
        }
      };
      try {
        listener(entry.snapshot);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return {
        async refresh() {
          check();
          const connection = host.connection.capture();
          if (!connection) {
            throw new Error("The session query is unavailable while disconnected. Try again.");
          }
          await refreshManagedList(entry, { append: false, invalidated: true });
          check();
          if (!host.connection.isCurrent(connection)) {
            throw new Error("The session query connection changed. Try again.");
          }
          if (entry.snapshot.error) {
            throw new Error(entry.snapshot.error);
          }
        },
        dispose() {
          if (!disposed) {
            disposed = true;
            unsubscribe();
          }
        },
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
    refreshReplacementResult,
    publishedSession,
    publishedRow: (matches: (row: GatewaySessionRow, agentId?: string | null) => boolean) =>
      publishedSession(matches)?.row,
    /** Republishes every held list through `decorate` so a UI-owned overlay
     * reaches the archived/all snapshots too, not just the primary state. */
    redecorateLists() {
      const state = host.readState();
      const result = host.decorate(state.result, primaryList);
      if (result !== state.result) {
        host.publish({ ...state, result });
      }
      for (const entry of managedLists.values()) {
        const decorated = host.decorate(entry.snapshot.result, entry);
        if (decorated !== entry.snapshot.result) {
          publishManagedList(entry, { ...entry.snapshot, result: decorated });
        }
      }
    },
    lastOptions: () => lastListOptions,
    // Gateway-owned membership filters require an authoritative list refresh.
    canApplyPrimarySnapshot: () => isPrimarySessionListQuery(lastListOptions),
    invalidateManagedLists,
    scheduleEvent(options: { agentId?: string | null; primarySnapshotApplied?: boolean } = {}) {
      const agentId = options.agentId ? normalizeAgentId(options.agentId) : null;
      const matchesAgent = (queryAgentId?: string) =>
        !agentId || !queryAgentId?.trim() || normalizeAgentId(queryAgentId) === agentId;
      if (!options.primarySnapshotApplied && matchesAgent(lastListOptions.agentId)) {
        eventRefreshCoordinator.schedule();
      }
      invalidateManagedLists(options.agentId);
    },
    reset() {
      foregroundPublicationGeneration += 1;
      primaryList = { scope: primaryList.scope };
      eventRefreshCoordinator.reset();
      inFlight = null;
      queuedExplicitRefresh?.completions.forEach(({ complete }) => complete(null));
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
      foregroundPublicationGeneration += 1;
      eventRefreshCoordinator.dispose();
      if (observesPageLifecycle) {
        updatePageLifecycleListeners(false);
      }
      inFlight = null;
      queuedExplicitRefresh?.completions.forEach(({ complete }) => complete(null));
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
