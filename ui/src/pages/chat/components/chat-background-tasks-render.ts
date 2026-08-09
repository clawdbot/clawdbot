import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { isActiveTask, partitionTasks, taskTitle } from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { renderTaskDetail, renderTaskRow } from "./chat-background-task-row.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";

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
  transcript: TemplateResult | typeof nothing = nothing,
): TemplateResult | typeof nothing {
  // Collapsed rails render nothing at all — no icon strip. Reopening happens
  // through renderBackgroundTasksToggle.
  if (!backgroundTasks || backgroundTasks.collapsed) {
    return nothing;
  }
  const view = backgroundTasks.view;
  const viewedTask =
    view.kind === "list"
      ? undefined
      : backgroundTasks.tasks?.find((task) => task.id === view.taskId);
  const selectedTask = view.kind === "detail" ? viewedTask : undefined;
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
        ${view.kind !== "list" && viewedTask
          ? html`
              <button
                class="btn btn--ghost btn--sm chat-tasks-rail__back"
                type="button"
                aria-label=${view.kind === "transcript" && view.returnTo === "detail"
                  ? t("chat.backgroundTasks.backToDetail")
                  : t("chat.backgroundTasks.backToTasks")}
                @click=${backgroundTasks.onBack}
              >
                ${icons.arrowLeft}
              </button>
              <div class="chat-tasks-rail__title">
                <span class="chat-tasks-rail__eyebrow"
                  >${view.kind === "transcript"
                    ? t("chat.backgroundTasks.transcriptTitle")
                    : t("chat.backgroundTasks.detailTitle")}</span
                >
                <strong title=${taskTitle(viewedTask)}>${taskTitle(viewedTask)}</strong>
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
      ${view.kind === "transcript"
        ? html`<div class="chat-tasks-rail__transcript" data-task-transcript=${view.taskId}>
            ${view.load.status === "loading"
              ? html`<div class="chat-tasks-rail__state">
                  ${t("chat.backgroundTasks.transcriptLoading")}
                </div>`
              : view.load.status === "error"
                ? html`<div class="chat-tasks-rail__state chat-tasks-rail__state--error">
                    ${t("chat.backgroundTasks.transcriptFailed")}
                  </div>`
                : view.load.messages.length === 0
                  ? html`<div class="chat-tasks-rail__state">
                      ${t("chat.backgroundTasks.transcriptEmpty")}
                    </div>`
                  : transcript}
          </div>`
        : selectedTask
          ? html`<div class="chat-tasks-rail__scroll">
              ${renderTaskDetail(selectedTask, backgroundTasks)}
            </div>`
          : html`
              ${backgroundTasks.loading && !loaded
                ? html`<div class="chat-tasks-rail__state">
                    ${t("chat.backgroundTasks.loading")}
                  </div>`
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
