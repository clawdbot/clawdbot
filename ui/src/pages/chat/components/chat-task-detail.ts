import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing, type TemplateResult } from "lit";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { canonicalUiSessionKeyForPersistence } from "../../../lib/sessions/session-key.ts";
import {
  isActiveTask,
  taskDetail,
  taskRuntimeLabel,
  taskTimestampMs,
  taskTitle,
} from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import type { ChatProps } from "../chat-view.ts";
import {
  backgroundTaskStatusLabel,
  newestTaskSnapshot,
  STATUS_TONES,
} from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { renderDiffStatChips } from "./chat-diff-render.ts";
import { renderReadOnlyTranscript } from "./chat-read-only-transcript.ts";
import {
  readTaskTranscript,
  resetTaskDetail,
  type TaskDetailHost,
} from "./chat-task-detail-state.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

export function renderTaskDetailPanel(params: {
  backgroundTasks: BackgroundTasksProps;
  chat: ChatProps;
  host: TaskDetailHost;
  task: TaskSummary | undefined;
  transcript: ChatTranscriptController;
}): TemplateResult {
  const { backgroundTasks, task } = params;
  if (!task) {
    resetTaskDetail(params.host);
    return html`
      <div class="sidebar-panel chat-task-detail" data-task-detail-panel>
        ${renderTaskHeader(t("chat.backgroundTasks.taskDetailTitle"))}
        <div class="sidebar-content chat-task-detail__state">
          ${t("chat.backgroundTasks.taskUnavailable")}
        </div>
      </div>
    `;
  }
  const detailedTask = backgroundTasks.taskDetails.get(task.id);
  const currentTask = newestTaskSnapshot(task, detailedTask);
  // A subagent's sessionKey is its requester's conversation, never its own
  // work; only the child session is that task's transcript.
  const transcriptSessionKey = normalizeOptionalString(
    currentTask.runtime === "subagent"
      ? currentTask.childSessionKey
      : (currentTask.childSessionKey ?? currentTask.sessionKey),
  );
  const canonicalTranscriptKey = canonicalUiSessionKeyForPersistence(
    params.host,
    transcriptSessionKey,
  );
  const canonicalPaneKey = canonicalUiSessionKeyForPersistence(params.host, params.host.sessionKey);
  // A task pointing at this pane's canonical session uses the inspector. Mirroring
  // the current conversation into its own detail sidebar would duplicate the chat.
  const content =
    transcriptSessionKey && canonicalTranscriptKey !== canonicalPaneKey
      ? renderTaskTranscript({ ...params, task: currentTask, sessionKey: transcriptSessionKey })
      : renderTaskFallback(currentTask, backgroundTasks, params.host);
  return html`
    <div class="sidebar-panel chat-task-detail" data-task-detail-panel>
      ${renderTaskHeader(taskTitle(currentTask), currentTask, backgroundTasks)} ${content}
    </div>
  `;
}

// No close button here on purpose: the sidebar region header owns the
// "Close Details" control for every detail-slot panel (the classic panel is
// embedded with its own header hidden); a second X 40px away duplicated it.
function renderTaskHeader(
  title: string,
  task?: TaskSummary,
  backgroundTasks?: BackgroundTasksProps,
): TemplateResult {
  const active = task ? isActiveTask(task) : false;
  const startedMs = task ? taskTimestampMs(task.startedAt ?? task.createdAt) : 0;
  const cancelling = task ? backgroundTasks?.cancellingTaskIds.has(task.id) === true : false;
  return html`
    <div class="sidebar-header chat-task-detail__header">
      <div class="chat-task-detail__heading">
        <div class="sidebar-title" title=${title}>${title}</div>
        ${task
          ? html`<div class="chat-task-detail__meta">
              ${task.status === "running"
                ? html`<span class="chat-tasks-rail__task-pulse" aria-hidden="true"></span>`
                : nothing}
              <span
                class="chat-tasks-rail__task-status chat-tasks-rail__task-status--${STATUS_TONES[
                  task.status
                ]}"
                >${backgroundTaskStatusLabel(task)}</span
              >
              <span aria-hidden="true">·</span>
              <span>${taskRuntimeLabel(task)}</span>
              ${active && startedMs > 0
                ? html`<span aria-hidden="true">·</span>
                    <openclaw-elapsed-time .startMs=${startedMs}></openclaw-elapsed-time>`
                : nothing}
              ${task.lastToolName
                ? html`<span aria-hidden="true">·</span>
                    <span class="chat-task-detail__tool">${task.lastToolName}</span>`
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

function renderTaskTranscript(params: {
  chat: ChatProps;
  host: TaskDetailHost;
  sessionKey: string;
  task: TaskSummary;
  transcript: ChatTranscriptController;
}): TemplateResult {
  const load = readTaskTranscript(params.host, {
    taskId: params.task.id,
    sessionKey: params.sessionKey,
  });
  if (load.status === "loading") {
    return html`<div class="sidebar-content chat-task-detail__state">
      ${t("chat.backgroundTasks.transcriptLoading")}
    </div>`;
  }
  if (load.status === "error") {
    return html`<div class="sidebar-content chat-task-detail__state chat-task-detail__state--error">
      ${t("chat.backgroundTasks.transcriptFailed")}
    </div>`;
  }
  if (load.messages.length === 0) {
    return html`<div class="sidebar-content chat-task-detail__state">
      ${t("chat.backgroundTasks.transcriptEmpty")}
    </div>`;
  }
  return html`<div class="sidebar-content chat-task-detail__content">
    <div class="chat-task-detail__transcript">
      ${renderReadOnlyTranscript({
        chat: params.chat,
        messages: load.messages,
        paneId: `${params.chat.paneId}:task-sidebar`,
        sessionKey: params.sessionKey,
        transcript: params.transcript,
      })}
    </div>
  </div>`;
}

function renderTaskFallback(
  task: TaskSummary,
  backgroundTasks: BackgroundTasksProps,
  host: TaskDetailHost,
): TemplateResult {
  resetTaskDetail(host);
  if (
    !backgroundTasks.taskDetails.has(task.id) &&
    !backgroundTasks.taskDetailErrors.has(task.id) &&
    !backgroundTasks.taskDetailLoadingIds.has(task.id)
  ) {
    backgroundTasks.onLoadDetail?.(task);
  }
  return html`<div class="sidebar-content chat-task-detail__fallback">
    ${renderTaskInspector(task, backgroundTasks)}
  </div>`;
}

function renderTaskInspector(task: TaskSummary, props: BackgroundTasksProps): TemplateResult {
  const detailedTask = props.taskDetails.get(task.id);
  const newest = newestTaskSnapshot(task, detailedTask);
  const output = taskDetail(newest);
  const detailLoading = props.taskDetailLoadingIds.has(task.id);
  const detailError = props.taskDetailErrors.get(task.id);
  return html`
    ${detailError
      ? html`<div
          class="chat-tasks-rail__task-inspector-state chat-tasks-rail__task-inspector-state--error"
        >
          ${detailError}
          <!-- The render-driven load skips errored tasks to avoid a per-paint
               retry loop, so without this the panel dead-ends whenever the task
               row that could re-open it is not on screen. -->
          <button
            class="chat-tasks-rail__task-inspector-retry"
            type="button"
            ?disabled=${detailLoading}
            @click=${() => props.onLoadDetail?.(task)}
          >
            ${t("chat.backgroundTasks.detailRetry")}
          </button>
        </div>`
      : nothing}
    <div class="chat-tasks-rail__detail-blocks">
      <section class="chat-tasks-rail__task-inspector-block">
        <div class="chat-tasks-rail__task-inspector-label">${t("chat.backgroundTasks.prompt")}</div>
        <pre>
${detailLoading
            ? t("chat.backgroundTasks.detailLoading")
            : (detailedTask?.prompt ?? t("chat.backgroundTasks.promptUnavailable"))}</pre>
      </section>
      <section class="chat-tasks-rail__task-inspector-block">
        <div class="chat-tasks-rail__task-inspector-label">${t("chat.backgroundTasks.output")}</div>
        <pre>${output ?? t("chat.backgroundTasks.outputPending")}</pre>
      </section>
    </div>
  `;
}
