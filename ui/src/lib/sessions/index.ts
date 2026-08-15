import type { SessionCatalogPullRequestSummary } from "../../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { GatewayRequestError, type GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import { scopedAgentListParamsForSession } from "./navigation.ts";
import {
  readSessionChangedEvent,
  reconcileSessionChanged,
  reconcileSessionHistory,
  reconcileSessionRunTerminal,
  type SessionChangedResult,
  type SessionReconcileOptions,
  type SessionRunTerminal,
} from "./reconcile.ts";
import type { SessionCapability, SessionGateway, SessionState } from "./session-capability.ts";
import { createSessionEventSubscriptionOwner } from "./session-event-subscription.ts";
import { createSessionGroupCatalog } from "./session-group-catalog.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionEventMatches,
} from "./session-key.ts";
import { createSessionMutations } from "./session-mutations.ts";
import { createSessionRosterRefresh } from "./session-roster-refresh.ts";
import { createSessionScopedOperations } from "./session-scoped-operations.ts";
import { SwarmActivityTracker } from "./swarm-activity.ts";

export {
  buildSessionUsageDateParams,
  requestSessionUsage,
  requestSessionUsageLogs,
  requestSessionUsageTimeSeries,
} from "./usage.ts";
export type { SessionArchivedFilter } from "./navigation.ts";
export type {
  SessionCapability,
  SessionListOptions,
  SessionListSnapshot,
  SessionMessageSubscription,
} from "./session-capability.ts";
export type { SessionPatch } from "./patch.ts";
export { DEFAULT_SESSION_LIST_QUERY } from "./session-requests.ts";
export { reconcileSessionRunTerminal, type SessionRunTerminal } from "./reconcile.ts";
export { requestSessionCreate } from "./create.ts";
export { resolveSessionKey } from "./navigation.ts";
export {
  compareSessionRowsByUpdatedAt,
  filterSessionRows,
  filterVisibleSessionRows,
  getVisibleSessionRows,
  isSystemCreatedSessionRow,
  resolveSessionNavigation,
  sessionMatchesArchivedFilter,
  scopedAgentIdForSession,
  scopedAgentListParamsForRefreshTarget,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "./navigation.ts";
export type {
  SessionRefreshTarget,
  SessionScopeHost,
  SessionScopeHostWithKey,
} from "./navigation.ts";

const SESSION_RETRY_DEFAULT_MS = 500;
const SESSION_RETRY_MIN_MS = 100;
const SESSION_RETRY_MAX_MS = 30_000;

function sessionRetryDelayMs(error: unknown): number | null {
  if (!(error instanceof GatewayRequestError) || !error.retryable) {
    return null;
  }
  const requested =
    typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
      ? error.retryAfterMs
      : SESSION_RETRY_DEFAULT_MS;
  return Math.min(Math.max(requested, SESSION_RETRY_MIN_MS), SESSION_RETRY_MAX_MS);
}

function isSessionStateEvent(event: GatewayEventFrame): boolean {
  return event.event === "sessions.changed" || event.event === "session.message";
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
    groupSettings: [],
    sectionOrder: [],
  };
  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  const swarmActivity = new SwarmActivityTracker();
  const pullRequestSummaries = new Map<string, SessionCatalogPullRequestSummary>();
  const pullRequestEpochs = new Map<string, symbol>();
  const listeners = new Set<(next: SessionState) => void>();
  const createdListeners = new Set<(key: string) => void>();
  let canonicalListRevision = 0;
  let hydratedClient: SessionGateway["snapshot"]["client"] = null;
  let connectionClient = gateway.snapshot.client;
  let sessionEventSubscriptionError: string | null = null;
  let publishedErrorSource: "session-observer" | "operation" | null = null;

  const publish = (next: SessionState, errorSource?: "session-observer" | "operation") => {
    if (next.error === null) {
      publishedErrorSource = null;
    } else if (errorSource || next.error !== state.error) {
      publishedErrorSource = errorSource ?? "operation";
    }
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  };

  const retirePullRequestSummary = (key: string) => {
    const normalizedKey = key.trim();
    pullRequestEpochs.delete(normalizedKey);
    pullRequestSummaries.delete(normalizedKey);
  };

  // Canonical Gateway rows are the source of truth for everything except the
  // UI-owned facts the capability keeps beside them, so every published result
  // passes through the same overlay: swarm notes, then in-flight pin intents.
  const decorateRows = (result: SessionsListResult | null): SessionsListResult | null =>
    mutations.applyConfirmedArchives(mutations.applyPendingPins(swarmActivity.decorate(result)));

  const roster = createSessionRosterRefresh({
    connection,
    snapshot: () => gateway.snapshot,
    readState: () => state,
    publish,
    observerError: () => sessionEventSubscriptionError,
    decorate: decorateRows,
    onCanonicalList(result) {
      mutations.settlePrepared(result);
      canonicalListRevision += 1;
    },
  });

  const sessionEventSubscription = createSessionEventSubscriptionOwner({
    isCurrent: (scope) => connection.isCurrent(scope),
    retryDelayMs: sessionRetryDelayMs,
    onError: (scope, error) => {
      if (!connection.isCurrent(scope)) {
        return;
      }
      const previousError = sessionEventSubscriptionError;
      sessionEventSubscriptionError = error;
      const observerOwnsVisibleError = publishedErrorSource === "session-observer";
      if (error !== null && (state.error === null || observerOwnsVisibleError)) {
        publish({ ...state, error }, "session-observer");
      } else if (error === null && observerOwnsVisibleError) {
        publish({ ...state, error: null });
      }
      if (previousError !== null && error === null) {
        // Observer outages do not replay events; one canonical list closes the gap.
        void roster.refresh({ ...roster.lastOptions(), backgroundHydrate: true, force: true });
      }
    },
  });

  const groups = createSessionGroupCatalog({
    connection,
    snapshot: () => gateway.snapshot,
    readState: () => state,
    publish,
    refreshRows: () => roster.refresh({ ...roster.lastOptions(), force: true }),
    retryDelayMs: sessionRetryDelayMs,
  });

  const mutations = createSessionMutations({
    connection,
    readState: () => state,
    publish,
    refreshReplacement: (agentId) => roster.refreshReplacement(agentId),
    publishedRow: (key) => roster.publishedRow(key),
    redecorateLists: () => roster.redecorateLists(),
    notifyCreated(key) {
      for (const listener of createdListeners) {
        listener(key);
      }
    },
    retirePullRequestSummary,
  });

  const operations = createSessionScopedOperations({
    connection,
    agentId: () => state.agentId,
    refreshReplacement: (agentId) => roster.refreshReplacement(agentId),
  });

  const pullRequestSummary = (key: string) => pullRequestSummaries.get(key.trim());

  const capturePullRequestEpoch = (key: string): symbol => {
    const normalizedKey = key.trim();
    const epoch = Symbol(normalizedKey);
    pullRequestEpochs.set(normalizedKey, epoch);
    return epoch;
  };

  const setPullRequestSummary = (
    key: string,
    summary: SessionCatalogPullRequestSummary | undefined,
    epoch?: symbol,
  ) => {
    const normalizedKey = key.trim();
    if (!normalizedKey || (epoch !== undefined && pullRequestEpochs.get(normalizedKey) !== epoch)) {
      return;
    }
    const previous = pullRequestSummaries.get(normalizedKey);
    const unchanged =
      previous?.state === summary?.state &&
      previous?.numbers.length === summary?.numbers.length &&
      previous?.numbers.every((number, index) => number === summary?.numbers[index]);
    if (unchanged || (!previous && !summary)) {
      return;
    }
    if (summary) {
      pullRequestSummaries.set(normalizedKey, summary);
    } else {
      pullRequestSummaries.delete(normalizedKey);
    }
    publish({ ...state });
  };

  const reconcile = (
    row: GatewaySessionRow | undefined,
    defaults?: SessionsListResult["defaults"],
    options?: SessionReconcileOptions,
  ): boolean => {
    const result = decorateRows(reconcileSessionHistory(state.result, row, defaults, options));
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

  const publishReconciledState = (next: SessionState) => {
    const operationOwnsError = publishedErrorSource === "operation";
    const error = operationOwnsError ? state.error : sessionEventSubscriptionError;
    publish(
      { ...next, error },
      error === null ? undefined : operationOwnsError ? "operation" : "session-observer",
    );
  };

  const reconcileChangedOptions = (
    payload: unknown,
    options?: SessionReconcileOptions,
  ): SessionReconcileOptions | undefined => {
    const eventInfo = readSessionChangedEvent(payload);
    const selectedSessionKey = gateway.snapshot.sessionKey?.trim();
    const archivesSelectedSession =
      eventInfo?.archived === true &&
      Boolean(
        selectedSessionKey &&
        uiSessionEventMatches(
          {
            assistantAgentId: gateway.snapshot.assistantAgentId,
            hello: gateway.snapshot.hello,
            sessionKey: selectedSessionKey,
          },
          eventInfo.key,
          eventInfo.agentId,
        ),
      );
    if (!archivesSelectedSession) {
      return options;
    }
    // The capability owns the shared roster, so every event consumer must
    // preserve the routed archive regardless of subscriber delivery order.
    return {
      ...options,
      archivedFilter: "all",
    };
  };

  const reconcileChangedEvent = (payload: unknown, options?: SessionReconcileOptions) => {
    const previous = state.result;
    const eventInfo = readSessionChangedEvent(payload);
    const reconciled = reconcileSessionChanged(
      previous,
      payload,
      reconcileChangedOptions(payload, options),
    );
    if (reconciled.result !== previous && reconciled.key && eventInfo) {
      mutations.observeArchiveState(reconciled.key, eventInfo.archived, reconciled.row);
    }
    return { eventInfo, reconciled };
  };

  const reconcileChanged = (
    payload: unknown,
    options?: SessionReconcileOptions,
  ): SessionChangedResult => {
    const { reconciled: base } = reconcileChangedEvent(payload, options);
    const result = decorateRows(base.result);
    const reconciled =
      result === base.result
        ? base
        : {
            ...base,
            result,
            row: base.row ? result?.sessions.find((row) => row.key === base.row?.key) : undefined,
          };
    if (reconciled.deletedKey) {
      retirePullRequestSummary(reconciled.deletedKey);
    }
    if (reconciled.applied && (reconciled.result !== state.result || reconciled.deletedKey)) {
      publishReconciledState({
        ...state,
        result: reconciled.result,
        agentId: options?.resultAgentId?.trim()
          ? normalizeAgentId(options.resultAgentId)
          : state.agentId,
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
    publishReconciledState({ ...state, result });
    return true;
  };

  const stopGateway = gateway.subscribe((next) => {
    const previousClient = connectionClient;
    const connected = next.phase === "connected";
    const connectionChanged = connection.transition(next);
    connectionClient = next.client;
    if (connectionChanged) {
      const hadPullRequestSummaries = pullRequestSummaries.size > 0;
      roster.reset();
      sessionEventSubscription.reset();
      sessionEventSubscriptionError = null;
      operations.retireConnection(previousClient);
      groups.invalidate();
      swarmActivity.clear();
      mutations.retireConnection();
      pullRequestSummaries.clear();
      pullRequestEpochs.clear();
      // Client replacement needs a publish; disconnect publishes cleared state below.
      if (hadPullRequestSummaries && connected && next.client) {
        publish({ ...state });
      }
    }
    if (!connected || !next.client) {
      hydratedClient = null;
      publish({
        result: null,
        agentId: null,
        modelOverrides: state.modelOverrides,
        loading: false,
        error: null,
        deletedSessions: [],
        groups: state.groups,
        groupSettings: state.groupSettings,
        sectionOrder: state.sectionOrder,
      });
      return;
    }
    if (hydratedClient !== next.client) {
      const scope = connection.capture();
      if (!scope) {
        return;
      }
      hydratedClient = scope.client;
      void (async () => {
        await sessionEventSubscription.ensure(scope);
        if (connection.isCurrent(scope)) {
          const sessionKey = gateway.snapshot.sessionKey?.trim();
          const agentScope = sessionKey
            ? scopedAgentListParamsForSession(gateway.snapshot, sessionKey)
            : { agentId: resolveUiSelectedGlobalAgentId(gateway.snapshot) };
          await roster.refresh({
            ...agentScope,
            includeDerivedTitles: true,
            includeLastMessage: true,
            backgroundHydrate: true,
            force: true,
          });
        }
      })();
    }
  });

  const stopEvents = gateway.subscribeEvents((event) => {
    if (!isSessionStateEvent(event)) {
      return;
    }
    swarmActivity.observe(event.payload);
    const decoratedResult = decorateRows(state.result);
    if (decoratedResult !== state.result) {
      publish({ ...state, result: decoratedResult });
    }
    const { eventInfo, reconciled } = reconcileChangedEvent(event.payload, {
      resultAgentId: state.agentId,
      archivedFilter: roster.lastOptions().archivedFilter,
    });
    if (eventInfo?.archived !== null) {
      const result = decorateRows(reconciled.result);
      if (result !== state.result) {
        publishReconciledState({ ...state, result });
      }
    }
    const eventReason = (event.payload as { reason?: unknown } | null)?.reason;
    const payloadAgentId = (event.payload as { agentId?: unknown } | null)?.agentId;
    if (eventReason === "groups") {
      groups.invalidate();
      void groups.load();
    }
    const hasActiveRun = reconciled.hasActiveRun ?? eventInfo?.hasActiveRun;
    const status = reconciled.status ?? eventInfo?.status;
    const runEnded =
      hasActiveRun === false || (status !== null && status !== undefined && status !== "running");
    if (event.event === "session.message" && !runEnded) {
      return;
    }
    if (reconciled.deletedKey) {
      retirePullRequestSummary(reconciled.deletedKey);
      publish({
        ...state,
        deletedSessions: [{ key: reconciled.deletedKey, agentId: reconciled.agentId ?? undefined }],
      });
    } else if ((eventReason === "create" || eventReason === "new") && eventInfo) {
      const remainingDeletedSessions = state.deletedSessions.filter(
        ({ key, agentId }) =>
          !uiSessionEventMatches(
            {
              assistantAgentId: agentId ?? gateway.snapshot.assistantAgentId,
              hello: gateway.snapshot.hello,
              sessionKey: key,
            },
            eventInfo.key,
            eventInfo.agentId,
          ),
      );
      if (remainingDeletedSessions.length !== state.deletedSessions.length) {
        publish({ ...state, deletedSessions: remainingDeletedSessions });
      }
    }
    // Gateway lists own filtering/order; events coalesce into one canonical refresh.
    roster.scheduleEvent({
      agentId:
        eventInfo?.agentId ??
        parseAgentSessionKey(eventInfo?.key)?.agentId ??
        (typeof payloadAgentId === "string" ? payloadAgentId : undefined),
      filtered: event.event === "sessions.changed",
    });
  });

  return {
    get state() {
      return state;
    },
    get canonicalListRevision() {
      return canonicalListRevision;
    },
    list: roster.list,
    listSnapshot: (scope) => roster.listSnapshot(scope),
    subscribeList(scope, listener) {
      if (scope.archivedFilter && scope.archivedFilter !== "active") {
        return roster.subscribeList(scope, listener);
      }
      const notify = () => listener(roster.listSnapshot(scope));
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    refreshList: (options) => roster.refreshList(options),
    setCreatorFilter: (creatorId) => roster.setCreatorFilter(creatorId),
    reconcile,
    reconcileChanged,
    reconcileRunTerminal,
    refresh: roster.refresh,
    refreshReplacement: roster.refreshReplacement,
    createResult: mutations.createResult,
    create: mutations.create,
    recover: mutations.recover,
    patch: mutations.patch,
    retireModelOverride: mutations.retireModelOverride,
    setModelOverride: mutations.setModelOverride,
    patchRowLocal: mutations.patchRowLocal,
    isPreparedWorkSession: mutations.isPreparedWorkSession,
    pullRequestSummary,
    capturePullRequestEpoch,
    setPullRequestSummary,
    delete: mutations.delete,
    deleteMany: mutations.deleteMany,
    reset: mutations.reset,
    compact: operations.compact,
    steer: operations.steer,
    listFiles: operations.listFiles,
    getFile: operations.getFile,
    setFile: operations.setFile,
    subscribeMessages: operations.subscribeMessages,
    unsubscribeMessages: operations.unsubscribeMessages,
    listCheckpoints: operations.listCheckpoints,
    branchCheckpoint: operations.branchCheckpoint,
    restoreCheckpoint: operations.restoreCheckpoint,
    rewind: operations.rewind,
    forkAtMessage: operations.forkAtMessage,
    listBranches: operations.listBranches,
    switchBranch: operations.switchBranch,
    groupsLoad: groups.load,
    groupsGeneration: groups.generation,
    groupsStatus: groups.status,
    groupsInvalidate: groups.invalidate,
    groupsPut: groups.put,
    groupsRename: groups.rename,
    groupsUpdate: groups.update,
    groupsDelete: groups.delete,
    subscribeCreated(listener) {
      createdListeners.add(listener);
      return () => createdListeners.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      roster.dispose();
      operations.dispose();
      connection.dispose();
      groups.dispose();
      hydratedClient = null;
      mutations.dispose();
      swarmActivity.clear();
      pullRequestSummaries.clear();
      pullRequestEpochs.clear();
      sessionEventSubscription.dispose();
      stopGateway();
      stopEvents();
      createdListeners.clear();
      listeners.clear();
    },
  };
}
