import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { renderPanelEmptyState } from "../../../components/panel-empty-state.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { partitionTasks } from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { renderTaskRow } from "./chat-background-task-row.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";

export function renderBackgroundTasksToggle(
  backgroundTasks: BackgroundTasksProps | undefined,
): TemplateResult | typeof nothing {
  if (!backgroundTasks) {
    return nothing;
  }
  const expanded = !backgroundTasks.collapsed;
  const label = t(expanded ? "chat.backgroundTasks.collapse" : "chat.backgroundTasks.show");
  return html`<openclaw-tooltip .content=${label}>
    <button
      class="btn btn--ghost btn--icon chat-icon-btn chat-tasks-toggle"
      type="button"
      aria-label=${label}
      aria-expanded=${String(expanded)}
      @click=${backgroundTasks.onToggleCollapsed}
    >
      ${icons.listChecks}
      ${!expanded && backgroundTasks.activeCount > 0
        ? html`<span class="chat-tasks-toggle__badge" aria-hidden="true"
            >${backgroundTasks.activeCount}</span
          >`
        : nothing}
    </button>
  </openclaw-tooltip>`;
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
  options: { embedded?: boolean } = {},
): TemplateResult | typeof nothing {
  // Standalone collapsed rails render nothing; the shared panel menu reopens them.
  if (!backgroundTasks || (backgroundTasks.collapsed && !options.embedded)) {
    return nothing;
  }
  const { active, recent } = partitionTasks(backgroundTasks.tasks ?? []);
  const loaded = backgroundTasks.tasks !== null;
  const empty = loaded && active.length === 0 && recent.length === 0;
  const collapseButton = html`
    <openclaw-tooltip .content=${t("chat.backgroundTasks.collapse")}>
      <button
        type="button"
        class="rail-header__action chat-tasks-rail__collapse-toggle"
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
      ${options.embedded
        ? nothing
        : html`<div class="rail-header chat-tasks-rail__header">
            <div class="rail-header__copy chat-tasks-rail__title">
              <span class="rail-header__eyebrow chat-tasks-rail__eyebrow"
                >${backgroundTasks.sessionKey}</span
              >
              <strong class="rail-header__title">${t("chat.backgroundTasks.title")}</strong>
            </div>
            <div class="rail-header__actions chat-tasks-rail__actions">
              <openclaw-tooltip .content=${t("chat.backgroundTasks.refresh")}>
                <button
                  class="rail-header__action chat-tasks-rail__refresh"
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
          </div>`}
      ${!backgroundTasks.connected
        ? html`<div class="chat-tasks-rail__state">${t("tasksPage.disconnected")}</div>`
        : nothing}
      ${backgroundTasks.error
        ? html`<div class="chat-tasks-rail__state chat-tasks-rail__state--error" role="alert">
            ${backgroundTasks.error}
          </div>`
        : nothing}
      ${backgroundTasks.loading && !loaded
        ? renderPanelLoadingSkeleton("tasks", t("chat.backgroundTasks.loading"))
        : nothing}
      ${empty
        ? renderPanelEmptyState({
            icon: icons.listChecks,
            heading: t("chat.sidePanel.tasks"),
            description: t("chat.sidePanel.tasksEmpty"),
          })
        : nothing}
      <div class="chat-tasks-rail__scroll chat-tasks-rail__scroll--split" ?hidden=${empty}>
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
