import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import { hasOperatorWriteAccess } from "../../../app/operator-access.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import type { SessionScopeHost } from "../../../lib/sessions/index.ts";
import {
  canonicalUiSessionKeyForPersistence,
  parseAgentSessionKey,
  resolveUiConversationIdentity,
} from "../../../lib/sessions/session-key.ts";
import {
  applyTaskEvent,
  isActiveTask,
  mergeTaskLists,
  normalizeTaskEventPayload,
  normalizeTasksCancelResult,
  normalizeTasksGetResult,
  normalizeTasksListResult,
  sortTasks,
  taskTimestampMs,
} from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { newestTaskSnapshot } from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { deriveSubagentActivity } from "./chat-subagent-activity.ts";
import { observeTaskDetailEvent } from "./chat-task-detail-state.ts";

type BackgroundTaskLoadEvent = NonNullable<ReturnType<typeof normalizeTaskEventPayload>>;

type BackgroundTaskEventBuffer = {
  requestId: number;
  events: BackgroundTaskLoadEvent[];
};

type BackgroundTasksState = {
  cancellingTaskIds: Set<string>;
  collapsed: boolean;
  connectionClient: GatewayBrowserClient | null;
  connectionEpoch: number | undefined;
  error: string | null;
  finishedCollapsed: boolean;
  // Loads are keyed to the client so a reconnect (or gateway switch) refreshes
  // the snapshot instead of trusting the previous connection's task list.
  loadedClient: GatewayBrowserClient | null;
  loading: boolean;
  pendingTaskEvents: BackgroundTaskEventBuffer | null;
  pendingReload: boolean;
  requestId: number;
  sessionKey: string;
  agentId?: string;
  // wa-tooltip anchors by document id, so the status row's id must stay unique
  // per pane: two panes on the same agent would otherwise cross-anchor.
  statusRowId: string;
  subagentActivityExpiryAt: number | null;
  subagentActivityExpiryTimer: number | null;
  taskActivityById: Map<string, Pick<TaskSummary, "lastActivity" | "diffStat">>;
  terminalObservedAtByTask: Map<string, number>;
  tasks: TaskSummary[] | null;
  taskDetails: Map<string, TaskSummary>;
  taskDetailErrors: Map<string, string>;
  taskDetailLoadingIds: Set<string>;
};

export type BackgroundTasksHost = {
  sessionKey: string;
  assistantAgentId?: string | null;
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch?: number;
  hello: GatewayHelloOk | null;
  agentsList?: SessionScopeHost["agentsList"];
  backgroundTasksState?: BackgroundTasksState;
  requestUpdate?: () => void;
};

// The chat rail stays bounded to its session while the full Tasks page drains
// every active page. A separate active query still keeps long-running work
// from hiding behind newer terminal records here.
const ACTIVE_TASKS_LIMIT = 200;
const RECENT_TASKS_LIMIT = 100;

let nextStatusRowId = 0;

function getBackgroundTasksState(host: BackgroundTasksHost): BackgroundTasksState {
  const { sessionKey, agentId } = resolveUiConversationIdentity(host, host.sessionKey);
  const current = host.backgroundTasksState;
  if (
    current?.sessionKey === sessionKey &&
    current.agentId === agentId &&
    current.connectionClient === host.client &&
    current.connectionEpoch === host.connectionEpoch
  ) {
    return current;
  }
  if (
    current?.subagentActivityExpiryTimer !== null &&
    current?.subagentActivityExpiryTimer !== undefined
  ) {
    window.clearTimeout(current.subagentActivityExpiryTimer);
  }
  nextStatusRowId += 1;
  const next: BackgroundTasksState = {
    cancellingTaskIds: new Set(),
    // Keep presentation choices across thread switches while discarding all
    // task data and private details from the previous session scope.
    collapsed: current?.collapsed ?? true,
    // The pane increments this epoch even when a reconnect reuses its client.
    // Old snapshots and private task details must never enter the new scope.
    connectionClient: host.client,
    connectionEpoch: host.connectionEpoch,
    error: null,
    // Finished history starts collapsed so active work owns the rail; the
    // section header still shows the count for discoverability.
    finishedCollapsed: current?.finishedCollapsed ?? true,
    loadedClient: null,
    loading: false,
    pendingTaskEvents: null,
    pendingReload: false,
    requestId: 0,
    sessionKey,
    agentId,
    statusRowId: `chat-tasks-status-${nextStatusRowId}`,
    subagentActivityExpiryAt: null,
    subagentActivityExpiryTimer: null,
    taskActivityById: new Map(),
    terminalObservedAtByTask: new Map(),
    tasks: null,
    taskDetails: new Map(),
    taskDetailErrors: new Map(),
    taskDetailLoadingIds: new Set(),
  };
  host.backgroundTasksState = next;
  return next;
}

function retainTaskStreamingFields(state: BackgroundTasksState, task: TaskSummary): TaskSummary {
  const retained = state.taskActivityById.get(task.id);
  const lastActivity = task.lastActivity ?? retained?.lastActivity;
  const diffStat = task.diffStat ?? retained?.diffStat;
  if (lastActivity || diffStat) {
    state.taskActivityById.set(task.id, {
      ...(lastActivity ? { lastActivity } : {}),
      ...(diffStat ? { diffStat } : {}),
    });
  }
  if (lastActivity === task.lastActivity && diffStat === task.diffStat) {
    return task;
  }
  return {
    ...task,
    ...(lastActivity ? { lastActivity } : {}),
    ...(diffStat ? { diffStat } : {}),
  };
}

function prepareTaskSnapshot(state: BackgroundTasksState, task: TaskSummary): TaskSummary {
  const retained = retainTaskStreamingFields(state, task);
  if (isActiveTask(retained)) {
    state.terminalObservedAtByTask.delete(retained.id);
  }
  return retained;
}

function observeTaskTerminal(
  state: BackgroundTasksState,
  task: TaskSummary,
  source: "event" | "snapshot",
) {
  if (isActiveTask(task)) {
    state.terminalObservedAtByTask.delete(task.id);
    return;
  }
  if (!state.terminalObservedAtByTask.has(task.id)) {
    const terminalAt =
      source === "event" ? Date.now() : taskTimestampMs(task.endedAt ?? task.updatedAt);
    if (terminalAt > 0) {
      state.terminalObservedAtByTask.set(task.id, terminalAt);
    }
  }
}

function scheduleSubagentActivityExpiry(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  nextExpiryAt: number | null,
) {
  if (state.subagentActivityExpiryAt === nextExpiryAt) {
    return;
  }
  if (state.subagentActivityExpiryTimer !== null) {
    window.clearTimeout(state.subagentActivityExpiryTimer);
  }
  state.subagentActivityExpiryAt = nextExpiryAt;
  state.subagentActivityExpiryTimer = null;
  if (nextExpiryAt === null) {
    return;
  }
  state.subagentActivityExpiryTimer = window.setTimeout(
    () => {
      if (getBackgroundTasksState(host) !== state) {
        return;
      }
      state.subagentActivityExpiryAt = null;
      state.subagentActivityExpiryTimer = null;
      host.requestUpdate?.();
    },
    Math.max(0, nextExpiryAt - Date.now()),
  );
}

function loadBackgroundTasks(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  force = false,
) {
  const client = host.client;
  if (!client || !host.connected || getBackgroundTasksState(host) !== state) {
    return;
  }
  if (state.loading) {
    if (force) {
      state.pendingReload = true;
    }
    return;
  }
  const requestId = ++state.requestId;
  // The state owns the client and conversation pair; its request owns this
  // buffer so late pages cannot resurrect an unopened concurrent task.
  const eventBuffer: BackgroundTaskEventBuffer = {
    requestId,
    events: [],
  };
  state.pendingTaskEvents = eventBuffer;
  state.loading = true;
  state.error = null;
  state.pendingReload = false;
  const { sessionKey, agentId } = state;
  void (async () => {
    try {
      const [activePayload, recentPayload] = await Promise.all([
        client.request("tasks.list", {
          sessionKey,
          agentId,
          status: ["queued", "running"],
          limit: ACTIVE_TASKS_LIMIT,
        }),
        client.request("tasks.list", { sessionKey, agentId, limit: RECENT_TASKS_LIMIT }),
      ]);
      const active = normalizeTasksListResult(activePayload)?.tasks.map((task) =>
        prepareTaskSnapshot(state, task),
      );
      const recent = normalizeTasksListResult(recentPayload)?.tasks.map((task) =>
        prepareTaskSnapshot(state, task),
      );
      if (!active || !recent) {
        throw new Error(t("tasksPage.invalidResponse"));
      }
      const current = getBackgroundTasksState(host);
      if (current !== state || current.requestId !== requestId) {
        return;
      }
      // The active query is issued first. Apply the later recent snapshot last
      // so same-millisecond running progress cannot regress when events drop.
      let merged = mergeTaskLists(active, recent);
      for (const event of eventBuffer.events) {
        merged = applyTaskEvent(merged, event).tasks;
      }
      current.tasks = sortTasks(
        merged.map((task) => newestTaskSnapshot(task, current.taskDetails.get(task.id))),
      );
      for (const task of current.tasks) {
        observeTaskTerminal(current, task, "snapshot");
      }
      current.loadedClient = client;
    } catch (error) {
      const current = getBackgroundTasksState(host);
      if (current === state && current.requestId === requestId) {
        if (current.tasks === null && eventBuffer.events.length > 0) {
          // Real registry events remain authoritative when an initial page
          // fails; discarding them would hide active work and completions.
          current.tasks = eventBuffer.events.reduce<TaskSummary[]>(
            (tasks, event) => applyTaskEvent(tasks, event).tasks,
            [],
          );
          for (const task of current.tasks) {
            observeTaskTerminal(current, task, "event");
          }
        }
        current.error = formatUiError(error, t("tasksPage.loadFailed"));
      }
    } finally {
      const current = getBackgroundTasksState(host);
      if (current === state && current.requestId === requestId) {
        if (current.pendingTaskEvents === eventBuffer) {
          current.pendingTaskEvents = null;
        }
        current.loading = false;
        const reload = current.pendingReload;
        current.pendingReload = false;
        if (reload) {
          loadBackgroundTasks(host, current, true);
        }
      }
      host.requestUpdate?.();
    }
  })();
}

function taskMatchesSessionScope(
  host: BackgroundTasksHost,
  task: TaskSummary,
  state: BackgroundTasksState,
): "match" | "refresh" | "ignore" {
  let result: "refresh" | "ignore" = "ignore";
  for (const candidate of [
    { key: task.sessionKey },
    { key: task.childSessionKey, agentId: task.agentId },
    { key: task.ownerKey },
  ]) {
    const key = normalizeOptionalString(candidate.key);
    if (!key) {
      continue;
    }
    const identity = resolveUiConversationIdentity(host, key, candidate.agentId);
    if (identity.sessionKey !== state.sessionKey) {
      continue;
    }
    // TaskSummary exposes the executor, not the bare requester/owner's agent.
    // Only this conversation's authoritative list can admit that task ID.
    if (!parseAgentSessionKey(key) && !candidate.agentId) {
      result = "refresh";
    } else if (identity.agentId === state.agentId) {
      return "match";
    }
  }
  return result === "refresh" && state.tasks?.some((listed) => listed.id === task.id)
    ? "match"
    : result;
}

function bufferBackgroundTaskEvent(
  state: BackgroundTasksState,
  event: BackgroundTaskLoadEvent,
): boolean {
  const buffer = state.pendingTaskEvents;
  if (
    event.action === "restored" ||
    !buffer ||
    !state.loading ||
    buffer.requestId !== state.requestId
  ) {
    return false;
  }
  buffer.events.push(event);
  return true;
}

/** Apply a gateway `task` event to the pane's snapshot. Events for other
 * sessions are ignored; a registry restore forces a refetch. */
export function handleBackgroundTasksEvent(
  host: BackgroundTasksHost,
  payload: unknown,
  presented = true,
) {
  const state = host.backgroundTasksState;
  if (!state || getBackgroundTasksState(host) !== state) {
    return;
  }
  let normalizedEvent = normalizeTaskEventPayload(payload);
  if (!normalizedEvent) {
    return;
  }
  if (normalizedEvent.action === "upserted") {
    const match = taskMatchesSessionScope(host, normalizedEvent.task, state);
    if (match === "ignore") {
      return;
    }
    if (match === "refresh") {
      // Ambiguous events invalidate like a restore: coalesce visible reloads
      // and defer hidden panes until presentation without adopting the event.
      normalizedEvent = { action: "restored" };
    }
  }
  observeTaskDetailEvent(host, normalizedEvent);
  const event =
    normalizedEvent.action === "upserted"
      ? {
          ...normalizedEvent,
          task: prepareTaskSnapshot(state, normalizedEvent.task),
        }
      : normalizedEvent;
  const bufferedEvent = bufferBackgroundTaskEvent(state, event);
  if (event.action === "restored" && !presented) {
    // Restore replaces the registry snapshot. Retire any older page without
    // issuing hidden work; presentation will start the authoritative reload.
    state.requestId += 1;
    state.pendingTaskEvents = null;
    state.pendingReload = false;
    state.loading = false;
    state.tasks = null;
    state.loadedClient = null;
    state.error = null;
    host.requestUpdate?.();
    return;
  }
  if (state.tasks === null) {
    // The exact in-flight snapshot already replays its buffered events; a
    // redundant stale reload would immediately undo that initial-load replay.
    if (presented && !bufferedEvent) {
      loadBackgroundTasks(host, state, true);
    }
    return;
  }
  if (event.action === "restored") {
    loadBackgroundTasks(host, state, true);
    return;
  }
  if (event.action === "deleted") {
    if (!state.tasks.some((task) => task.id === event.taskId)) {
      return;
    }
    state.tasks = state.tasks.filter((task) => task.id !== event.taskId);
    state.taskDetails.delete(event.taskId);
    state.taskActivityById.delete(event.taskId);
    state.terminalObservedAtByTask.delete(event.taskId);
    state.taskDetailErrors.delete(event.taskId);
    state.taskDetailLoadingIds.delete(event.taskId);
    host.requestUpdate?.();
    return;
  }
  const current = state.tasks.find((task) => task.id === event.task.id);
  const detail = state.taskDetails.get(event.task.id);
  let newest = current ? newestTaskSnapshot(current, event.task, "event") : event.task;
  newest = newestTaskSnapshot(newest, detail);
  observeTaskTerminal(state, newest, "event");
  state.tasks = sortTasks([newest, ...state.tasks.filter((task) => task.id !== event.task.id)]);
  if (detail) {
    state.taskDetails = new Map(state.taskDetails).set(event.task.id, {
      ...newest,
      ...(detail.prompt ? { prompt: detail.prompt } : {}),
    });
  }
  host.requestUpdate?.();
}

async function loadBackgroundTaskDetail(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  task: TaskSummary,
) {
  const rowId = task.id;
  const client = host.client;
  if (
    !client ||
    !host.connected ||
    getBackgroundTasksState(host) !== state ||
    state.taskDetails.has(rowId) ||
    state.taskDetailLoadingIds.has(rowId)
  ) {
    return;
  }
  state.taskDetailLoadingIds = new Set(state.taskDetailLoadingIds).add(rowId);
  const nextErrors = new Map(state.taskDetailErrors);
  nextErrors.delete(rowId);
  state.taskDetailErrors = nextErrors;
  host.requestUpdate?.();
  try {
    const payload = await client.request("tasks.get", { taskId: rowId });
    if (getBackgroundTasksState(host) !== state) {
      return;
    }
    const normalizedDetail = normalizeTasksGetResult(payload);
    const detail = normalizedDetail ? prepareTaskSnapshot(state, normalizedDetail) : null;
    if (!detail || detail.id !== rowId) {
      throw new Error(t("chat.backgroundTasks.detailFailed"));
    }
    const current = state.tasks?.find((candidate) => candidate.id === rowId);
    // A delete event invalidates the in-flight lookup. Do not let its late
    // response resurrect a registry entry that no longer exists.
    if (!current) {
      return;
    }
    const newest = newestTaskSnapshot(current, detail);
    observeTaskTerminal(state, newest, "snapshot");
    state.taskDetails = new Map(state.taskDetails).set(rowId, {
      ...newest,
      ...(detail.prompt ? { prompt: detail.prompt } : {}),
    });
    if (state.tasks) {
      state.tasks = sortTasks([
        newest,
        ...state.tasks.filter((candidate) => candidate.id !== rowId),
      ]);
    }
  } catch (error) {
    if (getBackgroundTasksState(host) === state) {
      const message = formatUiError(error, t("chat.backgroundTasks.detailFailed"));
      state.taskDetailErrors = new Map(state.taskDetailErrors).set(rowId, message);
    }
  } finally {
    if (getBackgroundTasksState(host) === state) {
      const next = new Set(state.taskDetailLoadingIds);
      next.delete(rowId);
      state.taskDetailLoadingIds = next;
    }
    host.requestUpdate?.();
  }
}

async function cancelBackgroundTask(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  taskId: string,
) {
  const client = host.client;
  if (
    !client ||
    !host.connected ||
    getBackgroundTasksState(host) !== state ||
    state.cancellingTaskIds.has(taskId)
  ) {
    return;
  }
  state.cancellingTaskIds = new Set([...state.cancellingTaskIds, taskId]);
  state.error = null;
  host.requestUpdate?.();
  try {
    const payload = await client.request("tasks.cancel", { taskId });
    if (getBackgroundTasksState(host) !== state) {
      return;
    }
    const result = normalizeTasksCancelResult(payload);
    if (result?.task && state.tasks !== null) {
      const cancelled = prepareTaskSnapshot(state, result.task);
      observeTaskTerminal(state, cancelled, "event");
      const event = normalizeTaskEventPayload({ action: "upserted", task: cancelled });
      if (event) {
        // A slow client may miss the best-effort task event; the successful
        // cancel response must still survive its own in-flight list snapshot.
        bufferBackgroundTaskEvent(state, event);
      }
      state.tasks = sortTasks([
        cancelled,
        ...state.tasks.filter((task) => task.id !== cancelled.id),
      ]);
    }
    // Refusals (already terminal, stale id, no cancellation handle) are
    // successful responses with cancelled=false; surface them like errors.
    if (!result?.cancelled) {
      const reason = result?.reason?.trim();
      state.error = reason ? formatUiError(reason) : t("tasksPage.cancelFailed");
    }
  } catch (error) {
    if (getBackgroundTasksState(host) === state) {
      state.error = formatUiError(error, t("tasksPage.cancelFailed"));
    }
  } finally {
    if (getBackgroundTasksState(host) === state) {
      const next = new Set(state.cancellingTaskIds);
      next.delete(taskId);
      state.cancellingTaskIds = next;
    }
    host.requestUpdate?.();
  }
}

function toggleBackgroundTasks(host: BackgroundTasksHost) {
  const state = getBackgroundTasksState(host);
  state.collapsed = !state.collapsed;
  host.requestUpdate?.();
}

export function createBackgroundTasksProps(
  host: BackgroundTasksHost,
  opts: {
    narrowLayout?: boolean;
    openTaskId?: string;
    onOpenTaskDetail?: (task: TaskSummary) => void;
    presented?: boolean;
  } = {},
): BackgroundTasksProps {
  const state = getBackgroundTasksState(host);
  if (!host.connected) {
    // A reconnect can silently drop `task` events, so a disconnect invalidates
    // the loaded marker and the next connected render refetches the snapshot.
    state.loadedClient = null;
  }
  // Load eagerly even while collapsed: the toggle badge is how running work
  // gets detected at all, so it cannot wait for the rail to be opened first.
  if (
    opts.presented !== false &&
    host.connected &&
    !state.loading &&
    !state.error &&
    (state.tasks === null || state.loadedClient !== host.client)
  ) {
    loadBackgroundTasks(host, state);
  }
  const subagentActivity = deriveSubagentActivity({
    tasks: state.tasks ?? [],
    sessionKey: state.sessionKey,
    terminalObservedAtByTask: state.terminalObservedAtByTask,
    canonicalizeSessionKey: (sessionKey) =>
      canonicalUiSessionKeyForPersistence(host, sessionKey) ||
      normalizeOptionalString(sessionKey) ||
      "",
  });
  scheduleSubagentActivityExpiry(host, state, subagentActivity.nextExpiryAt);
  return {
    sessionKey: state.sessionKey,
    statusRowId: state.statusRowId,
    collapsed: state.collapsed,
    narrowLayout: opts.narrowLayout === true,
    connected: host.connected,
    // tasks.cancel needs operator.write; read-only operators get no button.
    canCancel: host.connected && hasOperatorWriteAccess(host.hello?.auth ?? null),
    loading: state.loading,
    error: state.error,
    tasks: state.tasks,
    activeCount: state.tasks?.filter(isActiveTask).length ?? 0,
    subagentActivity,
    openTaskId: opts.openTaskId,
    taskDetails: state.taskDetails,
    taskDetailErrors: state.taskDetailErrors,
    taskDetailLoadingIds: state.taskDetailLoadingIds,
    cancellingTaskIds: state.cancellingTaskIds,
    finishedCollapsed: state.finishedCollapsed,
    onToggleCollapsed: () => toggleBackgroundTasks(host),
    onToggleFinished: () => {
      state.finishedCollapsed = !state.finishedCollapsed;
      host.requestUpdate?.();
    },
    onRefresh: () => loadBackgroundTasks(host, state, true),
    onCancel: (taskId) => void cancelBackgroundTask(host, state, taskId),
    onLoadDetail: (task) => void loadBackgroundTaskDetail(host, state, task),
    onOpenTaskDetail: opts.onOpenTaskDetail
      ? (task) => {
          // Opening retries a failed tasks.get: the panel's render-driven load
          // must skip errored tasks (a retry there would loop every paint), so
          // user selection is the one path that clears the error.
          if (state.taskDetailErrors.has(task.id)) {
            const next = new Map(state.taskDetailErrors);
            next.delete(task.id);
            state.taskDetailErrors = next;
          }
          opts.onOpenTaskDetail?.(task);
        }
      : undefined,
  };
}
