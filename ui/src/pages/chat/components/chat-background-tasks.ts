import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import { hasOperatorWriteAccess } from "../../../app/operator-access.ts";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { formatDurationCompact, formatMs, formatRelativeTimestamp } from "../../../lib/format.ts";
import type { SessionScopeHost } from "../../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import {
  isActiveTask,
  mergeTaskLists,
  normalizeTaskEventPayload,
  normalizeTasksCancelResult,
  normalizeTasksListResult,
  partitionTasks,
  sortTasks,
  taskDetail,
  taskRuntimeLabel,
  taskStatusLabel,
  taskTimestampMs,
  taskTitle,
  type TaskSummary,
} from "../../../lib/tasks/data.ts";
import { paneSessionAgentId } from "./chat-session-workspace.ts";

export type BackgroundTasksProps = {
  agentId: string;
  collapsed: boolean;
  /** Pane too narrow for a side rail: presentation moves to a bottom strip
   * (mirrors the workspace rail's narrow mode). */
  narrowLayout: boolean;
  connected: boolean;
  canCancel: boolean;
  loading: boolean;
  error: string | null;
  /** null until the first load for this agent finished. */
  tasks: TaskSummary[] | null;
  cancellingTaskIds: ReadonlySet<string>;
  finishedCollapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleFinished: () => void;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
  onOpenSession: (sessionKey: string) => void;
};

type BackgroundTasksState = {
  agentId: string;
  cancellingTaskIds: Set<string>;
  collapsed: boolean;
  error: string | null;
  finishedCollapsed: boolean;
  // Loads are keyed to the client so a reconnect (or gateway switch) refreshes
  // the snapshot instead of trusting the previous connection's task list.
  loadedClient: GatewayBrowserClient | null;
  loading: boolean;
  pendingReload: boolean;
  requestId: number;
  tasks: TaskSummary[] | null;
};

export type BackgroundTasksHost = {
  sessionKey: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  assistantAgentId?: string | null;
  agentsList?: SessionScopeHost["agentsList"];
  backgroundTasksState?: BackgroundTasksState;
  requestUpdate?: () => void;
};

// Bounded like the Tasks page: active tasks get their own query because the
// ledger pages newest-first and long-running work can hide behind newer
// terminal records on the first page.
const ACTIVE_TASKS_LIMIT = 200;
const RECENT_TASKS_LIMIT = 100;

function getBackgroundTasksState(host: BackgroundTasksHost): BackgroundTasksState {
  const agentId = paneSessionAgentId(host);
  const current = host.backgroundTasksState;
  if (current?.agentId === agentId) {
    return current;
  }
  const next: BackgroundTasksState = {
    agentId,
    cancellingTaskIds: new Set(),
    // The pane is an agent-level view; keep the open/collapsed choice across
    // agent switches and only reload the task list for the new scope.
    collapsed: current?.collapsed ?? true,
    error: null,
    finishedCollapsed: current?.finishedCollapsed ?? false,
    loadedClient: null,
    loading: false,
    pendingReload: false,
    requestId: 0,
    tasks: null,
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
  state.loading = true;
  state.error = null;
  state.pendingReload = false;
  const agentId = state.agentId;
  void (async () => {
    try {
      const [activePayload, recentPayload] = await Promise.all([
        client.request("tasks.list", {
          agentId,
          status: ["queued", "running"],
          limit: ACTIVE_TASKS_LIMIT,
        }),
        client.request("tasks.list", { agentId, limit: RECENT_TASKS_LIMIT }),
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
      current.tasks = mergeTaskLists(recent, active);
      current.loadedClient = client;
    } catch (error) {
      const current = getBackgroundTasksState(host);
      if (current === state && current.requestId === requestId) {
        current.error =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : t("tasksPage.loadFailed");
      }
    } finally {
      const current = getBackgroundTasksState(host);
      if (current === state && current.requestId === requestId) {
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

function taskMatchesAgentScope(task: TaskSummary, agentId: string): boolean {
  // Mirrors the gateway's tasks.list agent filter: an explicit task agentId is
  // authoritative; legacy records fall back to agent-style requester/child/
  // owner keys. Dropping ownerKey here would make owner-scoped legacy rows
  // load but never receive live event updates.
  if (task.agentId) {
    return task.agentId === agentId;
  }
  return [task.sessionKey, task.childSessionKey, task.ownerKey].some(
    (key) => key !== undefined && parseAgentSessionKey(key)?.agentId === agentId,
  );
}

/** Apply a gateway `task` event to the pane's snapshot. Events for other
 * agents are ignored; a registry restore forces a refetch. */
export function handleBackgroundTasksEvent(host: BackgroundTasksHost, payload: unknown) {
  const state = host.backgroundTasksState;
  if (!state) {
    return;
  }
  const event = normalizeTaskEventPayload(payload);
  if (!event) {
    return;
  }
  if (state.tasks === null) {
    // Activity arrived before the snapshot finished loading: fold it into a
    // (re)load so collapsed panes still detect the new task in their badge.
    loadBackgroundTasks(host, state, true);
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
    host.requestUpdate?.();
    return;
  }
  if (!taskMatchesAgentScope(event.task, state.agentId)) {
    return;
  }
  state.tasks = sortTasks([event.task, ...state.tasks.filter((task) => task.id !== event.task.id)]);
  host.requestUpdate?.();
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
    agentId: state.agentId,
    collapsed: state.collapsed,
    narrowLayout: opts.narrowLayout === true,
    connected: host.connected,
    // tasks.cancel needs operator.write; read-only operators get no button.
    canCancel: host.connected && hasOperatorWriteAccess(host.hello?.auth ?? null),
    loading: state.loading,
    error: state.error,
    tasks: state.tasks,
    cancellingTaskIds: state.cancellingTaskIds,
    finishedCollapsed: state.finishedCollapsed,
    onToggleCollapsed: () => toggleBackgroundTasks(host),
    onToggleFinished: () => {
      state.finishedCollapsed = !state.finishedCollapsed;
      host.requestUpdate?.();
    },
    onRefresh: () => loadBackgroundTasks(host, state, true),
    onCancel: (taskId) => void cancelBackgroundTask(host, state, taskId),
    onOpenSession: opts.onOpenSession,
  };
}

/** Active-count badge shown on the collapsed-rail toggles; 0 until the task
 * list has loaded for the pane's agent. */
function backgroundTasksActiveCount(props: BackgroundTasksProps | undefined): number {
  return props?.tasks?.filter(isActiveTask).length ?? 0;
}

type BackgroundTasksStatus = { count: number; startedMs: number | null };

/** Summary for the bottom-of-thread status row: active-task count plus the
 * oldest active start time so the row ticks one elapsed label, not one per
 * task. `startedMs` is null when no active task has a usable timestamp. */
function activeBackgroundTasksStatus(
  props: BackgroundTasksProps | undefined,
): BackgroundTasksStatus | null {
  const active = props?.tasks?.filter(isActiveTask) ?? [];
  if (active.length === 0) {
    return null;
  }
  let startedMs: number | null = null;
  for (const task of active) {
    const started = taskTimestampMs(task.startedAt ?? task.createdAt);
    if (started > 0 && (startedMs === null || started < startedMs)) {
      startedMs = started;
    }
  }
  return { count: active.length, startedMs };
}

/** Post-turn status row in the chat thread: once the agent turn settles while
 * background tasks keep running, the running work stays visible next to a
 * free composer. The link opens the tasks rail (noop when already open). */
export function renderBackgroundTasksStatusRow(
  backgroundTasks: BackgroundTasksProps | undefined,
): TemplateResult | typeof nothing {
  const status = activeBackgroundTasksStatus(backgroundTasks);
  // Disconnected snapshots are stale: task events cannot arrive, so a ticking
  // "running" claim would be a lie. The rail owns the disconnected state.
  if (!backgroundTasks?.connected || !status) {
    return nothing;
  }
  const label =
    status.count === 1
      ? t("chat.backgroundTasks.statusRunningOne")
      : t("chat.backgroundTasks.statusRunningMany", { count: String(status.count) });
  const openRail = () => {
    if (backgroundTasks.collapsed) {
      backgroundTasks.onToggleCollapsed();
    }
  };
  return html`
    <div class="chat-tasks-status" role="status">
      <span class="chat-tasks-status__claw" aria-hidden="true">${icons.claw}</span>
      ${status.startedMs !== null
        ? html`
            <!-- Ticking time stays out of the polite live region: without
                 aria-hidden, screen readers would re-announce every second. -->
            <span class="chat-tasks-status__time" aria-hidden="true">
              <openclaw-elapsed-time .startMs=${status.startedMs}></openclaw-elapsed-time>
            </span>
            <span class="chat-tasks-status__sep" aria-hidden="true">·</span>
          `
        : nothing}
      <button class="chat-tasks-status__link" type="button" @click=${openRail}>${label}</button>
    </div>
  `;
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

// Status tone drives the meta line's colored word and the running pulse dot;
// pill chips read too heavy at rail width, so tone is typographic only.
const STATUS_TONES = {
  queued: "warn",
  running: "warn",
  completed: "ok",
  failed: "danger",
  cancelled: "muted",
  timed_out: "danger",
} as const satisfies Record<TaskSummary["status"], string>;

function renderTaskRow(task: TaskSummary, props: BackgroundTasksProps): TemplateResult {
  const active = isActiveTask(task);
  const title = taskTitle(task);
  const detail = taskDetail(task);
  const timestamp = taskTimestampMs(task.updatedAt ?? task.createdAt);
  const startedMs = taskTimestampMs(task.startedAt ?? task.createdAt);
  const endedMs = taskTimestampMs(task.endedAt);
  const finishedDuration =
    !active && endedMs > startedMs && startedMs > 0
      ? formatDurationCompact(endedMs - startedMs, { spaced: true })
      : undefined;
  const toolUseCount = task.toolUseCount ?? 0;
  const transcriptSessionKey = task.childSessionKey ?? task.sessionKey;
  const cancelling = props.cancellingTaskIds.has(task.id);
  const tone = STATUS_TONES[task.status];
  return html`
    <div class="chat-tasks-rail__task" role="listitem" data-task-id=${task.id}>
      <div class="chat-tasks-rail__task-head">
        ${task.status === "running"
          ? html`<span class="chat-tasks-rail__task-pulse" aria-hidden="true"></span>`
          : nothing}
        <openclaw-tooltip .content=${title}>
          <span class="chat-tasks-rail__task-title">${title}</span>
        </openclaw-tooltip>
        ${active && props.canCancel
          ? html`
              <openclaw-tooltip .content=${t("chat.backgroundTasks.stopTask", { title })}>
                <button
                  class="chat-tasks-rail__task-stop"
                  type="button"
                  aria-label=${t("chat.backgroundTasks.stopTask", { title })}
                  ?disabled=${cancelling || !props.connected}
                  @click=${() => props.onCancel(task.taskId)}
                >
                  ${cancelling ? icons.loader : icons.stop}
                </button>
              </openclaw-tooltip>
            `
          : nothing}
      </div>
      <div class="chat-tasks-rail__task-meta">
        <span class="chat-tasks-rail__task-status chat-tasks-rail__task-status--${tone}"
          >${taskStatusLabel(task.status)}</span
        >
        <span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
        <span>${taskRuntimeLabel(task)}</span>
        ${active && startedMs > 0
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span><openclaw-elapsed-time .startMs=${startedMs}></openclaw-elapsed-time></span>`
          : nothing}
        ${finishedDuration
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span>${finishedDuration}</span>`
          : nothing}
        ${!active && timestamp > 0
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span title=${formatMs(timestamp)}>${formatRelativeTimestamp(timestamp)}</span>`
          : nothing}
        ${toolUseCount > 0
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span
                >${toolUseCount === 1
                  ? t("chat.backgroundTasks.toolUseOne")
                  : t("chat.backgroundTasks.toolUseMany", { count: String(toolUseCount) })}</span
              >`
          : nothing}
        ${active && task.lastToolName
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span class="chat-tasks-rail__task-tool">${task.lastToolName}</span>`
          : nothing}
        ${transcriptSessionKey
          ? html`
              <button
                class="chat-tasks-rail__task-transcript"
                type="button"
                @click=${() => props.onOpenSession(transcriptSessionKey)}
              >
                ${t("chat.backgroundTasks.viewTranscript")}
              </button>
            `
          : nothing}
      </div>
      ${detail ? html`<div class="chat-tasks-rail__task-detail">${detail}</div>` : nothing}
    </div>
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
  const { active, recent } = partitionTasks(backgroundTasks.tasks ?? []);
  const loaded = backgroundTasks.tasks !== null;
  const empty = loaded && active.length === 0 && recent.length === 0;
  return html`
    <aside class="chat-tasks-rail" aria-label=${t("chat.backgroundTasks.label")}>
      <div class="chat-tasks-rail__header">
        <div class="chat-tasks-rail__title">
          <span class="chat-tasks-rail__eyebrow">${backgroundTasks.agentId}</span>
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
          <openclaw-tooltip .content=${t("chat.backgroundTasks.collapse")}>
            <button
              type="button"
              class="nav-collapse-toggle chat-tasks-rail__collapse-toggle"
              aria-label=${t("chat.backgroundTasks.collapse")}
              aria-expanded="true"
              @click=${backgroundTasks.onToggleCollapsed}
            >
              <span class="nav-collapse-toggle__icon" aria-hidden="true"
                >${backgroundTasks.narrowLayout
                  ? icons.panelBottomClose
                  : icons.panelRightClose}</span
              >
            </button>
          </openclaw-tooltip>
        </div>
      </div>
      ${!backgroundTasks.connected
        ? html`<div class="chat-tasks-rail__state">${t("tasksPage.disconnected")}</div>`
        : nothing}
      ${backgroundTasks.error
        ? html`<div class="chat-tasks-rail__state chat-tasks-rail__state--error">
            ${backgroundTasks.error}
          </div>`
        : nothing}
      ${backgroundTasks.loading && !loaded
        ? html`<div class="chat-tasks-rail__state">${t("chat.backgroundTasks.loading")}</div>`
        : nothing}
      ${empty
        ? html`<div class="chat-tasks-rail__state">${t("chat.backgroundTasks.empty")}</div>`
        : nothing}
      <div class="chat-tasks-rail__scroll">
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
                    ${backgroundTasks.finishedCollapsed ? icons.chevronRight : icons.chevronDown}
                  </span>
                </button>
                ${backgroundTasks.finishedCollapsed
                  ? nothing
                  : renderTaskRows(recent, backgroundTasks)}
              </section>
            `
          : nothing}
      </div>
    </aside>
  `;
}
