// Registers <wa-tooltip>: the status row's hover preview uses it directly
// because openclaw-tooltip only carries plain-text content.
import "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import { html, nothing, type TemplateResult } from "lit";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import {
  isActiveTask,
  partitionTasks,
  taskStatusLabel,
  taskTimestampMs,
  taskTitle,
  type TaskSummary,
} from "../../../lib/tasks/data.ts";
import { STATUS_TONES, type BackgroundTasksProps } from "./chat-background-tasks.ts";

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

/** Rows the hover preview shows before deferring to the rail's full list. */
const STATUS_PREVIEW_LIMIT = 5;

function renderStatusPreviewRow(task: TaskSummary): TemplateResult {
  const active = isActiveTask(task);
  const tone = STATUS_TONES[task.status];
  const timeMs = active
    ? taskTimestampMs(task.startedAt ?? task.createdAt)
    : taskTimestampMs(task.updatedAt ?? task.createdAt);
  return html`
    <div class="chat-tasks-preview__row">
      ${task.status === "running"
        ? html`<span class="chat-tasks-rail__task-pulse" aria-hidden="true"></span>`
        : nothing}
      <span class="chat-tasks-preview__title">${taskTitle(task)}</span>
      <span class="chat-tasks-preview__meta">
        <span class="chat-tasks-rail__task-status chat-tasks-rail__task-status--${tone}"
          >${taskStatusLabel(task.status)}</span
        >
        ${timeMs > 0
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span>
                ${active
                  ? html`<openclaw-elapsed-time .startMs=${timeMs}></openclaw-elapsed-time>`
                  : formatRelativeTimestamp(timeMs)}
              </span>`
          : nothing}
      </span>
    </div>
  `;
}

/** Hover/focus preview on the status row: the latest tasks at a glance
 * without opening the rail. Content is read-only — a tooltip is a transient
 * surface, so actions stay in the rail the click opens. */
function renderStatusPreview(props: BackgroundTasksProps): TemplateResult {
  const { active, recent } = partitionTasks(props.tasks ?? []);
  const tasks = [...active, ...recent];
  const preview = tasks.slice(0, STATUS_PREVIEW_LIMIT);
  const overflow = tasks.length - preview.length;
  return html`
    <wa-tooltip
      class="chat-tasks-status__preview"
      for=${props.statusRowId}
      placement="top-start"
      without-arrow
    >
      <div class="chat-tasks-preview">
        ${preview.map((task) => renderStatusPreviewRow(task))}
        ${overflow > 0
          ? html`<div class="chat-tasks-preview__more">
              ${t("chat.backgroundTasks.statusPreviewMore", { count: String(overflow) })}
            </div>`
          : nothing}
      </div>
    </wa-tooltip>
  `;
}

/** Post-turn status row in the chat thread: once the agent turn settles while
 * background tasks keep running, the running work stays visible next to a
 * free composer. Hover previews the latest tasks; the link opens the tasks
 * rail (noop when already open). */
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
  // The preview tooltip anchors the whole row (not the link button): wa-tooltip
  // joins the anchor's aria-labelledby, which would replace the button's
  // accessible name. It also stays a sibling so the ticking preview content
  // never lives inside the polite live region.
  return html`
    <div class="chat-tasks-status" id=${backgroundTasks.statusRowId} role="status">
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
    ${renderStatusPreview(backgroundTasks)}
  `;
}
