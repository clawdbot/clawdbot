import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing, type TemplateResult } from "lit";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { isActiveTask, taskTimestampMs, taskTitle } from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import type { ChatProps } from "../chat-view.ts";
import { renderTaskInspector } from "./chat-background-task-row.ts";
import {
  backgroundTaskStatusLabel,
  newestTaskSnapshot,
  STATUS_TONES,
} from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { renderDiffStatChips } from "./chat-diff-render.ts";
import { renderReadOnlyTranscript } from "./chat-read-only-transcript.ts";
import {
  readSubagentTranscript,
  resetSubagentDetail,
  type SubagentDetailHost,
} from "./chat-subagent-detail-state.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

export function renderSubagentDetailPanel(params: {
  backgroundTasks: BackgroundTasksProps;
  chat: ChatProps;
  host: SubagentDetailHost;
  task: TaskSummary | undefined;
  transcript: ChatTranscriptController;
}): TemplateResult {
  const { backgroundTasks, task } = params;
  if (!task) {
    resetSubagentDetail(params.host);
    return html`
      <div class="sidebar-panel chat-subagent-detail" data-subagent-detail-panel>
        ${renderSubagentHeader(t("chat.backgroundTasks.subagentDetailTitle"))}
        <div class="sidebar-content chat-subagent-detail__state">
          ${t("chat.backgroundTasks.subagentUnavailable")}
        </div>
      </div>
    `;
  }
  const detailedTask = backgroundTasks.taskDetails.get(task.id);
  const currentTask = newestTaskSnapshot(task, detailedTask);
  const childSessionKey = normalizeOptionalString(currentTask.childSessionKey);
  const content = childSessionKey
    ? renderSubagentTranscript({ ...params, task: currentTask, sessionKey: childSessionKey })
    : renderSubagentFallback(currentTask, backgroundTasks, params.host);
  return html`
    <div class="sidebar-panel chat-subagent-detail" data-subagent-detail-panel>
      ${renderSubagentHeader(taskTitle(currentTask), currentTask, backgroundTasks)} ${content}
    </div>
  `;
}

// No close button here on purpose: the sidebar region header owns the
// "Close Details" control for every detail-slot panel (the classic panel is
// embedded with its own header hidden); a second X 40px away duplicated it.
function renderSubagentHeader(
  title: string,
  task?: TaskSummary,
  backgroundTasks?: BackgroundTasksProps,
): TemplateResult {
  const active = task ? isActiveTask(task) : false;
  const startedMs = task ? taskTimestampMs(task.startedAt ?? task.createdAt) : 0;
  const cancelling = task ? backgroundTasks?.cancellingTaskIds.has(task.id) === true : false;
  return html`
    <div class="sidebar-header chat-subagent-detail__header">
      <div class="chat-subagent-detail__heading">
        <div class="sidebar-title" title=${title}>${title}</div>
        ${task
          ? html`<div class="chat-subagent-detail__meta">
              ${task.status === "running"
                ? html`<span class="chat-tasks-rail__task-pulse" aria-hidden="true"></span>`
                : nothing}
              <span
                class="chat-tasks-rail__task-status chat-tasks-rail__task-status--${STATUS_TONES[
                  task.status
                ]}"
                >${backgroundTaskStatusLabel(task)}</span
              >
              ${active && startedMs > 0
                ? html`<span aria-hidden="true">·</span>
                    <openclaw-elapsed-time .startMs=${startedMs}></openclaw-elapsed-time>`
                : nothing}
              ${task.lastToolName
                ? html`<span aria-hidden="true">·</span>
                    <span class="chat-subagent-detail__tool">${task.lastToolName}</span>`
                : nothing}
              ${task.diffStat ? renderDiffStatChips(task.diffStat) : nothing}
            </div>`
          : nothing}
      </div>
      ${task && active && backgroundTasks?.canCancel
        ? html`<div class="sidebar-header__actions">
            <button
              class="btn btn--ghost btn--sm"
              type="button"
              aria-label=${t("chat.backgroundTasks.stopTask", { title })}
              ?disabled=${cancelling || !backgroundTasks.connected}
              @click=${() => backgroundTasks.onCancel(task.id)}
            >
              ${cancelling ? icons.loader : icons.stop} ${t("chat.runControls.stop")}
            </button>
          </div>`
        : nothing}
    </div>
  `;
}

function renderSubagentTranscript(params: {
  chat: ChatProps;
  host: SubagentDetailHost;
  sessionKey: string;
  task: TaskSummary;
  transcript: ChatTranscriptController;
}): TemplateResult {
  const load = readSubagentTranscript(params.host, {
    taskId: params.task.id,
    sessionKey: params.sessionKey,
  });
  if (load.status === "loading") {
    return html`<div class="sidebar-content chat-subagent-detail__state">
      ${t("chat.backgroundTasks.transcriptLoading")}
    </div>`;
  }
  if (load.status === "error") {
    return html`<div
      class="sidebar-content chat-subagent-detail__state chat-subagent-detail__state--error"
    >
      ${t("chat.backgroundTasks.transcriptFailed")}
    </div>`;
  }
  if (load.messages.length === 0) {
    return html`<div class="sidebar-content chat-subagent-detail__state">
      ${t("chat.backgroundTasks.transcriptEmpty")}
    </div>`;
  }
  return html`<div class="sidebar-content chat-subagent-detail__content">
    <div class="chat-subagent-detail__transcript">
      ${renderReadOnlyTranscript({
        chat: params.chat,
        messages: load.messages,
        paneId: `${params.chat.paneId}:subagent-sidebar`,
        sessionKey: params.sessionKey,
        transcript: params.transcript,
      })}
    </div>
  </div>`;
}

function renderSubagentFallback(
  task: TaskSummary,
  backgroundTasks: BackgroundTasksProps,
  host: SubagentDetailHost,
): TemplateResult {
  resetSubagentDetail(host);
  if (
    !backgroundTasks.taskDetails.has(task.id) &&
    !backgroundTasks.taskDetailErrors.has(task.id) &&
    !backgroundTasks.taskDetailLoadingIds.has(task.id)
  ) {
    backgroundTasks.onLoadDetail?.(task);
  }
  return html`<div class="sidebar-content chat-subagent-detail__fallback">
    ${renderTaskInspector(task, backgroundTasks)}
  </div>`;
}
