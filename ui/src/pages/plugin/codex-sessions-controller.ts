// Control UI controller for the Codex Sessions tab: actions, paging, and refresh polling.
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type CodexSessionPayload = {
  threadId: string;
  sessionId?: string;
  name?: string | null;
  cwd?: string;
  status: string;
  activeFlags?: string[];
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  source?: string;
  modelProvider?: string;
  cliVersion?: string;
  gitBranch?: string;
  openClawSessionKey?: string;
  archived: boolean;
};

export type CodexSessionHostPayload = {
  hostId: string;
  label: string;
  kind: "gateway" | "node";
  connected: boolean;
  nodeId?: string;
  endpointId?: string;
  sessions: CodexSessionPayload[];
  nextCursor?: string;
  backwardsCursor?: string;
  error?: { code: string; message: string };
};

export type CodexSessionsPayload = {
  hosts: CodexSessionHostPayload[];
};

export type CodexSessionsUiState = {
  hosts: CodexSessionHostPayload[];
  search: string;
  loading: boolean;
  activeLoadCount: number;
  loadingMoreHostIds: Set<string>;
  loadingMoreTokens: Map<string, object>;
  paginatedHostIds: Set<string>;
  error: string | null;
  refreshedAtMs: number | null;
  hasAttemptedLoad: boolean;
  needsRefreshOnBind: boolean;
  requestGeneration: number;
  searchTimer: ReturnType<typeof globalThis.setTimeout> | null;
  pollTimer: ReturnType<typeof globalThis.setTimeout> | null;
  pollRequestToken: object | null;
  pollClient: GatewayBrowserClient | null;
  requestUpdate: (() => void) | null;
  pendingSessionActions: Map<string, CodexSessionPendingAction>;
  archivedSessionKeys: Set<string>;
  actionError: string | null;
  actionGeneration: number;
};

export type CodexSessionPendingAction = "continue" | "archive";
export type CodexContinueDisposition = "existing" | "forked";
export type CodexContinueResult = {
  sessionKey: string;
  disposition?: CodexContinueDisposition;
};

const LIST_METHOD = "codex.sessions.list";
const CONTINUE_METHOD = "codex.sessions.continue";
const ARCHIVE_METHOD = "codex.sessions.archive";
const PAGE_SIZE = 40;
const POLL_INTERVAL_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 250;

const codexSessionStates = new WeakMap<object, CodexSessionsUiState>();

export function getCodexSessionsState(host: object): CodexSessionsUiState {
  let state = codexSessionStates.get(host);
  if (!state) {
    state = {
      hosts: [],
      search: "",
      loading: false,
      activeLoadCount: 0,
      loadingMoreHostIds: new Set(),
      loadingMoreTokens: new Map(),
      paginatedHostIds: new Set(),
      error: null,
      refreshedAtMs: null,
      hasAttemptedLoad: false,
      needsRefreshOnBind: false,
      requestGeneration: 0,
      searchTimer: null,
      pollTimer: null,
      pollRequestToken: null,
      pollClient: null,
      requestUpdate: null,
      pendingSessionActions: new Map(),
      archivedSessionKeys: new Set(),
      actionError: null,
      actionGeneration: 0,
    };
    codexSessionStates.set(host, state);
  }
  return state;
}

function notify(state: CodexSessionsUiState): void {
  state.requestUpdate?.();
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentQuery(state: CodexSessionsUiState) {
  const search = state.search.trim();
  return {
    ...(search ? { search } : {}),
    limitPerHost: PAGE_SIZE,
  };
}

function sessionActionKey(hostId: string, threadId: string): string {
  return JSON.stringify([hostId, threadId]);
}

export function getCodexSessionPendingAction(
  state: CodexSessionsUiState,
  hostId: string,
  threadId: string,
): CodexSessionPendingAction | undefined {
  return state.pendingSessionActions.get(sessionActionKey(hostId, threadId));
}

function filterCatalogSessions(
  state: CodexSessionsUiState,
  hosts: CodexSessionHostPayload[],
): CodexSessionHostPayload[] {
  return hosts.map((host) => ({
    ...host,
    sessions: host.sessions.filter(
      (session) =>
        !session.archived &&
        !state.archivedSessionKeys.has(sessionActionKey(host.hostId, session.threadId)),
    ),
  }));
}

function mergeRefreshedHosts(
  state: CodexSessionsUiState,
  refreshedHosts: CodexSessionHostPayload[],
): CodexSessionHostPayload[] {
  const currentById = new Map(state.hosts.map((host) => [host.hostId, host]));
  return refreshedHosts.map((refreshed) => {
    if (!state.paginatedHostIds.has(refreshed.hostId)) {
      return refreshed;
    }
    const current = currentById.get(refreshed.hostId);
    if (!current) {
      return refreshed;
    }
    const refreshedThreadIds = new Set(refreshed.sessions.map((session) => session.threadId));
    const retainedSessions = filterCatalogSessions(state, [current])[0]?.sessions ?? [];
    const sessions = refreshed.error
      ? retainedSessions
      : [
          ...refreshed.sessions,
          ...retainedSessions.filter((session) => !refreshedThreadIds.has(session.threadId)),
        ];
    // The retained tail belongs to the last page the user loaded. Its cursor
    // must stay paired with that tail or the next click would reload page two.
    return {
      ...refreshed,
      sessions,
      nextCursor: current.nextCursor,
    };
  });
}

function hasCatalogContext(state: CodexSessionsUiState): boolean {
  return (
    state.hasAttemptedLoad ||
    state.hosts.length > 0 ||
    state.error !== null ||
    state.refreshedAtMs !== null
  );
}

/** Catalog metadata never survives a tab or Gateway security-context teardown. */
function clearCatalogContext(state: CodexSessionsUiState): void {
  state.requestGeneration += 1;
  state.actionGeneration += 1;
  state.hosts = [];
  state.search = "";
  state.loading = false;
  state.loadingMoreHostIds = new Set();
  state.loadingMoreTokens = new Map();
  state.paginatedHostIds = new Set();
  state.error = null;
  state.refreshedAtMs = null;
  state.hasAttemptedLoad = false;
  state.pendingSessionActions = new Map();
  state.archivedSessionKeys = new Set();
  state.actionError = null;
}

/** Loads a fresh first page for every visible Codex host. */
export async function loadCodexSessions(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  options?: { preservePagination?: boolean; silent?: boolean },
): Promise<void> {
  if (!client) {
    return;
  }
  state.hasAttemptedLoad = true;
  state.activeLoadCount += 1;
  const generation = ++state.requestGeneration;
  // A fresh first page supersedes every older list/page request through the
  // generation check, so archive race tombstones are no longer needed. This
  // also lets a thread reappear after another Codex client unarchives it.
  state.archivedSessionKeys = new Set();
  if (!options?.silent || state.hosts.length === 0) {
    state.loading = true;
  }
  if (!options?.silent) {
    state.error = null;
    state.actionError = null;
  }
  notify(state);
  try {
    const result = await client.request<CodexSessionsPayload>(LIST_METHOD, currentQuery(state));
    if (generation !== state.requestGeneration) {
      return;
    }
    const visibleHosts = filterCatalogSessions(state, result.hosts);
    state.hosts = options?.preservePagination
      ? mergeRefreshedHosts(state, visibleHosts)
      : visibleHosts;
    if (options?.preservePagination) {
      const refreshedHostIds = new Set(result.hosts.map((host) => host.hostId));
      state.paginatedHostIds = new Set(
        [...state.paginatedHostIds].filter((hostId) => refreshedHostIds.has(hostId)),
      );
    } else {
      state.paginatedHostIds = new Set();
      state.loadingMoreHostIds = new Set();
      state.loadingMoreTokens = new Map();
    }
    state.error = null;
    state.refreshedAtMs = Date.now();
  } catch (error) {
    if (generation === state.requestGeneration) {
      state.error = messageForError(error);
    }
  } finally {
    state.activeLoadCount = Math.max(0, state.activeLoadCount - 1);
    if (generation === state.requestGeneration) {
      state.loading = false;
      notify(state);
    }
  }
}

/** Appends the next page for one host without disturbing the other host groups. */
export async function loadMoreCodexSessions(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  hostId: string,
): Promise<void> {
  const currentHost = state.hosts.find((host) => host.hostId === hostId);
  if (!client || !currentHost?.nextCursor || state.loadingMoreHostIds.has(hostId)) {
    return;
  }
  const generation = state.requestGeneration;
  const requestToken = {};
  state.activeLoadCount += 1;
  const loadingMoreHostIds = new Set(state.loadingMoreHostIds);
  loadingMoreHostIds.add(hostId);
  state.loadingMoreHostIds = loadingMoreHostIds;
  state.loadingMoreTokens.set(hostId, requestToken);
  notify(state);
  try {
    const result = await client.request<CodexSessionsPayload>(LIST_METHOD, {
      ...currentQuery(state),
      hostIds: [hostId],
      cursors: { [hostId]: currentHost.nextCursor },
    });
    if (generation !== state.requestGeneration) {
      return;
    }
    const page = filterCatalogSessions(state, result.hosts).find((host) => host.hostId === hostId);
    if (!page) {
      state.hosts = state.hosts.map((host) =>
        host.hostId === hostId
          ? {
              ...host,
              nextCursor: undefined,
              error: {
                code: "PAGE_LOAD_FAILED",
                message: "Session catalog host is no longer available",
              },
            }
          : host,
      );
      return;
    }
    const liveHost = state.hosts.find((host) => host.hostId === hostId);
    if (!liveHost) {
      return;
    }
    const retainedSessions = filterCatalogSessions(state, [liveHost])[0]?.sessions ?? [];
    const seenThreadIds = new Set(retainedSessions.map((session) => session.threadId));
    const appendedSessions = page.sessions.filter(
      (session) => !seenThreadIds.has(session.threadId),
    );
    state.hosts = state.hosts.map((host) =>
      host.hostId === hostId
        ? { ...page, sessions: [...retainedSessions, ...appendedSessions] }
        : host,
    );
    state.paginatedHostIds = new Set(state.paginatedHostIds).add(hostId);
  } catch (error) {
    if (generation === state.requestGeneration) {
      state.hosts = state.hosts.map((host) =>
        host.hostId === hostId
          ? { ...host, error: { code: "PAGE_LOAD_FAILED", message: messageForError(error) } }
          : host,
      );
    }
  } finally {
    state.activeLoadCount = Math.max(0, state.activeLoadCount - 1);
    if (state.loadingMoreTokens.get(hostId) === requestToken) {
      state.loadingMoreTokens.delete(hostId);
      const nextLoadingHostIds = new Set(state.loadingMoreHostIds);
      nextLoadingHostIds.delete(hostId);
      state.loadingMoreHostIds = nextLoadingHostIds;
      notify(state);
    }
  }
}

export function setCodexSessionsSearch(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  search: string,
): void {
  state.search = search;
  // Invalidate the in-flight request immediately; otherwise an old result can
  // briefly replace the list while the debounce window is still open.
  state.requestGeneration += 1;
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
  }
  state.searchTimer = setTimeout(() => {
    state.searchTimer = null;
    void loadCodexSessions(state, state.pollClient ?? client);
  }, SEARCH_DEBOUNCE_MS);
  notify(state);
}

function canRunSessionAction(
  state: CodexSessionsUiState,
  hostId: string,
  threadId: string,
  action: CodexSessionPendingAction,
): boolean {
  const host = state.hosts.find((candidate) => candidate.hostId === hostId);
  const session = host?.sessions.find((candidate) => candidate.threadId === threadId);
  if (!host?.connected || host.kind !== "gateway" || !session || session.archived) {
    return false;
  }
  const statusSupported =
    action === "continue" && Boolean(session.openClawSessionKey?.trim())
      ? true
      : session.status === "idle" || session.status === "notLoaded";
  return statusSupported;
}

function beginSessionAction(
  state: CodexSessionsUiState,
  hostId: string,
  threadId: string,
  action: CodexSessionPendingAction,
): { actionKey: string; generation: number } | null {
  const actionKey = sessionActionKey(hostId, threadId);
  if (state.pendingSessionActions.has(actionKey)) {
    return null;
  }
  state.pendingSessionActions = new Map(state.pendingSessionActions).set(actionKey, action);
  state.actionError = null;
  notify(state);
  return { actionKey, generation: state.actionGeneration };
}

function finishSessionAction(
  state: CodexSessionsUiState,
  actionKey: string,
  generation: number,
): void {
  if (state.actionGeneration !== generation) {
    return;
  }
  const pendingSessionActions = new Map(state.pendingSessionActions);
  pendingSessionActions.delete(actionKey);
  state.pendingSessionActions = pendingSessionActions;
  notify(state);
}

function removeSession(state: CodexSessionsUiState, hostId: string, threadId: string): void {
  state.hosts = state.hosts.map((host) =>
    host.hostId === hostId
      ? {
          ...host,
          sessions: host.sessions.filter((session) => session.threadId !== threadId),
        }
      : host,
  );
}

/** Opens existing supervision or a safe fork, then hands its OpenClaw session to Chat. */
export async function continueCodexSession(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  hostId: string,
  threadId: string,
  onContinue: (sessionKey: string) => void,
): Promise<void> {
  if (!client || !canRunSessionAction(state, hostId, threadId, "continue")) {
    return;
  }
  const pending = beginSessionAction(state, hostId, threadId, "continue");
  if (!pending) {
    return;
  }
  try {
    const result = await client.request<CodexContinueResult>(CONTINUE_METHOD, {
      hostId,
      threadId,
    });
    if (state.actionGeneration !== pending.generation) {
      return;
    }
    const sessionKey = result?.sessionKey?.trim();
    if (!sessionKey) {
      throw new Error("Codex continue response did not include a session key");
    }
    onContinue(sessionKey);
  } catch (error) {
    if (state.actionGeneration === pending.generation) {
      state.actionError = messageForError(error);
    }
  } finally {
    finishSessionAction(state, pending.actionKey, pending.generation);
  }
}

/** Archives optimistically while the catalog remains authoritative for rollback. */
export async function archiveCodexSession(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  hostId: string,
  threadId: string,
  confirmNoOtherRunner: boolean,
): Promise<void> {
  if (!client || !confirmNoOtherRunner) {
    return;
  }
  if (!canRunSessionAction(state, hostId, threadId, "archive")) {
    return;
  }
  const pending = beginSessionAction(state, hostId, threadId, "archive");
  if (!pending) {
    return;
  }
  try {
    const result = await client.request<{ archived: boolean }>(ARCHIVE_METHOD, {
      hostId,
      threadId,
      confirmNoOtherRunner: true,
    });
    if (!result?.archived) {
      throw new Error("Codex archive response did not confirm the archive");
    }
    if (state.actionGeneration === pending.generation) {
      // Keep a tombstone until the next fresh first-page request. An older list or page
      // request can otherwise resolve after the pending action clears and restore this row.
      state.archivedSessionKeys = new Set(state.archivedSessionKeys).add(pending.actionKey);
      removeSession(state, hostId, threadId);
    }
  } catch (error) {
    if (state.actionGeneration === pending.generation) {
      state.actionError = messageForError(error);
    }
  } finally {
    finishSessionAction(state, pending.actionKey, pending.generation);
  }
}

function clearPollTimer(state: CodexSessionsUiState): void {
  if (!state.pollTimer) {
    return;
  }
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

/** Completion-chained polling prevents slow app-server calls from overlapping the next cycle. */
function scheduleCodexSessionsPoll(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient,
): void {
  if (state.pollClient !== client || state.pollTimer || state.pollRequestToken) {
    return;
  }
  state.pollTimer = setTimeout(() => {
    state.pollTimer = null;
    if (state.pollClient !== client) {
      return;
    }
    if (state.activeLoadCount > 0) {
      scheduleCodexSessionsPoll(state, client);
      return;
    }
    const requestToken = {};
    state.pollRequestToken = requestToken;
    void loadCodexSessions(state, client, { preservePagination: true, silent: true }).finally(
      () => {
        if (state.pollRequestToken !== requestToken) {
          return;
        }
        state.pollRequestToken = null;
        scheduleCodexSessionsPoll(state, client);
      },
    );
  }, POLL_INTERVAL_MS);
}

/** Stops background work when the shared plugin page switches tabs. */
export function stopCodexSessionsPolling(host: object): void {
  const state = codexSessionStates.get(host);
  if (!state) {
    return;
  }
  if (state.pollTimer) {
    clearPollTimer(state);
  }
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
  }
  // A debounced search invalidates the active request before its replacement
  // starts. Leaving during that window must not strand the view in loading on
  // the next visit, and late pages must not mutate the detached tab.
  clearCatalogContext(state);
  state.needsRefreshOnBind = false;
  state.pollRequestToken = null;
  state.pollClient = null;
  state.requestUpdate = null;
}

export function configureCodexSessionsPolling(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  active: boolean,
): void {
  if (!active || !client) {
    const refreshOnNextBind = state.needsRefreshOnBind || hasCatalogContext(state);
    clearPollTimer(state);
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
      state.searchTimer = null;
    }
    clearCatalogContext(state);
    state.needsRefreshOnBind = refreshOnNextBind;
    state.pollRequestToken = null;
    state.pollClient = null;
    return;
  }
  if ((state.pollTimer || state.pollRequestToken) && state.pollClient === client) {
    return;
  }
  const clientChanged = state.pollClient !== null && state.pollClient !== client;
  const refreshOnRebind = state.needsRefreshOnBind || (clientChanged && hasCatalogContext(state));
  if (clientChanged && state.searchTimer) {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
  }
  if (clientChanged) {
    clearCatalogContext(state);
    state.pollRequestToken = null;
  }
  clearPollTimer(state);
  state.pollClient = client;
  state.needsRefreshOnBind = false;
  scheduleCodexSessionsPoll(state, client);
  if (refreshOnRebind) {
    void loadCodexSessions(state, client);
  }
}
