import type { SessionCatalogPullRequestSummary } from "../../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import type { SessionCreateOutcome } from "./create.ts";
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
import { createSessionDeletions } from "./session-deletions.ts";
import { createSessionEventSubscriptionOwner } from "./session-event-subscription.ts";
import { createSessionGitHubPublication } from "./session-github-publication.ts";
import { createSessionGroupCatalog } from "./session-group-catalog.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionEventMatches,
} from "./session-key.ts";
import { createSessionMutations } from "./session-mutations.ts";
import { createSessionPermissionProjection } from "./session-permission-projection.ts";
import { createSessionRosterRefresh } from "./session-roster-refresh.ts";
import { createSessionScopedOperations } from "./session-scoped-operations.ts";
import { SwarmActivityTracker } from "./swarm-activity.ts";

export type { SessionArchivedFilter } from "./navigation.ts";
export type {
  SessionCapability,
  SessionListOptions,
  SessionListSnapshot,
  SessionMessageSubscription,
} from "./session-capability.ts";
export type { SessionPatch, SessionPatchResult } from "./patch.ts";
export { DEFAULT_SESSION_LIST_QUERY, SESSIONS_PAGE_DEFAULT_LIMIT } from "./session-requests.ts";
export { reconcileSessionRunTerminal, type SessionRunTerminal } from "./reconcile.ts";
export { resolveSessionKey } from "./navigation.ts";
export {
  compareSessionRowsByUpdatedAt,
  filterSessionRows,
  filterVisibleSessionRows,
  getVisibleSessionRows,
  isSystemCreatedSessionRow,
  resolveSessionNavigation,
  sessionMatchesArchivedFilter,
  sessionMatchesVisibleSessionScope,
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

type SessionAgentSelection = {
  readonly state: { readonly selectedId: string | null };
  subscribe: (listener: () => void) => () => void;
};

export function createSessionCapability(
  gateway: SessionGateway,
  agentSelection: SessionAgentSelection,
): SessionCapability {
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
  const githubPublication = createSessionGitHubPublication({
    connection,
    snapshot: () => gateway.snapshot,
    deletionState: (row) => deletions.deletionState(row.key, row.agentId, row.sessionId),
  });
  const swarmActivity = new SwarmActivityTracker();
  const pullRequestSummaries = new Map<string, SessionCatalogPullRequestSummary>();
  const pullRequestEpochs = new Map<string, object>();
  const listeners = new Set<(next: SessionState) => void>();
  const createdListeners = new Set<(key: string) => void>();
  const thinkingLevelClaims = new Map<
    string,
    | readonly [value: string, updatedAt: number]
    | readonly [value: string, updatedAt: undefined, afterRevision: number]
  >();
  let canonicalListRevision = 0;
  let hydratedClient: SessionGateway["snapshot"]["client"] = null;
  let hydratedSelfUserId: string | null = null;
  let connectionClient = gateway.snapshot.client;
  let selectedAgentId = agentSelection.state.selectedId;
  let sessionEventSubscriptionError: string | null = null;
  let publishedErrorSource: "session-observer" | "operation" | null = null;

  const sessionClaimKey = (key: string, agentId?: string | null) => {
    const ownerAgentId =
      parseAgentSessionKey(key)?.agentId ??
      agentId ??
      resolveUiSelectedGlobalAgentId(gateway.snapshot);
    return `${normalizeSessionKeyForUiComparison(key)}\0agent:${normalizeAgentId(ownerAgentId)}`;
  };

  const settleThinkingLevelClaim = (
    row: GatewaySessionRow,
    requestRevision: number,
    agentId?: string,
  ) => {
    const key = sessionClaimKey(row.key, agentId);
    const claim = thinkingLevelClaims.get(key);
    const newer =
      claim?.[1] !== undefined
        ? (row.updatedAt ?? -1) > claim[1]
        : claim !== undefined && requestRevision > claim[2];
    if (claim && (row.thinkingLevel === claim[0] || newer)) {
      thinkingLevelClaims.delete(key);
    }
  };

  const publish = (next: SessionState, errorSource?: "session-observer" | "operation") => {
    if (next.error === null) {
      publishedErrorSource = null;
    } else if (errorSource || next.error !== state.error) {
      publishedErrorSource = errorSource ?? "operation";
    }
    state = next;
    githubPublication.observeRows(next.result?.sessions ?? [], next.agentId);
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
  // passes through the same overlay: swarm notes, then in-flight row intents.
  const decorateRows = (
    result: SessionsListResult | null,
    owner = roster.primaryList(),
  ): SessionsListResult | null =>
    deletions.apply(
      mutations.applyConfirmedArchives(mutations.applyPendingRows(swarmActivity.decorate(result))),
      owner,
    );

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
        // Observer outages do not replay events; every held query must close the gap.
        void roster.refresh({ ...roster.lastOptions(), backgroundHydrate: true, force: true });
        roster.invalidateManagedLists();
      }
    },
  });

  const permissions = createSessionPermissionProjection(gateway, () => roster);

  const roster = createSessionRosterRefresh({
    connection,
    snapshot: () => gateway.snapshot,
    readState: () => state,
    publish,
    observerError: () => sessionEventSubscriptionError,
    bootstrap: (scope, list) => sessionEventSubscription.ensure(scope, list),
    decorate: decorateRows,
    reconcileList: (result, revision, agentId) =>
      permissions.reconcileList(
        deletions.reconcileList(result, revision, agentId),
        revision,
        agentId,
      ),
    onCanonicalList(result, requestRevision, agentId, observed) {
      githubPublication.observeRows(observed?.sessions ?? result?.sessions ?? [], agentId);
      mutations.settlePrepared(result);
      for (const row of observed?.sessions ?? []) {
        settleThinkingLevelClaim(row, requestRevision, agentId);
      }
      canonicalListRevision += 1;
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

  const notifyCreated = (key: string, entry?: SessionCreateOutcome["entry"], agentId?: string) => {
    if (typeof entry?.thinkingLevel === "string" && typeof entry.updatedAt === "number") {
      thinkingLevelClaims.set(sessionClaimKey(key, agentId), [
        entry.thinkingLevel,
        entry.updatedAt,
      ]);
    }
    for (const listener of createdListeners) {
      listener(key);
    }
  };

  const mutations = createSessionMutations({
    connection,
    readState: () => state,
    publish,
    refreshReplacement: roster.refreshReplacement,
    refreshReplacementResult: roster.refreshReplacementResult,
    publishedRow: (key) => roster.publishedRow((row) => row.key === key),
    redecorateLists: () => roster.redecorateLists(),
    notifyCreated,
    clearThink: (key, agentId) => thinkingLevelClaims.delete(sessionClaimKey(key, agentId)),
    claimPermissionProjection: permissions.claim,
    retirePullRequestSummary,
  });

  const deletions = createSessionDeletions({
    connection,
    snapshot: () => gateway.snapshot,
    requestRevision: () => roster.requestRevision,
    readState: () => state,
    publish,
    publishedRow: (matches) => roster.publishedRow(matches),
    redecorateLists: () => roster.redecorateLists(),
    invalidateLists: () => roster.scheduleEvent(),
    refreshReplacement: roster.refreshReplacement,
    reconcilePreviousConnection: mutations.reconcileConfirmedPreviousConnection,
    retire: mutations.retireDeletedSession,
  });

  const operations = createSessionScopedOperations({
    connection,
    agentId: () => state.agentId,
    refreshReplacement: roster.refreshReplacement,
    notifyCreated,
    reportError: (error) => publish({ ...state, error: formatUiError(error) }, "operation"),
  });

  const pullRequestSummary = (key: string) => pullRequestSummaries.get(key.trim());

  const capturePullRequestEpoch = (key: string): object => {
    const epoch = {};
    pullRequestEpochs.set(key.trim(), epoch);
    return epoch;
  };

  const setPullRequestSummary = (
    key: string,
    summary: SessionCatalogPullRequestSummary | undefined,
    epoch?: object,
  ) => {
    const normalizedKey = key.trim();
    if (!normalizedKey || (epoch !== undefined && pullRequestEpochs.get(normalizedKey) !== epoch)) {
      return;
    }
    if (pullRequestSummaries.get(normalizedKey) === summary) {
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
    options?: SessionReconcileOptions & { sourceCanonicalListRevision?: number },
  ): boolean => {
    const historyAgentId =
      row?.agentId ??
      (isUiGlobalSessionKey(row?.key) ? options?.selectedGlobalAgentId : undefined) ??
      options?.resultAgentId ??
      state.agentId;
    if (
      row &&
      (!deletions.acceptsGeneration(row.key, row.sessionId, historyAgentId) ||
        deletions.deletionState(row.key, historyAgentId, row.sessionId))
    ) {
      return false;
    }
    const { sourceCanonicalListRevision, ...historyOptions } = options ?? {};
    const preserveCanonicalRow =
      sourceCanonicalListRevision !== undefined &&
      canonicalListRevision > sourceCanonicalListRevision;
    const result = decorateRows(
      reconcileSessionHistory(state.result, row, defaults, historyOptions, preserveCanonicalRow),
    );
    if (row && !preserveCanonicalRow) {
      githubPublication.observeRows([row], historyAgentId);
    }
    const agentId = options?.resultAgentId?.trim()
      ? normalizeAgentId(options.resultAgentId)
      : state.agentId;
    // Ownership can change without changing any rows; subscribers need both.
    if (result === state.result && agentId === state.agentId) {
      return true;
    }
    publish({
      ...state,
      result,
      agentId,
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

  const reconcileChangedEvent = (payload: unknown, options?: SessionReconcileOptions) => {
    const previous = state.result;
    const eventInfo = readSessionChangedEvent(payload);
    if (
      eventInfo &&
      !deletions.acceptsGeneration(
        eventInfo.key,
        eventInfo.sessionId,
        eventInfo.agentId ?? state.agentId,
      )
    ) {
      const reconciled: SessionChangedResult = { applied: false, result: previous };
      return { eventInfo: null, reconciled, claimChanged: false };
    }
    githubPublication.observeEvent(payload);
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
    // The capability owns the shared roster, so every event consumer must
    // preserve the routed archive regardless of subscriber delivery order.
    const reconcileOptions = archivesSelectedSession
      ? { ...options, archivedFilter: "all" as const }
      : options;
    let reconciled = reconcileSessionChanged(previous, payload, reconcileOptions);
    if (eventInfo?.hasPermissionMode) {
      reconciled = permissions.observeEvent(
        reconciled,
        previous,
        payload,
        eventInfo,
        state.agentId,
      );
    }
    let claimChanged = false;
    if (reconciled.applied && reconciled.key && eventInfo) {
      const claimKey = sessionClaimKey(reconciled.key, eventInfo.agentId);
      const claim = thinkingLevelClaims.get(claimKey);
      const thinkingLevel = eventInfo.thinkingLevel;
      const eventIsCurrent =
        eventInfo.updatedAt === null || claim?.[1] === undefined || eventInfo.updatedAt >= claim[1];
      const removesRow = reconciled.deletedKey || (eventInfo.archived === true && !reconciled.row);
      if (claim && eventIsCurrent && removesRow) {
        claimChanged = thinkingLevelClaims.delete(claimKey);
      } else if (claim && eventIsCurrent && !reconciled.row && typeof thinkingLevel === "string") {
        const nextClaim =
          eventInfo.updatedAt === null
            ? ([thinkingLevel, undefined, roster.requestRevision] as const)
            : ([thinkingLevel, eventInfo.updatedAt] as const);
        claimChanged =
          claim[0] !== nextClaim[0] || claim[1] !== nextClaim[1] || claim[2] !== nextClaim[2];
        if (claimChanged) {
          thinkingLevelClaims.set(claimKey, nextClaim);
        }
      } else if (claim && eventIsCurrent && thinkingLevel !== undefined) {
        claimChanged = thinkingLevelClaims.delete(claimKey);
      }
    }
    if (reconciled.result !== previous && reconciled.key && eventInfo) {
      mutations.observeArchiveState(reconciled.key, eventInfo.archived, reconciled.row);
    }
    if (
      eventInfo &&
      (eventInfo.reason !== "delete" || reconciled.deletedKey || !eventInfo.sessionId)
    ) {
      deletions.observe(eventInfo);
    }
    return { eventInfo, reconciled, claimChanged };
  };

  const reconcileChanged = (
    payload: unknown,
    options?: SessionReconcileOptions,
  ): SessionChangedResult => {
    const { reconciled: base, claimChanged } = reconcileChangedEvent(payload, options);
    const result = decorateRows(base.result);
    const reconciled =
      result === base.result
        ? base
        : {
            ...base,
            result,
            row: base.row ? result?.sessions.find((row) => row.key === base.row?.key) : undefined,
          };
    if (
      claimChanged ||
      (reconciled.applied && (reconciled.result !== state.result || reconciled.deletedKey))
    ) {
      publishReconciledState({
        ...state,
        result: reconciled.result,
        agentId: options?.resultAgentId?.trim()
          ? normalizeAgentId(options.resultAgentId)
          : state.agentId,
      });
    }
    return reconciled;
  };

  const reconcileRunTerminal = (terminal: SessionRunTerminal): boolean => {
    for (const key of terminal.sessionKeys) {
      if (key.trim()) {
        roster.invalidateManagedLists(parseAgentSessionKey(key)?.agentId);
      }
    }
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
    const selfUserId = next.selfUser?.id.trim() || null;
    const connectionChanged = connection.transition(next);
    connectionClient = next.client;
    githubPublication.observeRows([]);
    if (connectionChanged) {
      if (previousClient !== next.client) {
        deletions.clear();
      }
      const hadPullRequestSummaries = pullRequestSummaries.size > 0;
      thinkingLevelClaims.clear();
      permissions.clear();
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
      hydratedSelfUserId = null;
      publish({
        ...state,
        result: null,
        agentId: null,
        loading: false,
        error: null,
        deletedSessions: [],
      });
      return;
    }
    const hydrateConnection = hydratedClient !== next.client;
    if (hydrateConnection || hydratedSelfUserId !== selfUserId) {
      const scope = connection.capture();
      if (!scope) {
        return;
      }
      hydratedClient = scope.client;
      hydratedSelfUserId = selfUserId;
      if (!hydrateConnection) {
        // Identity updates refresh the current roster without displacing queued picker intent.
        roster.scheduleEvent();
        return;
      }
      const hydrate = async () => {
        if (connection.isCurrent(scope)) {
          await roster.bootstrap({
            ...roster.lastOptions(), // Keep visible roster filters through reconnect hydration.
            agentId: agentSelection.state.selectedId ?? undefined,
            includeDerivedTitles: true,
            includeLastMessage: true,
            backgroundHydrate: true,
            force: true,
          });
          if (connection.isCurrent(scope)) {
            await roster.refreshManagedLists();
          }
        }
      };
      void hydrate().catch(() => undefined);
    }
  });

  const stopSelection = agentSelection.subscribe(() => {
    const nextAgentId = agentSelection.state.selectedId;
    if (selectedAgentId === nextAgentId) {
      return;
    }
    selectedAgentId = nextAgentId;
    // Selection publishes before Gateway hydration. A new connection bootstraps
    // the current selection; route changes on a hydrated connection replace its roster.
    if (nextAgentId && hydratedClient === gateway.snapshot.client) {
      void roster.refreshReplacement(nextAgentId);
    }
  });

  const stopEvents = gateway.subscribeEvents((event) => {
    if (event.event !== "sessions.changed" && event.event !== "session.message") {
      return;
    }
    if (swarmActivity.observe(event.payload)) {
      const decoratedResult = decorateRows(state.result);
      if (decoratedResult !== state.result) {
        publish({ ...state, result: decoratedResult });
      }
    }
    const { eventInfo, reconciled, claimChanged } = reconcileChangedEvent(event.payload, {
      resultAgentId: state.agentId,
      archivedFilter: roster.lastOptions().archivedFilter,
    });
    const payload = event.payload as {
      agentId?: unknown;
      reason?: unknown;
      session?: unknown;
    } | null;
    const hasActiveRun = reconciled.hasActiveRun ?? eventInfo?.hasActiveRun;
    const status = reconciled.status ?? eventInfo?.status;
    const runEnded =
      hasActiveRun === false || (status !== null && status !== undefined && status !== "running");
    const isTerminalMessage = event.event === "session.message" && runEnded;
    // Only an existing Gateway roster member that remains active can be replaced directly.
    const primarySnapshotApplied =
      isTerminalMessage &&
      reconciled.applied &&
      eventInfo !== null &&
      eventInfo.archived !== true &&
      typeof payload?.session === "object" &&
      payload.session !== null &&
      roster.canApplyPrimarySnapshot() &&
      state.result?.sessions.some((row) =>
        uiSessionEventMatches(
          { ...gateway.snapshot, sessionKey: row.key },
          eventInfo.key,
          eventInfo.agentId,
        ),
      ) === true;
    if (
      claimChanged ||
      (eventInfo?.archived !== null && !isTerminalMessage) ||
      primarySnapshotApplied
    ) {
      const result = decorateRows(reconciled.result);
      if (claimChanged || result !== state.result) {
        publishReconciledState({ ...state, result });
      }
    }
    const eventReason = payload?.reason;
    const payloadAgentId = payload?.agentId;
    if (eventReason === "groups") {
      groups.invalidate();
      void groups.load();
    }
    if (event.event === "session.message" && !runEnded) {
      return;
    }
    roster.scheduleEvent({
      agentId:
        eventInfo?.agentId ??
        parseAgentSessionKey(eventInfo?.key)?.agentId ??
        (typeof payloadAgentId === "string" ? payloadAgentId : undefined),
      primarySnapshotApplied,
    });
  });

  return {
    get state() {
      return state;
    },
    get canonicalListRevision() {
      return canonicalListRevision;
    },
    githubPublication,
    captureConnectionScope: () => connection.capture(),
    isConnectionScopeCurrent: (scope) => connection.isCurrent(scope),
    list: roster.list,
    observeList: roster.observeList,
    listSnapshot: (scope) => roster.listSnapshot(scope),
    subscribeList(scope, listener) {
      if (!roster.isPrimaryList(scope)) {
        return roster.subscribeList(scope, listener);
      }
      const notify = () => listener(roster.listSnapshot(scope));
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    refreshList: (options) => roster.refreshList(options),
    reconcile,
    reconcileChanged,
    reconcileRunTerminal,
    refresh: roster.refresh,
    refreshReplacement: roster.refreshReplacement,
    createResult: mutations.createResult,
    create: mutations.create,
    recover: operations.recover,
    patch: mutations.patch,
    archiveVisibility: mutations.archiveVisibility,
    setArchivePending: mutations.setArchivePending,
    assignOwner: mutations.assignOwner,
    retireModelOverride: mutations.retireModelOverride,
    think: (key, agentId) => thinkingLevelClaims.get(sessionClaimKey(key, agentId))?.[0],
    patchRowLocal: mutations.patchRowLocal,
    isPreparedWorkSession: mutations.isPreparedWorkSession,
    pullRequestSummary,
    capturePullRequestEpoch,
    setPullRequestSummary,
    delete: deletions.delete,
    deleteMany: deletions.deleteMany,
    deletionState: deletions.deletionState,
    reset: mutations.reset,
    compact: operations.compact,
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
      githubPublication.clear();
      roster.dispose();
      operations.dispose();
      connection.dispose();
      groups.dispose();
      hydratedClient = null;
      hydratedSelfUserId = null;
      mutations.dispose();
      permissions.clear();
      deletions.clear();
      swarmActivity.clear();
      pullRequestSummaries.clear();
      pullRequestEpochs.clear();
      sessionEventSubscription.dispose();
      stopGateway();
      stopSelection();
      stopEvents();
      createdListeners.clear();
      listeners.clear();
    },
  };
}
