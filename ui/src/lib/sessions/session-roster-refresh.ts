import type { SessionsListResult } from "../../api/types.ts";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";
import { appendSessionResults } from "./reconcile.ts";
import type {
  SessionConnectionOwner,
  SessionGateway,
  SessionListOptions,
  SessionListScope,
  SessionListSnapshot,
  SessionRefreshOptions,
  SessionState,
} from "./session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
} from "./session-key.ts";
import { DEFAULT_SESSION_LIST_QUERY, requestSessionList } from "./session-requests.ts";

type SessionRosterRefreshHost = {
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  observerError: () => string | null;
  decorate: (result: SessionsListResult | null) => SessionsListResult | null;
  onCanonicalList: (result: SessionsListResult | null) => void;
};

type FilteredSessionList = {
  key: string;
  agentId: string;
  archivedFilter: "archived" | "all";
  snapshot: SessionListSnapshot;
  options: SessionListOptions;
  listeners: Set<(snapshot: SessionListSnapshot) => void>;
  coordinator: ReturnType<typeof createSessionEventRefreshCoordinator>;
  pending: Promise<void> | null;
  queued: SessionRefreshOptions | null;
};

export function createSessionRosterRefresh(host: SessionRosterRefreshHost) {
  let inFlight: Promise<void> | null = null;
  let queuedExplicitRefresh: SessionRefreshOptions | null = null;
  let eventRefreshQueued = false;
  let lastListOptions: SessionListOptions = {};
  let hasForegroundListOptions = false;
  let hasSeededListOptions = false;
  const filteredLists = new Map<string, FilteredSessionList>();

  const filteredListKey = (scope: SessionListScope): string => {
    const agentId = normalizeAgentId(
      scope.agentId ?? host.readState().agentId ?? resolveUiSelectedGlobalAgentId(host.snapshot()),
    );
    return `${agentId}:${scope.archivedFilter}`;
  };

  const publishFilteredList = (entry: FilteredSessionList, snapshot: SessionListSnapshot): void => {
    entry.snapshot = snapshot;
    entry.listeners.forEach((listener) => listener(snapshot));
  };

  const filteredList = (scope: SessionListScope): FilteredSessionList => {
    const key = filteredListKey(scope);
    const current = filteredLists.get(key);
    if (current) {
      return current;
    }
    const agentId = key.slice(0, key.lastIndexOf(":"));
    const archivedFilter = scope.archivedFilter === "archived" ? "archived" : "all";
    const entry: FilteredSessionList = {
      key,
      agentId,
      archivedFilter,
      snapshot: { result: null, agentId: null, loading: false, error: null },
      options: { agentId, archivedFilter },
      listeners: new Set(),
      coordinator: createSessionEventRefreshCoordinator({
        canRefresh: () =>
          filteredLists.get(key) === entry &&
          entry.listeners.size > 0 &&
          host.connection.capture() !== null,
        refresh: () => refreshFilteredList({ ...entry.options, force: true }),
      }),
      pending: null,
      queued: null,
    };
    filteredLists.set(key, entry);
    return entry;
  };

  const refreshFilteredList = (options: SessionRefreshOptions): Promise<void> => {
    const scope = host.connection.capture();
    if (!scope) {
      return Promise.resolve();
    }
    const entry = filteredList(options);
    if (entry.pending) {
      if (!options.append) {
        entry.queued = options;
      }
      return entry.pending;
    }
    if (options.append && !entry.snapshot.result) {
      return Promise.resolve();
    }
    if (!options.append) {
      entry.coordinator.absorb();
    }
    const isCurrent = () =>
      filteredLists.get(entry.key) === entry && host.connection.isCurrent(scope);
    const drain = async () => {
      let next: SessionRefreshOptions | null = options;
      while (next && isCurrent()) {
        const { append = false, ...requestOptions } = next;
        delete requestOptions.force;
        delete requestOptions.backgroundHydrate;
        Object.assign(requestOptions, {
          agentId: entry.agentId,
          archivedFilter: entry.archivedFilter,
        });
        if (!append && entry.snapshot.result) {
          // Replacement refreshes retain pages owned by this exact agent/filter scope.
          requestOptions.limit = Math.max(
            requestOptions.limit ?? DEFAULT_SESSION_LIST_QUERY.limit,
            entry.snapshot.result.sessions.length,
          );
        }
        entry.options = { ...requestOptions };
        delete entry.options.offset;
        publishFilteredList(entry, { ...entry.snapshot, loading: true, error: null });
        try {
          const result = await requestSessionList(scope.client, requestOptions);
          if (!isCurrent()) {
            return;
          }
          const previous = entry.snapshot.result;
          const decorated = host.decorate(
            result && append && requestOptions.offset && previous
              ? appendSessionResults(previous, result)
              : result,
          );
          if (append && decorated) {
            entry.options.limit = Math.max(
              entry.options.limit ?? DEFAULT_SESSION_LIST_QUERY.limit,
              decorated.sessions.length,
            );
          }
          publishFilteredList(entry, {
            result: decorated,
            agentId: entry.agentId,
            loading: false,
            error: null,
          });
        } catch (error) {
          if (!isCurrent()) {
            return;
          }
          publishFilteredList(entry, { ...entry.snapshot, loading: false, error: String(error) });
        }
        if (!isCurrent()) {
          return;
        }
        next = entry.queued;
        entry.queued = null;
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
    const result = await requestSessionList(scope.client, options);
    return host.connection.isCurrent(scope) ? host.decorate(result ?? null) : null;
  };

  const load = async (options: SessionRefreshOptions) => {
    const scope = host.connection.capture();
    if (!scope) {
      return;
    }
    const { append = false, force: _force, backgroundHydrate = false, ...requestOptions } = options;
    const durableListOptions: SessionListOptions = { ...requestOptions };
    // Pagination is request-local; replacements retain filters but restart at page one.
    delete durableListOptions.offset;
    if (!backgroundHydrate) {
      lastListOptions = durableListOptions;
      hasForegroundListOptions = true;
    } else if (!hasForegroundListOptions && !hasSeededListOptions) {
      lastListOptions = durableListOptions;
      hasSeededListOptions = true;
    }
    if (!backgroundHydrate) {
      const error = host.observerError();
      host.publish(
        { ...host.readState(), loading: true, error, deletedSessions: [] },
        error ? "session-observer" : undefined,
      );
    }
    try {
      const result = await requestSessionList(scope.client, requestOptions);
      if (!host.connection.isCurrent(scope)) {
        return;
      }
      const currentState = host.readState();
      let nextResult =
        result && append && requestOptions.offset && currentState.result
          ? appendSessionResults(currentState.result, result)
          : result;
      if (append && nextResult && !backgroundHydrate) {
        // Canonical event refreshes must retain all previously appended visible pages.
        lastListOptions = {
          ...durableListOptions,
          limit: Math.max(
            durableListOptions.limit ?? DEFAULT_SESSION_LIST_QUERY.limit,
            nextResult.sessions.length,
          ),
        };
      }
      if (backgroundHydrate && nextResult) {
        const snapshot = host.snapshot();
        const currentKey = snapshot.sessionKey?.trim();
        if (currentKey) {
          const currentAgentId = normalizeAgentId(
            parseAgentSessionKey(currentKey)?.agentId ?? resolveUiSelectedGlobalAgentId(snapshot),
          );
          const previousCurrentRow =
            currentState.result?.sessions.find((row) =>
              areUiSessionKeysEquivalent(row.key, currentKey),
            ) ??
            (currentState.agentId === currentAgentId
              ? currentState.result?.sessions.find((row) =>
                  uiSessionRowMatchesSelectedChat(snapshot, row.key, currentKey),
                )
              : undefined);
          if (
            previousCurrentRow &&
            !nextResult.sessions.some((row) =>
              uiSessionRowMatchesSelectedChat(snapshot, row.key, currentKey),
            )
          ) {
            const sessions = [...nextResult.sessions, previousCurrentRow];
            nextResult = { ...nextResult, count: sessions.length, sessions };
          }
        }
      }
      nextResult = host.decorate(nextResult);
      host.onCanonicalList(nextResult);
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
          sectionOrder: state.sectionOrder,
        },
        error ? "session-observer" : undefined,
      );
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        const state = host.readState();
        host.publish(
          {
            ...state,
            loading: backgroundHydrate ? state.loading : false,
            error: String(error),
            deletedSessions: [],
          },
          "operation",
        );
      }
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
    eventRefreshQueued = false;
    return { ...lastListOptions, force: true };
  };

  const drainRefreshQueue = async (options: SessionRefreshOptions) => {
    const scope = host.connection.capture();
    if (!scope) {
      return;
    }
    let next: SessionRefreshOptions | null = options;
    while (next) {
      await load(next);
      if (!host.connection.isCurrent(scope)) {
        return;
      }
      next = takeNextQueuedRefresh();
    }
  };

  const startRefresh = (options: SessionRefreshOptions) => {
    const request = drainRefreshQueue(options).finally(() => {
      if (inFlight === request) {
        inFlight = null;
      }
    });
    inFlight = request;
    return request;
  };

  const refresh = (options: SessionRefreshOptions = {}): Promise<void> => {
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
    return startRefresh(options);
  };

  const refreshFromEvent = () => {
    if (!host.connection.capture()) {
      return Promise.resolve();
    }
    if (inFlight) {
      eventRefreshQueued = true;
      return inFlight;
    }
    return startRefresh({ ...lastListOptions, force: true });
  };

  const eventRefreshCoordinator = createSessionEventRefreshCoordinator({
    canRefresh: () => host.connection.capture() !== null,
    refresh: refreshFromEvent,
  });
  const flushEventRefresh = () => eventRefreshCoordinator.flush();

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      flushEventRefresh();
    }
  };
  const observesPageLifecycle =
    typeof document !== "undefined" && typeof globalThis.addEventListener === "function";
  if (observesPageLifecycle) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    globalThis.addEventListener("pagehide", flushEventRefresh);
  }

  const refreshReplacement = (agentId?: string | null): Promise<void> => {
    const options = {
      ...lastListOptions,
      includeDerivedTitles: lastListOptions.includeDerivedTitles ?? true,
    };
    const normalizedAgentId = agentId?.trim();
    if (normalizedAgentId) {
      options.agentId = normalizedAgentId;
    }
    return refresh({ ...options, force: true });
  };

  return {
    list,
    listSnapshot(scope: SessionListScope): SessionListSnapshot {
      if (!scope.archivedFilter || scope.archivedFilter === "active") {
        const { result, agentId, loading, error } = host.readState();
        return { result, agentId, loading, error };
      }
      return (
        filteredLists.get(filteredListKey(scope))?.snapshot ?? {
          result: null,
          agentId: null,
          loading: false,
          error: null,
        }
      );
    },
    subscribeList(scope: SessionListScope, listener: (snapshot: SessionListSnapshot) => void) {
      const entry = filteredList(scope);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && filteredLists.get(entry.key) === entry) {
          entry.coordinator.dispose();
          filteredLists.delete(entry.key);
        }
      };
    },
    refreshList(options: SessionRefreshOptions = {}): Promise<void> {
      return !options.archivedFilter || options.archivedFilter === "active"
        ? refresh(options)
        : refreshFilteredList(options);
    },
    refresh,
    refreshReplacement,
    setCreatorFilter(creatorId: string | null) {
      const options = { ...lastListOptions, creatorId: creatorId?.trim() || undefined };
      delete options.offset;
      return refresh({ ...options, force: true });
    },
    lastOptions: () => lastListOptions,
    scheduleEvent(options: { agentId?: string | null; filtered?: boolean } = {}) {
      eventRefreshCoordinator.schedule();
      if (options.filtered === false) {
        return;
      }
      const agentId = options.agentId ? normalizeAgentId(options.agentId) : null;
      for (const entry of filteredLists.values()) {
        if (!agentId || entry.agentId === agentId) {
          entry.coordinator.schedule();
        }
      }
    },
    reset() {
      eventRefreshCoordinator.reset();
      inFlight = null;
      queuedExplicitRefresh = null;
      eventRefreshQueued = false;
      for (const entry of filteredLists.values()) {
        entry.coordinator.reset();
        entry.pending = entry.queued = null;
        entry.options = { agentId: entry.agentId, archivedFilter: entry.archivedFilter };
        if (entry.listeners.size === 0) {
          entry.coordinator.dispose();
          filteredLists.delete(entry.key);
          continue;
        }
        if (entry.snapshot.result || entry.snapshot.loading || entry.snapshot.error) {
          // Disconnect clears ownership once; reconnect must not flash preserved sidebar rows.
          publishFilteredList(entry, { result: null, agentId: null, loading: false, error: null });
        }
      }
    },
    dispose() {
      // Flush before disposal so page-exit events start the trailing canonical list.
      flushEventRefresh();
      eventRefreshCoordinator.dispose();
      if (observesPageLifecycle) {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        globalThis.removeEventListener("pagehide", flushEventRefresh);
      }
      inFlight = null;
      queuedExplicitRefresh = null;
      eventRefreshQueued = false;
      for (const entry of filteredLists.values()) {
        entry.coordinator.dispose();
        entry.listeners.clear();
      }
      filteredLists.clear();
    },
  };
}
