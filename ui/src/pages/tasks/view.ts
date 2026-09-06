import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import "../../styles/tasks.css";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatMs, formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  partitionTasks,
  taskDetail,
  taskRuntimeLabel,
  taskStatusLabel,
  taskTimestampMs,
  taskTitle,
} from "../../lib/tasks/data.ts";
import type { TaskStatus, TaskSummary } from "../../lib/tasks/task-summary.ts";

type TasksProps = {
  basePath: string;
  agentId: string;
  mainKey: string;
  connected: boolean;
  canCopy: boolean;
  canCancel: boolean;
  loading: boolean;
  error: string | null;
  copyResultError: string | null;
  tasks: TaskSummary[];
  cancellingTaskIds: ReadonlySet<string>;
  sessionRow: (sessionKey: string) => GatewaySessionRow | undefined;
  onCancel: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onDismiss: (taskId: string) => void;
  onCopyResult: (taskId: string) => void;
  onNavigateToChat: (sessionKey: string) => void;
};

function renderSessionLink(task: TaskSummary, props: TasksProps) {
  const sessionKey = task.childSessionKey ?? task.sessionKey;
  if (!sessionKey) {
    return nothing;
  }
  const row = props.sessionRow(sessionKey);
  const href = sessionNavigationTarget({
    face: resolveSessionPreferredFace(row),
    sessionKey,
    fallbackAgentId: props.agentId,
    basePath: props.basePath,
    mainKey: props.mainKey,
    row,
    preferenceDerivedFace: true,
  }).href;
  return html`<a
    class="session-link"
    href=${href}
    @click=${(event: MouseEvent) => {
      if (!shouldHandleNavigationClick(event)) {
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
  const retainedResult = task.terminalOutcome === "blocked";
  const recoverableDelivery = retainedResult && task.deliveryStatus === "failed";
  const dismissedDelivery = retainedResult && task.deliveryStatus === "dismissed";
  const showActions =
    (active && props.canCancel) ||
    (retainedResult && props.canCopy) ||
    (recoverableDelivery && props.canCancel);
  return html`
    <div class="settings-row task-row" data-task-id=${task.id}>
      <div class="settings-row__text task-row__content">
        <div class="settings-row__title">${title}</div>
        <div class="task-row__facts">
          <span data-task-status
            >${renderSettingsStatus({
              kind: taskStatusKind(task.status),
              label: taskStatusLabel(task.status),
            })}</span
          >
          <span>${taskRuntimeLabel(task)}</span>
          ${
            task.agentId
              ? html`<span>${t("tasksPage.agent", { agent: task.agentId })}</span>`
              : nothing
          }
        </div>
        ${detail ? html`<div class="settings-row__desc">${detail}</div>` : nothing}
        ${
          retainedResult
            ? html`<div class="task-row__warning">
                <span
                  >${t(
                    dismissedDelivery ? "tasksPage.deliveryDismissed" : "tasksPage.deliveryBlocked",
                  )}</span
                >
                ${
                  recoverableDelivery
                    ? html`<span class="muted">${t("tasksPage.duplicateRisk")}</span>`
                    : nothing
                }
              </div>`
            : nothing
        }
      </div>
      <div class="settings-row__control task-row__control">
        <div class="task-row__links">
          ${
            timestamp > 0
              ? html`<span title=${formatMs(timestamp)}
                  >${formatRelativeTimestamp(timestamp)}</span
                >`
              : html`<span>${t("common.na")}</span>`
          }
          ${renderSessionLink(task, props)}
        </div>
        ${
          showActions
            ? html`<div class="task-row__actions">
                ${
                  active && props.canCancel
                    ? html`<button
                        class="btn btn--sm"
                        type="button"
                        aria-label=${t("tasksPage.cancelTask", { title })}
                        ?disabled=${cancelling || !props.connected}
                        @click=${() => props.onCancel(task.taskId)}
                      >
                        ${cancelling ? t("tasksPage.cancelling") : t("common.cancel")}
                      </button>`
                    : nothing
                }
                ${
                  retainedResult && props.canCopy
                    ? html`<button
                        class="btn btn--sm"
                        type="button"
                        ?disabled=${cancelling || !props.connected}
                        @click=${() => props.onCopyResult(task.taskId)}
                      >
                        ${t("tasksPage.copyResult")}
                      </button>`
                    : nothing
                }
                ${
                  recoverableDelivery && props.canCancel
                    ? html`
                        <button
                          class="btn btn--sm"
                          type="button"
                          ?disabled=${cancelling || !props.connected}
                          @click=${() => props.onRetry(task.taskId)}
                        >
                          ${t("tasksPage.retryDelivery")}
                        </button>
                        <button
                          class="btn btn--sm"
                          type="button"
                          ?disabled=${cancelling || !props.connected}
                          @click=${() => props.onDismiss(task.taskId)}
                        >
                          ${t("tasksPage.dismissDelivery")}
                        </button>
                      `
                    : nothing
                }
              </div>`
            : nothing
        }
      </div>
    </div>
  `;
}

function taskStatusKind(status: TaskStatus) {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
    case "timed_out":
      return "danger";
    case "queued":
    case "running":
      return "warn";
    case "cancelled":
      return "muted";
  }
  return status satisfies never;
}

function countByStatus(tasks: readonly TaskSummary[], ...statuses: TaskStatus[]) {
  return tasks.filter((task) => statuses.includes(task.status)).length;
}

function renderHeadingFacts(id: "active" | "recent", tasks: readonly TaskSummary[]) {
  const facts =
    id === "active"
      ? [
          [countByStatus(tasks, "running"), t("tasksPage.status.running")],
          [countByStatus(tasks, "queued"), t("tasksPage.status.queued")],
        ]
      : [
          [countByStatus(tasks, "completed"), t("tasksPage.status.completed")],
          [countByStatus(tasks, "failed", "timed_out"), t("tasksPage.status.failed")],
        ];
  return html`<span class="task-heading-facts">
    ${facts.map(
      ([value, label], index) => html`
        ${index > 0 ? html`<span aria-hidden="true">·</span>` : nothing}
        <span><strong>${value}</strong> ${label}</span>
      `,
    )}
  </span>`;
}

function renderSection(
  id: "active" | "recent",
  title: string,
  tasks: readonly TaskSummary[],
  emptyText: string,
  props: TasksProps,
) {
  const rows =
    tasks.length === 0
      ? renderSettingsEmpty(emptyText)
      : repeat(
          tasks,
          (task) => task.id,
          (task) => renderTask(task, props),
        );
  return html`<div data-task-section=${id}>
    ${renderSettingsSection({ title: html`${title}${renderHeadingFacts(id, tasks)}` }, rows)}
  </div>`;
}

export function renderTasks(props: TasksProps) {
  const { active, recent } = partitionTasks(props.tasks);
  return renderSettingsPage(
    html`<div class="tasks-page-list">
      ${
        !props.connected
          ? html`<div class="callout warn">${t("tasksPage.disconnected")}</div>`
          : nothing
      }
      ${props.error ? html`<div class="callout danger" role="alert">${props.error}</div>` : nothing}
      ${
        props.copyResultError
          ? html`<div class="callout danger" role="alert">${props.copyResultError}</div>`
          : nothing
      }
      ${
        props.loading && props.tasks.length === 0
          ? renderSettingsEmpty(t("tasksPage.loading"))
          : nothing
      }
      ${
        !props.loading && props.tasks.length === 0
          ? renderSettingsEmpty(t("tasksPage.empty"))
          : nothing
      }
      ${renderSection("active", t("tasksPage.active"), active, t("tasksPage.emptyActive"), props)}
      ${renderSection("recent", t("tasksPage.recent"), recent, t("tasksPage.emptyRecent"), props)}
    </div>`,
    { wide: true },
  );
}
