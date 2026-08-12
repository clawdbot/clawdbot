import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import { hasOperatorWriteAccess } from "../../../app/operator-access.ts";
import { t } from "../../../i18n/index.ts";
import type { SessionScopeHost } from "../../../lib/sessions/index.ts";
import { canonicalUiSessionKeyForPersistence } from "../../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../../lib/string-coerce.ts";
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
import {
  CHAT_HISTORY_REQUEST_LIMIT,
  type ChatHistoryResult,
  visibleChatHistoryMessages,
} from "../chat-history.ts";
import { newestTaskSnapshot } from "./chat-background-tasks-shared.ts";
import type {
  BackgroundTasksProps,
  BackgroundTasksRailView,
} from "./chat-background-tasks.types.ts";
import { deriveSubagentActivity } from "./chat-subagent-activity.ts";

type BackgroundTaskLoadEvent = NonNullable<ReturnType<typeof normalizeTaskEventPayload>>;

type BackgroundTaskEventBuffer = {
  requestId: number;
  client: GatewayBrowserClient;
  connectionEpoch: number | undefined;
  sessionKey: string;
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
  // wa-tooltip anchors by document id, so the status row's id must stay unique
  // per pane: two panes on the same agent would otherwise cross-anchor.
  statusRowId: string;
  subagentActivityExpiryAt: number | null;
  subagentActivityExpiryTimer: number | null;
  taskActivityById: Map<string, Pick<TaskSummary, "lastActivity" | "diffStat">>;
  terminalObservedAtByTask: Map<string, number>;
  tasks: TaskSummary[] | null;
  view: BackgroundTasksRailView;
  taskDetails: Map<string, TaskSummary>;
  taskDetailErrors: Map<string, string>;
  taskDetailLoadingIds: Set<string>;
};

export type BackgroundTasksHost = {
  sessionKey: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch?: number;
  hello: GatewayHelloOk | null;
  agentsList?: SessionScopeHost["agentsList"];
  backgroundTasksState?: BackgroundTasksState;
  requestUpdate?: () => void;
};

// Bounded like the Tasks page: active tasks get their own query because the
// ledger pages newest-first and long-running work can hide behind newer
// terminal records on the first page.
const ACTIVE_TASKS_LIMIT = 200;
const RECENT_TASKS_LIMIT = 100;

let nextStatusRowId = 0;

function getBackgroundTasksState(host: BackgroundTasksHost): BackgroundTasksState {
  const sessionKey =
    canonicalUiSessionKeyForPersistence(host, host.sessionKey) ||
    normalizeOptionalString(host.sessionKey) ||
    host.sessionKey;
  const current = host.backgroundTasksState;
  if (
    current?.sessionKey === sessionKey &&
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
    statusRowId: `chat-tasks-status-${nextStatusRowId}`,
    subagentActivityExpiryAt: null,
    subagentActivityExpiryTimer: null,
    taskActivityById: new Map(),
    terminalObservedAtByTask: new Map(),
    tasks: null,
    view: { kind: "list" },
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
  if (!client || !host.connected) {
    return;
  }
  if (state.loading) {
    if (force) {
      state.pendingReload = true;
    }
    return;
  }
  const requestId = ++state.requestId;
  // Keep live registry events tied to this exact client, scope, and snapshot
  // so a late page cannot resurrect or overwrite an unopened concurrent task.
  const eventBuffer: BackgroundTaskEventBuffer = {
    requestId,
    client,
    connectionEpoch: state.connectionEpoch,
    sessionKey: state.sessionKey,
    events: [],
  };
  state.pendingTaskEvents = eventBuffer;
  state.loading = true;
  state.error = null;
  state.pendingReload = false;
  const sessionKey = state.sessionKey;
  void (async () => {
    try {
      const [activePayload, recentPayload] = await Promise.all([
        client.request("tasks.list", {
          sessionKey,
          status: ["queued", "running"],
          limit: ACTIVE_TASKS_LIMIT,
        }),
        client.request("tasks.list", { sessionKey, limit: RECENT_TASKS_LIMIT }),
      ]);
      const active = normalizeTasksListResult(activePayload)?.map((task) =>
        prepareTaskSnapshot(state, task),
      );
      const recent = normalizeTasksListResult(recentPayload)?.map((task) =>
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
      const viewedTaskId = current.view.kind === "list" ? null : current.view.taskId;
      // Detail and transcript navigation depend on the authoritative list;
      // a bounded refresh may legitimately omit the previously viewed task.
      if (viewedTaskId && !current.tasks.some((task) => task.id === viewedTaskId)) {
        current.view = { kind: "list" };
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
        current.error =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : t("tasksPage.loadFailed");
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
  sessionKey: string,
): boolean {
  // Mirror the gateway's session filter so requester, child, and owner views
  // receive the same live events as their tasks.list snapshots.
  return [task.sessionKey, task.childSessionKey, task.ownerKey].some(
    (key) =>
      canonicalUiSessionKeyForPersistence(host, key) === sessionKey ||
      normalizeOptionalString(key) === sessionKey,
  );
}

function bufferBackgroundTaskEvent(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  event: BackgroundTaskLoadEvent,
): boolean {
  const buffer = state.pendingTaskEvents;
  if (
    event.action === "restored" ||
    !buffer ||
    !state.loading ||
    buffer.requestId !== state.requestId ||
    buffer.client !== host.client ||
    buffer.connectionEpoch !== host.connectionEpoch ||
    buffer.sessionKey !== state.sessionKey ||
    (event.action === "upserted" && !taskMatchesSessionScope(host, event.task, state.sessionKey))
  ) {
    return false;
  }
  buffer.events.push(event);
  return true;
}

/** Apply a gateway `task` event to the pane's snapshot. Events for other
 * sessions are ignored; a registry restore forces a refetch. */
export function handleBackgroundTasksEvent(host: BackgroundTasksHost, payload: unknown) {
  const state = host.backgroundTasksState;
  if (
    !state ||
    state.connectionClient !== host.client ||
    state.connectionEpoch !== host.connectionEpoch
  ) {
    return;
  }
  const normalizedEvent = normalizeTaskEventPayload(payload);
  if (!normalizedEvent) {
    return;
  }
  if (
    normalizedEvent.action === "upserted" &&
    !taskMatchesSessionScope(host, normalizedEvent.task, state.sessionKey)
  ) {
    return;
  }
  const event =
    normalizedEvent.action === "upserted"
      ? {
          ...normalizedEvent,
          task: prepareTaskSnapshot(state, normalizedEvent.task),
        }
      : normalizedEvent;
  const bufferedEvent = bufferBackgroundTaskEvent(host, state, event);
  if (state.tasks === null) {
    // The exact in-flight snapshot already replays its buffered events; a
    // redundant stale reload would immediately undo that initial-load replay.
    if (!bufferedEvent) {
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
    if (state.view.kind !== "list" && state.view.taskId === event.taskId) {
      state.view = { kind: "list" };
    }
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
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : t("chat.backgroundTasks.detailFailed");
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

function focusBackgroundTaskControl(
  state: BackgroundTasksState,
  target: "back" | { taskId: string },
) {
  window.requestAnimationFrame(() => {
    const rail = document.getElementById(`${state.statusRowId}-rail`);
    if (target === "back") {
      rail?.querySelector<HTMLElement>(".chat-tasks-rail__back")?.focus();
      return;
    }
    const row = [...(rail?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])].find(
      (candidate) => candidate.dataset.taskId === target.taskId,
    );
    row?.querySelector<HTMLElement>(".chat-tasks-rail__task-disclosure")?.focus();
  });
}

function selectBackgroundTaskDetail(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  task: TaskSummary,
) {
  state.view = { kind: "detail", taskId: task.id };
  host.requestUpdate?.();
  focusBackgroundTaskControl(state, "back");
  void loadBackgroundTaskDetail(host, state, task);
}

function showBackgroundTaskList(host: BackgroundTasksHost, state: BackgroundTasksState) {
  const taskId = state.view.kind === "detail" ? state.view.taskId : null;
  const listedTask = state.tasks?.find((task) => task.id === taskId);
  const detailedTask = taskId ? state.taskDetails.get(taskId) : undefined;
  const selectedTask = listedTask ? newestTaskSnapshot(listedTask, detailedTask) : detailedTask;
  if (selectedTask && state.tasks) {
    state.tasks = sortTasks([
      selectedTask,
      ...state.tasks.filter((task) => task.id !== selectedTask.id),
    ]);
    if (!isActiveTask(selectedTask)) {
      state.finishedCollapsed = false;
    }
  }
  state.view = { kind: "list" };
  host.requestUpdate?.();
  if (taskId) {
    focusBackgroundTaskControl(state, { taskId });
  }
}

function openBackgroundTaskTranscript(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  task: TaskSummary,
  returnTo: "list" | "detail",
) {
  const sessionKey = normalizeOptionalString(task.childSessionKey ?? task.sessionKey);
  const client = host.client;
  const pendingView: BackgroundTasksRailView = {
    kind: "transcript",
    taskId: task.id,
    sessionKey: sessionKey ?? "",
    returnTo,
    load: { status: "loading" },
  };
  state.view = pendingView;
  host.requestUpdate?.();
  focusBackgroundTaskControl(state, "back");
  if (!client || !host.connected || !sessionKey) {
    state.view = {
      ...pendingView,
      load: { status: "error" },
    };
    host.requestUpdate?.();
    return;
  }
  void (async () => {
    let load: Extract<BackgroundTasksRailView, { kind: "transcript" }>["load"];
    try {
      const result = await client.request<ChatHistoryResult>("chat.history", {
        sessionKey,
        limit: CHAT_HISTORY_REQUEST_LIMIT,
      });
      load = { status: "loaded", messages: visibleChatHistoryMessages(result.messages) };
    } catch {
      load = { status: "error" };
    }
    const current = getBackgroundTasksState(host);
    if (current !== state || current.view !== pendingView) {
      return;
    }
    current.view = { ...pendingView, load };
    host.requestUpdate?.();
  })();
}

function showPreviousBackgroundTaskView(host: BackgroundTasksHost, state: BackgroundTasksState) {
  if (state.view.kind === "detail") {
    showBackgroundTaskList(host, state);
    return;
  }
  if (state.view.kind !== "transcript") {
    return;
  }
  const { returnTo, taskId } = state.view;
  if (returnTo === "detail" && state.tasks?.some((task) => task.id === taskId)) {
    state.view = { kind: "detail", taskId };
    host.requestUpdate?.();
    window.requestAnimationFrame(() => {
      document
        .getElementById(`${state.statusRowId}-rail`)
        ?.querySelector<HTMLElement>(".chat-tasks-rail__task-transcript")
        ?.focus();
    });
    return;
  }
  state.view = { kind: "list" };
  host.requestUpdate?.();
  focusBackgroundTaskControl(state, { taskId });
}

async function cancelBackgroundTask(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  taskId: string,
) {
  const client = host.client;
  if (!client || !host.connected || state.cancellingTaskIds.has(taskId)) {
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
        bufferBackgroundTaskEvent(host, state, event);
      }
      state.tasks = sortTasks([
        cancelled,
        ...state.tasks.filter((task) => task.id !== cancelled.id),
      ]);
    }
    // Refusals (already terminal, stale id, no cancellation handle) are
    // successful responses with cancelled=false; surface them like errors.
    if (!result?.cancelled) {
      state.error = result?.reason?.trim() || t("tasksPage.cancelFailed");
    }
  } catch (error) {
    if (getBackgroundTasksState(host) === state) {
      state.error =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : t("tasksPage.cancelFailed");
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
  opts: { narrowLayout?: boolean } = {},
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
    subagentActivity,
    view: state.view,
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
    onSelectTask: (task) => selectBackgroundTaskDetail(host, state, task),
    onBack: () => showPreviousBackgroundTaskView(host, state),
    onOpenTranscript: (task, returnTo) => openBackgroundTaskTranscript(host, state, task, returnTo),
  };
}
