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
} from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import {
  backgroundTaskStatusLabel,
  newestTaskSnapshot,
  STATUS_TONES,
} from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";

type TaskDisplayFacts = {
  active: boolean;
  finishedDuration?: string;
  startedMs: number;
  timestamp: number;
  title: string;
  toolUseCount: number;
  transcriptSessionKey?: string;
};

function taskDisplayFacts(task: TaskSummary): TaskDisplayFacts {
  const active = isActiveTask(task);
  const startedMs = taskTimestampMs(task.startedAt ?? task.createdAt);
  const endedMs = taskTimestampMs(task.endedAt);
  return {
    active,
    finishedDuration:
      !active && endedMs > startedMs && startedMs > 0
        ? formatDurationCompact(endedMs - startedMs, { spaced: true })
        : undefined,
    startedMs,
    timestamp: taskTimestampMs(task.updatedAt ?? task.createdAt),
    title: taskTitle(task),
    toolUseCount: task.toolUseCount ?? 0,
    transcriptSessionKey: task.childSessionKey ?? task.sessionKey,
  };
}

function renderTaskMeta(
  task: TaskSummary,
  props: BackgroundTasksProps,
  facts: TaskDisplayFacts,
  transcriptReturnTo: "list" | "detail",
): TemplateResult {
  const tone = STATUS_TONES[task.status];
  const showTranscript = task.runtime !== "subagent" && facts.transcriptSessionKey;
  return html`
    <div class="chat-tasks-rail__task-meta">
      <span class="chat-tasks-rail__task-status chat-tasks-rail__task-status--${tone}"
        >${backgroundTaskStatusLabel(task)}</span
      >
      <span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
      <span>${taskRuntimeLabel(task)}</span>
      ${facts.active && facts.startedMs > 0
        ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
            <span
              ><openclaw-elapsed-time .startMs=${facts.startedMs}></openclaw-elapsed-time
            ></span>`
        : nothing}
      ${facts.finishedDuration
        ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
            <span>${facts.finishedDuration}</span>`
        : nothing}
      ${!facts.active && facts.timestamp > 0
        ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
            <span title=${formatMs(facts.timestamp)}
              >${formatRelativeTimestamp(facts.timestamp)}</span
            >`
        : nothing}
      ${facts.toolUseCount > 0
        ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
            <span
              >${facts.toolUseCount === 1
                ? t("chat.backgroundTasks.toolUseOne")
                : t("chat.backgroundTasks.toolUseMany", {
                    count: String(facts.toolUseCount),
                  })}</span
            >`
        : nothing}
      ${facts.active && task.lastToolName
        ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
            <span class="chat-tasks-rail__task-tool">${task.lastToolName}</span>`
        : nothing}
      ${showTranscript
        ? html`
            <button
              class="chat-tasks-rail__task-transcript"
              type="button"
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                props.onOpenTranscript(task, transcriptReturnTo);
              }}
            >
              ${t("chat.backgroundTasks.viewTranscript")}
            </button>
          `
        : nothing}
    </div>
  `;
}

export function renderTaskRow(task: TaskSummary, props: BackgroundTasksProps): TemplateResult {
  const facts = taskDisplayFacts(task);
  const detail = taskDetail(task);
  const cancelling = props.cancellingTaskIds.has(task.id);
  return html`
    <div
      class="chat-tasks-rail__task"
      role="listitem"
      data-task-id=${task.id}
      @click=${(event: MouseEvent) => {
        const target = event.target;
        if (target instanceof Element && target.closest("button, a")) {
          return;
        }
        props.onSelectTask(task);
      }}
    >
      <div class="chat-tasks-rail__task-head">
        <button
          class="chat-tasks-rail__task-disclosure"
          type="button"
          aria-label=${t("chat.backgroundTasks.expandTask", { title: facts.title })}
          @click=${() => props.onSelectTask(task)}
        >
          ${task.status === "running"
            ? html`<span class="chat-tasks-rail__task-pulse" aria-hidden="true"></span>`
            : nothing}
          <openclaw-tooltip .content=${facts.title}>
            <span class="chat-tasks-rail__task-title">${facts.title}</span>
          </openclaw-tooltip>
          <span class="chat-tasks-rail__task-chevron" aria-hidden="true">
            ${icons.chevronRight}
          </span>
        </button>
        ${facts.active && props.canCancel
          ? html`
              <openclaw-tooltip
                .content=${t("chat.backgroundTasks.stopTask", { title: facts.title })}
              >
                <button
                  class="chat-tasks-rail__task-stop"
                  type="button"
                  aria-label=${t("chat.backgroundTasks.stopTask", { title: facts.title })}
                  ?disabled=${cancelling || !props.connected}
                  @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    props.onCancel(task.id);
                  }}
                >
                  ${cancelling ? icons.loader : icons.stop}
                </button>
              </openclaw-tooltip>
            `
          : nothing}
      </div>
      ${renderTaskMeta(task, props, facts, "list")}
      ${detail ? html`<div class="chat-tasks-rail__task-detail">${detail}</div>` : nothing}
    </div>
  `;
}

export function renderTaskDetail(task: TaskSummary, props: BackgroundTasksProps): TemplateResult {
  const detailedTask = props.taskDetails.get(task.id);
  const newest = newestTaskSnapshot(task, detailedTask);
  const facts = taskDisplayFacts(newest);
  const output = taskDetail(newest);
  const detailLoading = props.taskDetailLoadingIds.has(task.id);
  const detailError = props.taskDetailErrors.get(task.id);
  const cancelling = props.cancellingTaskIds.has(task.id);
  return html`
    <div class="chat-tasks-rail__detail" data-task-detail=${task.id}>
      <div class="chat-tasks-rail__detail-summary">
        <div class="chat-tasks-rail__detail-status-line">
          ${newest.status === "running"
            ? html`<span class="chat-tasks-rail__task-pulse" aria-hidden="true"></span>`
            : nothing}
          ${renderTaskMeta(newest, props, facts, "detail")}
        </div>
        ${facts.active && props.canCancel
          ? html`
              <openclaw-tooltip
                .content=${t("chat.backgroundTasks.stopTask", { title: facts.title })}
              >
                <button
                  class="btn btn--ghost btn--sm chat-tasks-rail__detail-stop"
                  type="button"
                  aria-label=${t("chat.backgroundTasks.stopTask", { title: facts.title })}
                  ?disabled=${cancelling || !props.connected}
                  @click=${() => props.onCancel(task.id)}
                >
                  ${cancelling ? icons.loader : icons.stop}
                </button>
              </openclaw-tooltip>
            `
          : nothing}
      </div>
      ${newest.progressSummary
        ? html`<div class="chat-tasks-rail__detail-activity">
            <span>${newest.lastToolName ?? taskRuntimeLabel(newest)}</span>
            <strong>${newest.progressSummary}</strong>
          </div>`
        : nothing}
      ${detailError
        ? html`<div
            class="chat-tasks-rail__task-inspector-state chat-tasks-rail__task-inspector-state--error"
          >
            ${detailError}
          </div>`
        : nothing}
      <div class="chat-tasks-rail__detail-blocks">
        <section class="chat-tasks-rail__task-inspector-block">
          <div class="chat-tasks-rail__task-inspector-label">
            ${t("chat.backgroundTasks.prompt")}
          </div>
          <pre>
${detailLoading
              ? t("chat.backgroundTasks.detailLoading")
              : (detailedTask?.prompt ?? t("chat.backgroundTasks.promptUnavailable"))}</pre>
        </section>
        <section class="chat-tasks-rail__task-inspector-block">
          <div class="chat-tasks-rail__task-inspector-label">
            ${t("chat.backgroundTasks.output")}
          </div>
          <pre>${output ?? t("chat.backgroundTasks.outputPending")}</pre>
        </section>
      </div>
    </div>
  `;
}
