import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { pathForRoute } from "../../app-route-paths.ts";
import { icon, type IconName } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatMs, formatRelativeTimestamp } from "../../lib/format.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { partitionTasks, taskTimestampMs, type TaskStatus, type TaskSummary } from "./data.ts";

type TasksProps = {
  basePath: string;
  connected: boolean;
  canCancel: boolean;
  loading: boolean;
  error: string | null;
  tasks: TaskSummary[];
  cancellingTaskIds: ReadonlySet<string>;
  onCancel: (taskId: string) => void;
  onNavigateToChat: (sessionKey: string) => void;
};

const STATUS_LABEL_KEYS = {
  queued: "tasksPage.status.queued",
  running: "tasksPage.status.running",
  completed: "tasksPage.status.completed",
  failed: "tasksPage.status.failed",
  cancelled: "tasksPage.status.cancelled",
  timed_out: "tasksPage.status.timedOut",
} as const satisfies Record<TaskStatus, string>;

const STATUS_CHIP_CLASSES = {
  queued: "chip-warn",
  running: "chip-warn",
  completed: "chip-ok",
  failed: "chip-danger",
  cancelled: "",
  timed_out: "chip-danger",
} as const satisfies Record<TaskStatus, string>;

function statusLabel(status: TaskStatus): string {
  return t(STATUS_LABEL_KEYS[status]);
}

function statusClass(status: TaskStatus): string {
  return STATUS_CHIP_CLASSES[status];
}

function runtimeLabel(task: TaskSummary): string {
  switch (task.runtime) {
    case "subagent":
      return t("tasksPage.runtime.subagent");
    case "cron":
      return t("tasksPage.runtime.cron");
    case "acp":
      return t("tasksPage.runtime.acp");
    case "cli":
      return t("tasksPage.runtime.cli");
    default:
      return t("tasksPage.runtime.unknown");
  }
}

function taskTitle(task: TaskSummary): string {
  return task.title ?? task.kind ?? (task.runtime ? runtimeLabel(task) : t("tasksPage.untitled"));
}

function taskDetail(task: TaskSummary): string | null {
  if (task.status === "queued" || task.status === "running") {
    return task.progressSummary ?? null;
  }
  if (task.status === "failed" || task.status === "timed_out") {
    return task.error ?? task.terminalSummary ?? task.progressSummary ?? null;
  }
  return task.terminalSummary ?? task.error ?? task.progressSummary ?? null;
}

function renderSessionLink(task: TaskSummary, props: TasksProps) {
  const sessionKey = task.childSessionKey ?? task.sessionKey;
  if (!sessionKey) {
    return nothing;
  }
  const href = `${pathForRoute("chat", props.basePath)}${searchForSession(sessionKey)}`;
  return html`<a
    class="session-link"
    href=${href}
    @click=${(event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      props.onNavigateToChat(sessionKey);
    }}
    >${t("tasksPage.openSession")}</a
  >`;
}

function renderTask(task: TaskSummary, props: TasksProps) {
  const active = task.status === "queued" || task.status === "running";
  const timestamp = taskTimestampMs(task.updatedAt ?? task.createdAt);
  const detail = taskDetail(task);
  const title = taskTitle(task);
  const cancelling = props.cancellingTaskIds.has(task.id);
  return html`
    <div class="list-item" data-task-id=${task.id}>
      <div class="list-main">
        <div class="list-title">${title}</div>
        <div class="chip-row">
          <span class="chip ${statusClass(task.status)}">${statusLabel(task.status)}</span>
          <span class="chip">${runtimeLabel(task)}</span>
          ${task.agentId
            ? html`<span class="chip">${t("tasksPage.agent", { agent: task.agentId })}</span>`
            : nothing}
        </div>
        ${detail ? html`<div class="list-sub">${detail}</div>` : nothing}
      </div>
      <div class="list-meta">
        ${timestamp > 0
          ? html`<span title=${formatMs(timestamp)}>${formatRelativeTimestamp(timestamp)}</span>`
          : html`<span>${t("common.na")}</span>`}
        ${renderSessionLink(task, props)}
        ${active && props.canCancel
          ? html`<button
              class="btn"
              type="button"
              aria-label=${t("tasksPage.cancelTask", { title })}
              ?disabled=${cancelling || !props.connected}
              @click=${() => props.onCancel(task.taskId)}
            >
              ${cancelling ? t("tasksPage.cancelling") : t("common.cancel")}
            </button>`
          : nothing}
      </div>
    </div>
  `;
}

type TaskStat = {
  key: string;
  iconName: IconName;
  label: string;
  value: number;
  danger?: boolean;
};

function renderSummaryStrip(tasks: readonly TaskSummary[]) {
  const countByStatus = (...statuses: TaskStatus[]) =>
    tasks.filter((task) => statuses.includes(task.status)).length;
  // Timeouts are failures from the operator's point of view; the recent list
  // still labels them individually.
  const failed = countByStatus("failed", "timed_out");
  const stats: TaskStat[] = [
    {
      key: "running",
      iconName: "play",
      label: t("tasksPage.status.running"),
      value: countByStatus("running"),
    },
    {
      key: "queued",
      iconName: "clock",
      label: t("tasksPage.status.queued"),
      value: countByStatus("queued"),
    },
    {
      key: "completed",
      iconName: "check",
      label: t("tasksPage.status.completed"),
      value: countByStatus("completed"),
    },
    {
      key: "failed",
      iconName: "alertTriangle",
      label: t("tasksPage.status.failed"),
      value: failed,
      danger: failed > 0,
    },
  ];
  return html`
    <section class="card summary-strip">
      <div class="summary-strip__stats">
        ${stats.map(
          (stat) => html`
            <div
              class="summary-stat ${stat.danger ? "summary-stat--danger" : ""}"
              data-stat=${stat.key}
            >
              <span class="summary-stat__icon" aria-hidden="true">${icon(stat.iconName)}</span>
              <div class="summary-stat__copy">
                <div class="summary-stat__label">${stat.label}</div>
                <div class="summary-stat__value">${stat.value}</div>
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function renderSection(
  id: "active" | "recent",
  title: string,
  subtitle: string,
  tasks: readonly TaskSummary[],
  emptyText: string,
  props: TasksProps,
) {
  return html`
    <section class="card stack" data-task-section=${id}>
      <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 12px;">
        <div>
          <div class="card-title">${title}</div>
          <div class="card-sub">${subtitle}</div>
        </div>
        <div class="muted">
          ${tasks.length === 1
            ? t("tasksPage.taskCountOne")
            : t("tasksPage.taskCount", { count: String(tasks.length) })}
        </div>
      </div>
      ${tasks.length === 0
        ? html`<div class="muted">${emptyText}</div>`
        : html`<div class="list">
            ${repeat(
              tasks,
              (task) => task.id,
              (task) => renderTask(task, props),
            )}
          </div>`}
    </section>
  `;
}

export function renderTasks(props: TasksProps) {
  const { active, recent } = partitionTasks(props.tasks);
  return html`
    <div class="stack">
      ${!props.connected
        ? html`<div class="callout warn">${t("tasksPage.disconnected")}</div>`
        : nothing}
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      ${renderSummaryStrip(props.tasks)}
      ${props.loading && props.tasks.length === 0
        ? html`<div class="card muted">${t("tasksPage.loading")}</div>`
        : nothing}
      ${!props.loading && props.tasks.length === 0
        ? html`<div class="card muted">${t("tasksPage.empty")}</div>`
        : nothing}
      ${renderSection(
        "active",
        t("tasksPage.active"),
        t("tasksPage.activeSub"),
        active,
        t("tasksPage.emptyActive"),
        props,
      )}
      ${renderSection(
        "recent",
        t("tasksPage.recent"),
        t("tasksPage.recentSub"),
        recent,
        t("tasksPage.emptyRecent"),
        props,
      )}
    </div>
  `;
}
