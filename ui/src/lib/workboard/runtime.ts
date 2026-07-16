import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { normalizeString, workboardCardSessionKey } from "./card-state.ts";
import { WORKBOARD_STATUSES, type WorkboardTaskLinkState, type WorkboardUiState } from "./types.ts";

export type WorkboardHost = object;

export type WorkboardLoadToken = {
  queuedAfterGeneration?: number;
};

type WorkboardLiveRefreshEntry = {
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
};

type WorkboardRuntime = {
  state?: WorkboardUiState;
  loadPromise?: Promise<boolean>;
  loadToken?: WorkboardLoadToken;
  loadError?: string;
  lifecycleTaskRefreshPromise?: Promise<number | null>;
  lifecycleWrites: Set<Promise<unknown>>;
  loadGeneration?: number;
  lifecycleReconciliationEpoch?: number;
  liveRefreshGeneration?: number;
  liveChangeEpoch?: string;
  liveHighestSeenRevision?: number;
  liveAppliedRevision?: number;
  liveRefreshPending?: boolean;
  liveRefreshPromise?: Promise<void>;
  taskPollOffset?: number;
  taskDiscoveryOffset?: number;
  defaultTaskDiscoveryCursor?: string;
  liveRefreshRetryTimer?: ReturnType<typeof setTimeout>;
  lifecycleTaskPreparedTimer?: ReturnType<typeof setTimeout>;
  lifecycleTaskRetryTimer?: ReturnType<typeof setTimeout>;
  lifecycleTaskContinuationTimer?: ReturnType<typeof setTimeout>;
  liveRefreshEntry?: WorkboardLiveRefreshEntry;
  pendingStatusTransitions: Set<string>;
  lifecycleSyncKeys: Map<string, string>;
};

const workboardRuntimes = new WeakMap<WorkboardHost, WorkboardRuntime>();
export const WORKBOARD_LIFECYCLE_TASK_CONFIRMATION_WINDOW_MS = 5000;
export const WORKBOARD_LIFECYCLE_TASK_CONFIRMATION_TIMEOUT_ERROR =
  "Task confirmation exceeded its freshness window.";
const WORKBOARD_LIFECYCLE_TASK_RETRY_MS = 5000;
const WORKBOARD_LIFECYCLE_TASK_CONTINUE_MS = 100;
const WORKBOARD_LIFECYCLE_TASK_RECONCILE_MS = 5000;

export function nextWorkboardLoadGeneration(host: WorkboardHost): number {
  const runtime = getWorkboardRuntime(host);
  const generation = (runtime.loadGeneration ?? 0) + 1;
  runtime.loadGeneration = generation;
  return generation;
}

export function isCurrentWorkboardLoadGeneration(host: WorkboardHost, generation: number): boolean {
  return getWorkboardRuntime(host).loadGeneration === generation;
}

function nextWorkboardLifecycleReconciliationEpoch(host: WorkboardHost): number {
  const runtime = getWorkboardRuntime(host);
  const epoch = (runtime.lifecycleReconciliationEpoch ?? 0) + 1;
  runtime.lifecycleReconciliationEpoch = epoch;
  return epoch;
}

export function currentWorkboardLifecycleReconciliationEpoch(host: WorkboardHost): number {
  return getWorkboardRuntime(host).lifecycleReconciliationEpoch ?? 0;
}

export function isCurrentWorkboardLifecycleReconciliationEpoch(
  host: WorkboardHost,
  epoch: number,
): boolean {
  return currentWorkboardLifecycleReconciliationEpoch(host) === epoch;
}

export function invalidateWorkboardLoads(host: WorkboardHost) {
  const runtime = getWorkboardRuntime(host);
  const state = runtime.state;
  if (state) {
    setWorkboardLifecycleTasksPrepared(state, false, { host });
    resetWorkboardLifecycleTaskConfirmations(state, { host });
    if (runtime.loadPromise) {
      if (!state.draftSaving) {
        state.loading = false;
      }
      if (!state.loaded) {
        state.loadAttempted = false;
      }
    }
  }
  nextWorkboardLoadGeneration(host);
  delete runtime.loadPromise;
  delete runtime.loadToken;
  nextWorkboardLifecycleReconciliationEpoch(host);
}

function clearWorkboardLifecycleTaskPreparedTimer(host: WorkboardHost) {
  const runtime = getWorkboardRuntime(host);
  const timer = runtime.lifecycleTaskPreparedTimer;
  if (timer) {
    clearTimeout(timer);
    delete runtime.lifecycleTaskPreparedTimer;
  }
}

function clearWorkboardLifecycleTaskRetryTimer(host: WorkboardHost) {
  const runtime = getWorkboardRuntime(host);
  const timer = runtime.lifecycleTaskRetryTimer;
  if (timer) {
    clearTimeout(timer);
    delete runtime.lifecycleTaskRetryTimer;
  }
}

function clearWorkboardLifecycleTaskContinuationTimer(host: WorkboardHost) {
  const runtime = getWorkboardRuntime(host);
  const timer = runtime.lifecycleTaskContinuationTimer;
  if (timer) {
    clearTimeout(timer);
    delete runtime.lifecycleTaskContinuationTimer;
  }
}

export function trackWorkboardLifecycleWrite(host: WorkboardHost, write: Promise<unknown>) {
  getWorkboardRuntime(host).lifecycleWrites.add(write);
}

export function releaseWorkboardLifecycleWrite(host: WorkboardHost, write: Promise<unknown>) {
  getWorkboardRuntime(host).lifecycleWrites.delete(write);
}

export async function waitForWorkboardLifecycleWrites(host: WorkboardHost) {
  while (true) {
    const writes = getWorkboardRuntime(host).lifecycleWrites;
    if (!writes.size) {
      return;
    }
    await Promise.allSettled(writes);
  }
}

export function resetWorkboardLifecycleTaskConfirmations(
  state: WorkboardUiState,
  options: { host?: WorkboardHost } = {},
) {
  state.lifecycleConfirmedTaskIds = new Set();
  state.lifecycleTaskConfirmationStartedAt = null;
  setWorkboardLifecycleTaskRefreshContinuation(state, false, options);
}

export function stopWorkboardLifecycleRefresh(host: WorkboardHost) {
  const runtime = getWorkboardRuntime(host);
  clearWorkboardLifecycleTaskPreparedTimer(host);
  clearWorkboardLifecycleTaskRetryTimer(host);
  clearWorkboardLifecycleTaskContinuationTimer(host);
  delete runtime.lifecycleTaskRefreshPromise;
  const state = runtime.state;
  if (state) {
    setWorkboardLifecycleTasksPrepared(state, false);
    setWorkboardLifecycleTaskRefreshFailed(state, false);
    state.lifecycleTaskRefreshError = null;
    resetWorkboardLifecycleTaskConfirmations(state, { host });
    // In-flight lifecycle writes clear themselves in finally. Keep them visible
    // so reconnect loads wait for their backend mutations before becoming writable.
    // Detach stale loads so reconnecting can start fresh without letting the
    // old request clear a concurrent draft-save loading state.
    if (!state.draftSaving) {
      state.loading = false;
    }
    // Keep cached cards visible across disconnects, but require a canonical
    // reload before accepting writes against data that may now be stale.
    state.mutationReadiness = "canonical_reload_required";
    state.loaded = false;
    state.loadAttempted = false;
  }
  nextWorkboardLoadGeneration(host);
  delete runtime.loadPromise;
  delete runtime.loadToken;
  nextWorkboardLifecycleReconciliationEpoch(host);
}

export function setWorkboardLifecycleTasksPrepared(
  state: WorkboardUiState,
  prepared: boolean,
  options: {
    host?: WorkboardHost;
    preparedAt?: number;
    requestUpdate?: () => void;
  } = {},
) {
  const preparedAt = options.preparedAt ?? Date.now();
  state.lifecycleTasksPrepared = prepared;
  state.lifecycleTasksPreparedAt = prepared ? preparedAt : null;
  const host = options.host;
  if (!host) {
    return;
  }
  clearWorkboardLifecycleTaskPreparedTimer(host);
  if (!prepared || !options.requestUpdate || !shouldRefreshWorkboardTasksForLifecycle(state)) {
    return;
  }
  const nextTimer = setTimeout(
    () => {
      delete getWorkboardRuntime(host).lifecycleTaskPreparedTimer;
      options.requestUpdate?.();
    },
    Math.max(0, preparedAt + WORKBOARD_LIFECYCLE_TASK_RECONCILE_MS - Date.now()),
  );
  getWorkboardRuntime(host).lifecycleTaskPreparedTimer = nextTimer;
}

export function workboardLifecycleTasksPreparedAt(state: WorkboardUiState, now = Date.now()) {
  if (!state.lifecycleTasksPrepared || state.lifecycleTasksPreparedAt === null) {
    return null;
  }
  if (now - state.lifecycleTasksPreparedAt >= WORKBOARD_LIFECYCLE_TASK_RECONCILE_MS) {
    return null;
  }
  return state.lifecycleTasksPreparedAt;
}

export function setWorkboardLifecycleTaskRefreshFailed(
  state: WorkboardUiState,
  failed: boolean,
  options: {
    host?: WorkboardHost;
    requestUpdate?: () => void;
    retryDelayMs?: number;
  } = {},
) {
  const retryDelayMs = options.retryDelayMs ?? WORKBOARD_LIFECYCLE_TASK_RETRY_MS;
  state.lifecycleTaskRefreshFailed = failed;
  state.lifecycleTaskRefreshRetryAt = failed ? Date.now() + retryDelayMs : null;
  const host = options.host;
  if (!host) {
    return;
  }
  clearWorkboardLifecycleTaskRetryTimer(host);
  if (!failed || !options.requestUpdate) {
    return;
  }
  const nextTimer = setTimeout(() => {
    delete getWorkboardRuntime(host).lifecycleTaskRetryTimer;
    options.requestUpdate?.();
  }, retryDelayMs);
  getWorkboardRuntime(host).lifecycleTaskRetryTimer = nextTimer;
}

export function setWorkboardLifecycleTaskRefreshContinuation(
  state: WorkboardUiState,
  pending: boolean,
  options: {
    host?: WorkboardHost;
    requestUpdate?: () => void;
  } = {},
) {
  state.lifecycleTaskRefreshContinueAt = pending
    ? Date.now() + WORKBOARD_LIFECYCLE_TASK_CONTINUE_MS
    : null;
  const host = options.host;
  if (!host) {
    return;
  }
  clearWorkboardLifecycleTaskContinuationTimer(host);
  if (!pending || !options.requestUpdate) {
    return;
  }
  // Continue bounded exact-confirmation independently from live card invalidation.
  const nextTimer = setTimeout(() => {
    delete getWorkboardRuntime(host).lifecycleTaskContinuationTimer;
    options.requestUpdate?.();
  }, WORKBOARD_LIFECYCLE_TASK_CONTINUE_MS);
  getWorkboardRuntime(host).lifecycleTaskContinuationTimer = nextTimer;
}

export function workboardLifecycleTaskRefreshRetryPending(
  state: WorkboardUiState,
  now = Date.now(),
) {
  return (
    state.lifecycleTaskRefreshFailed &&
    state.lifecycleTaskRefreshRetryAt !== null &&
    now < state.lifecycleTaskRefreshRetryAt
  );
}

export function workboardLifecycleTaskRefreshContinuationWaiting(
  state: WorkboardUiState,
  now = Date.now(),
) {
  return (
    state.lifecycleTaskRefreshContinueAt !== null && now < state.lifecycleTaskRefreshContinueAt
  );
}

function createDefaultState(): WorkboardUiState {
  return {
    loading: false,
    loaded: false,
    loadAttempted: false,
    mutationReadiness: "ready",
    error: null,
    cards: [],
    boards: [],
    statuses: WORKBOARD_STATUSES,
    tasksByCardId: new Map(),
    missingTaskIds: new Set(),
    lastDispatchSummary: null,
    dispatching: false,
    query: "",
    priorityFilter: "all",
    agentFilter: "all",
    boardFilter: "__all__",
    viewPreset: "all",
    activeHealthHighlight: null,
    showArchived: false,
    layout: "compact",
    hideEmptyColumns: false,
    lastRefreshAt: null,
    lastRefreshStartedAt: null,
    lastRefreshError: null,
    lastRefreshSource: null,
    lifecycleTasksPrepared: false,
    lifecycleTasksPreparedAt: null,
    lifecycleTaskRefreshFailed: false,
    lifecycleTaskRefreshRetryAt: null,
    lifecycleTaskRefreshContinueAt: null,
    lifecycleTaskRefreshError: null,
    lifecycleConfirmedTaskIds: new Set(),
    lifecycleTaskConfirmationStartedAt: null,
    draftOpen: false,
    draftSaving: false,
    editingCardId: null,
    draftTitle: "",
    draftNotes: "",
    draftStatus: "todo",
    draftPriority: "normal",
    draftLabels: "",
    draftAgentId: "",
    draftSessionKey: "",
    draftTemplateId: "",
    draftCommentBody: "",
    detailCardId: null,
    detailCommentBody: "",
    busyCardIds: new Set(),
    draggedCardId: null,
    syncingCardIds: new Set(),
    capturingSessionKeys: new Set(),
  };
}

export function getWorkboardRuntime(host: WorkboardHost): WorkboardRuntime {
  let runtime = workboardRuntimes.get(host);
  if (!runtime) {
    runtime = {
      lifecycleWrites: new Set(),
      pendingStatusTransitions: new Set(),
      lifecycleSyncKeys: new Map(),
    };
    workboardRuntimes.set(host, runtime);
  }
  return runtime;
}

export function getWorkboardState(host: WorkboardHost): WorkboardUiState {
  const runtime = getWorkboardRuntime(host);
  runtime.state ??= createDefaultState();
  return runtime.state;
}

export function workboardMutationsReady(state: WorkboardUiState): boolean {
  return state.mutationReadiness === "ready";
}

export function workboardHasActiveWrites(state: WorkboardUiState): boolean {
  return Boolean(
    state.draftSaving ||
    state.busyCardIds.size ||
    state.syncingCardIds.size ||
    state.capturingSessionKeys.size,
  );
}

function workboardHasActiveLoad(host: WorkboardHost): boolean {
  return Boolean(getWorkboardRuntime(host).loadPromise);
}

export function workboardLifecycleSyncBlocked(
  host: WorkboardHost,
  state: WorkboardUiState,
): boolean {
  return Boolean(
    state.draftOpen ||
    state.editingCardId ||
    state.draggedCardId ||
    state.dispatching ||
    workboardHasActiveWrites(state) ||
    workboardHasActiveLoad(host),
  );
}

export function workboardLifecycleRequiresTaskRefresh(state: WorkboardTaskLinkState): boolean {
  return (
    state.tasksByCardId.size > 0 ||
    state.cards.some((card) => {
      const taskId = normalizeString(card.taskId);
      return Boolean(taskId && !state.missingTaskIds.has(taskId));
    })
  );
}

export function shouldRefreshWorkboardTasksForLifecycle(state: WorkboardTaskLinkState): boolean {
  return (
    workboardLifecycleRequiresTaskRefresh(state) ||
    state.cards.some((card) => card.status === "running" && Boolean(workboardCardSessionKey(card)))
  );
}

export function workboardTaskLinksReadyForLifecycle(
  state: WorkboardTaskLinkState,
  options: { requireRunningTaskDiscovery?: boolean } = {},
): boolean {
  return state.cards.every((card) => {
    const taskId = normalizeString(card.taskId);
    if (taskId) {
      return state.missingTaskIds.has(taskId) || state.tasksByCardId.has(card.id);
    }
    return (
      !options.requireRunningTaskDiscovery ||
      card.status !== "running" ||
      !workboardCardSessionKey(card) ||
      state.tasksByCardId.has(card.id)
    );
  });
}
