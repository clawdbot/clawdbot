import { html, nothing, type TemplateResult } from "lit";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { formatDurationCompact, formatMs, formatRelativeTimestamp } from "../../../lib/format.ts";
import {
  isActiveTask,
  taskDetail,
  taskRuntimeLabel,
  taskTimestampMs,
  taskTitle,
  type TaskSummary,
} from "../../../lib/tasks/data.ts";
import {
  backgroundTaskStatusLabel,
  newestTaskSnapshot,
  STATUS_TONES,
} from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";

export function renderTaskRow(task: TaskSummary, props: BackgroundTasksProps): TemplateResult {
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
  const expanded = props.selectedTaskId === task.id;
  const detailedTask = props.taskDetails.get(task.id);
  const detailLoading = props.taskDetailLoadingIds.has(task.id);
  const detailError = props.taskDetailErrors.get(task.id);
  // List/events and lookup can race; newest activity owns mutable output.
  const output = taskDetail(newestTaskSnapshot(task, detailedTask));
  const disclosureLabel = expanded
    ? t("chat.backgroundTasks.collapseTask", { title })
    : t("chat.backgroundTasks.expandTask", { title });
  return html`
    <div
      class="chat-tasks-rail__task ${expanded ? "chat-tasks-rail__task--expanded" : ""}"
      role="listitem"
      data-task-id=${task.id}
      @click=${(event: MouseEvent) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("button, a, .chat-tasks-rail__task-inspector")
        ) {
          return;
        }
        props.onToggleTask(task);
      }}
    >
      <div class="chat-tasks-rail__task-head">
        <button
          class="chat-tasks-rail__task-disclosure"
          type="button"
          aria-label=${disclosureLabel}
          aria-expanded=${String(expanded)}
          @click=${() => props.onToggleTask(task)}
        >
          ${task.status === "running"
            ? html`<span class="chat-tasks-rail__task-pulse" aria-hidden="true"></span>`
            : nothing}
          <openclaw-tooltip .content=${title}>
            <span class="chat-tasks-rail__task-title">${title}</span>
          </openclaw-tooltip>
          <span class="chat-tasks-rail__task-chevron" aria-hidden="true">
            ${expanded ? icons.chevronDown : icons.chevronRight}
          </span>
        </button>
        ${active && props.canCancel
          ? html`
              <openclaw-tooltip .content=${t("chat.backgroundTasks.stopTask", { title })}>
                <button
                  class="chat-tasks-rail__task-stop"
                  type="button"
                  aria-label=${t("chat.backgroundTasks.stopTask", { title })}
                  ?disabled=${cancelling || !props.connected}
                  @click=${() => props.onCancel(task.id)}
                >
                  ${cancelling ? icons.loader : icons.stop}
                </button>
              </openclaw-tooltip>
            `
          : nothing}
      </div>
      <div class="chat-tasks-rail__task-meta">
        <span class="chat-tasks-rail__task-status chat-tasks-rail__task-status--${tone}"
          >${backgroundTaskStatusLabel(task)}</span
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
      ${expanded
        ? html`
            <div class="chat-tasks-rail__task-inspector" data-task-inspector=${task.id}>
              ${detailLoading
                ? html`<div class="chat-tasks-rail__task-inspector-state">
                    ${t("chat.backgroundTasks.detailLoading")}
                  </div>`
                : detailError
                  ? html`<div
                      class="chat-tasks-rail__task-inspector-state chat-tasks-rail__task-inspector-state--error"
                    >
                      ${detailError}
                    </div>`
                  : html`
                      <div class="chat-tasks-rail__task-inspector-block">
                        <div class="chat-tasks-rail__task-inspector-label">
                          ${t("chat.backgroundTasks.prompt")}
                        </div>
                        <pre>
${detailedTask?.prompt ?? t("chat.backgroundTasks.promptUnavailable")}</pre>
                      </div>
                      <div class="chat-tasks-rail__task-inspector-block">
                        <div class="chat-tasks-rail__task-inspector-label">
                          ${t("chat.backgroundTasks.output")}
                        </div>
                        <pre>${output ?? t("chat.backgroundTasks.outputPending")}</pre>
                      </div>
                    `}
            </div>
          `
        : nothing}
    </div>
  `;
}
