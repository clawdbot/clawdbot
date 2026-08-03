import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import { hasOperatorWriteAccess } from "../../../app/operator-access.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
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
  partitionTasks,
  sortTasks,
  taskTitle,
} from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { renderTaskDetail, renderTaskRow } from "./chat-background-task-row.ts";
import { newestTaskSnapshot } from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";

export { STATUS_TONES } from "./chat-background-tasks-shared.ts";
export type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";

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
  tasks: TaskSummary[] | null;
  selectedTaskId: string | null;
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
    tasks: null,
    selectedTaskId: null,
    taskDetails: new Map(),
    taskDetailErrors: new Map(),
    taskDetailLoadingIds: new Set(),
  };
  host.backgroundTasksState = next;
  return next;
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
      const active = normalizeTasksListResult(activePayload);
      const recent = normalizeTasksListResult(recentPayload);
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
  const event = normalizeTaskEventPayload(payload);
  if (!event) {
    return;
  }
  if (event.action === "upserted" && !taskMatchesSessionScope(host, event.task, state.sessionKey)) {
    return;
  }
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
    if (state.selectedTaskId === event.taskId) {
      state.selectedTaskId = null;
    }
    state.taskDetails.delete(event.taskId);
    state.taskDetailErrors.delete(event.taskId);
    state.taskDetailLoadingIds.delete(event.taskId);
    host.requestUpdate?.();
    return;
  }
  const current = state.tasks.find((task) => task.id === event.task.id);
  const detail = state.taskDetails.get(event.task.id);
  let newest = current ? newestTaskSnapshot(current, event.task, "event") : event.task;
  newest = newestTaskSnapshot(newest, detail);
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
    const detail = normalizeTasksGetResult(payload);
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
  state.selectedTaskId = task.id;
  host.requestUpdate?.();
  focusBackgroundTaskControl(state, "back");
  void loadBackgroundTaskDetail(host, state, task);
}

function showBackgroundTaskList(host: BackgroundTasksHost, state: BackgroundTasksState) {
  const taskId = state.selectedTaskId;
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
  state.selectedTaskId = null;
  host.requestUpdate?.();
  if (taskId) {
    focusBackgroundTaskControl(state, { taskId });
  }
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
      const cancelled = result.task;
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
  opts: { narrowLayout?: boolean; onOpenSession: (sessionKey: string) => void },
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
    selectedTaskId: state.selectedTaskId,
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
    onBackToList: () => showBackgroundTaskList(host, state),
    onOpenSession: opts.onOpenSession,
  };
}

/** Active-count badge shown on the collapsed-rail toggles; 0 until the task
 * list has loaded for the pane's session. */
function backgroundTasksActiveCount(props: BackgroundTasksProps | undefined): number {
  return props?.tasks?.filter(isActiveTask).length ?? 0;
}

export function renderBackgroundTasksToggle(
  backgroundTasks: BackgroundTasksProps | undefined,
): TemplateResult | typeof nothing {
  if (!backgroundTasks) {
    return nothing;
  }
  const expanded = !backgroundTasks.collapsed;
  const label = expanded ? t("chat.backgroundTasks.collapse") : t("chat.backgroundTasks.show");
  const activeCount = backgroundTasksActiveCount(backgroundTasks);
  return html`
    <openclaw-tooltip .content=${label}>
      <button
        class="btn btn--ghost btn--icon chat-icon-btn chat-tasks-toggle"
        type="button"
        aria-label=${label}
        aria-expanded=${String(expanded)}
        @click=${backgroundTasks.onToggleCollapsed}
      >
        ${icons.activity}
        ${!expanded && activeCount > 0
          ? html`<span class="chat-tasks-toggle__badge" aria-hidden="true">${activeCount}</span>`
          : nothing}
      </button>
    </openclaw-tooltip>
  `;
}

function renderTaskRows(
  tasks: readonly TaskSummary[],
  props: BackgroundTasksProps,
): TemplateResult {
  return html`
    <div class="chat-tasks-rail__list" role="list">
      ${repeat(
        tasks,
        (task) => task.id,
        (task) => renderTaskRow(task, props),
      )}
    </div>
  `;
}

export function renderBackgroundTasksRail(
  backgroundTasks: BackgroundTasksProps | undefined,
): TemplateResult | typeof nothing {
  // Collapsed rails render nothing at all — no icon strip. Reopening happens
  // through renderBackgroundTasksToggle.
  if (!backgroundTasks || backgroundTasks.collapsed) {
    return nothing;
  }
  const selectedTask = backgroundTasks.tasks?.find(
    (task) => task.id === backgroundTasks.selectedTaskId,
  );
  const { active, recent } = partitionTasks(backgroundTasks.tasks ?? []);
  const loaded = backgroundTasks.tasks !== null;
  const empty = loaded && active.length === 0 && recent.length === 0;
  const collapseButton = html`
    <openclaw-tooltip .content=${t("chat.backgroundTasks.collapse")}>
      <button
        type="button"
        class="nav-collapse-toggle chat-tasks-rail__collapse-toggle"
        aria-label=${t("chat.backgroundTasks.collapse")}
        aria-expanded="true"
        @click=${backgroundTasks.onToggleCollapsed}
      >
        <span class="nav-collapse-toggle__icon" aria-hidden="true"
          >${backgroundTasks.narrowLayout ? icons.panelBottomClose : icons.panelRightClose}</span
        >
      </button>
    </openclaw-tooltip>
  `;
  return html`
    <aside
      id=${`${backgroundTasks.statusRowId}-rail`}
      class="chat-tasks-rail"
      aria-label=${t("chat.backgroundTasks.label")}
    >
      <div class="chat-tasks-rail__header">
        ${selectedTask
          ? html`
              <button
                class="btn btn--ghost btn--sm chat-tasks-rail__back"
                type="button"
                aria-label=${t("chat.backgroundTasks.backToTasks")}
                @click=${backgroundTasks.onBackToList}
              >
                ${icons.arrowLeft}
              </button>
              <div class="chat-tasks-rail__title">
                <span class="chat-tasks-rail__eyebrow"
                  >${t("chat.backgroundTasks.detailTitle")}</span
                >
                <strong title=${taskTitle(selectedTask)}>${taskTitle(selectedTask)}</strong>
              </div>
              <div class="chat-tasks-rail__actions">${collapseButton}</div>
            `
          : html`
              <div class="chat-tasks-rail__title">
                <span class="chat-tasks-rail__eyebrow">${backgroundTasks.sessionKey}</span>
                <strong>${t("chat.backgroundTasks.title")}</strong>
              </div>
              <div class="chat-tasks-rail__actions">
                <openclaw-tooltip .content=${t("chat.backgroundTasks.refresh")}>
                  <button
                    class="btn btn--ghost btn--sm chat-tasks-rail__refresh"
                    type="button"
                    aria-label=${t("chat.backgroundTasks.refresh")}
                    ?disabled=${backgroundTasks.loading || !backgroundTasks.connected}
                    @click=${backgroundTasks.onRefresh}
                  >
                    ${icons.refresh}
                  </button>
                </openclaw-tooltip>
                ${collapseButton}
              </div>
            `}
      </div>
      ${!backgroundTasks.connected
        ? html`<div class="chat-tasks-rail__state">${t("tasksPage.disconnected")}</div>`
        : nothing}
      ${backgroundTasks.error
        ? html`<div class="chat-tasks-rail__state chat-tasks-rail__state--error">
            ${backgroundTasks.error}
          </div>`
        : nothing}
      ${selectedTask
        ? html`<div class="chat-tasks-rail__scroll">
            ${renderTaskDetail(selectedTask, backgroundTasks)}
          </div>`
        : html`
            ${backgroundTasks.loading && !loaded
              ? html`<div class="chat-tasks-rail__state">${t("chat.backgroundTasks.loading")}</div>`
              : nothing}
            ${empty
              ? html`<div class="chat-tasks-rail__state">${t("chat.backgroundTasks.empty")}</div>`
              : nothing}
            <div class="chat-tasks-rail__scroll chat-tasks-rail__scroll--split">
              ${active.length > 0
                ? html`
                    <section class="chat-tasks-rail__section" data-tasks-section="running">
                      <div class="chat-tasks-rail__section-title">
                        ${t("chat.backgroundTasks.running", { count: String(active.length) })}
                      </div>
                      ${renderTaskRows(active, backgroundTasks)}
                    </section>
                  `
                : nothing}
              ${recent.length > 0
                ? html`
                    <section class="chat-tasks-rail__section" data-tasks-section="finished">
                      <button
                        class="chat-tasks-rail__section-toggle"
                        type="button"
                        aria-expanded=${String(!backgroundTasks.finishedCollapsed)}
                        @click=${backgroundTasks.onToggleFinished}
                      >
                        <span class="chat-tasks-rail__section-title">
                          ${t("chat.backgroundTasks.finished", { count: String(recent.length) })}
                        </span>
                        <span class="chat-tasks-rail__section-chevron" aria-hidden="true">
                          ${backgroundTasks.finishedCollapsed
                            ? icons.chevronRight
                            : icons.chevronDown}
                        </span>
                      </button>
                      ${backgroundTasks.finishedCollapsed
                        ? nothing
                        : renderTaskRows(recent, backgroundTasks)}
                    </section>
                  `
                : nothing}
            </div>
          `}
    </aside>
  `;
}
