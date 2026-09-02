import { html, nothing } from "lit";
import "../../components/agent-select-registration.ts";
import { icons } from "../../components/icons.ts";
import { renderLoadingState } from "../../components/loading-state.ts";
import "../../components/modal-dialog.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/workboard.css";
import {
  dispatchWorkboard,
  filterWorkboardCardsForPreset,
  getWorkboardState,
  refreshWorkboard,
  summarizeWorkboardHealth,
  workboardHasActiveWrites,
  WORKBOARD_PRIORITIES,
  type WorkboardCard,
  type WorkboardHealthKey,
  type WorkboardHealthSummary,
  type WorkboardStatus,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";
import {
  buildAgentFilterOptions,
  matchesAgentFilter,
  matchesAgentScope,
  normalizeActiveAgentFilter,
} from "./agent-filter.ts";
import {
  buildBoardFilterOptions,
  matchesBoardFilter,
  WORKBOARD_ALL_BOARDS_FILTER,
} from "./board-filter.ts";
import { getVisibleDetailCard, renderCardDetailsPanel } from "./view-card-details.ts";
import { openCreateModal, renderCardModal, workboardCardModalId } from "./view-card-modal.ts";
import { renderColumn } from "./view-card.ts";
import {
  canMutate,
  formatPriorityLabel,
  formatRefreshTime,
  matchesFilter,
  type WorkboardProps,
} from "./view-helpers.ts";
import { renderWorkboardSelect, type WorkboardSelectOption } from "./workboard-select.ts";

function renderDispatchSummary(state: WorkboardUiState) {
  const summary = state.lastDispatchSummary;
  if (!summary) {
    return nothing;
  }
  const total = Object.values(summary).reduce((sum, count) => sum + count, 0);
  const key = total === 0 ? "workboard.dispatchSummaryEmpty" : "workboard.dispatchSummary";
  return html`
    <div class="callout">
      ${t(key, {
        started: String(summary.started),
        failures: String(summary.failures),
        promoted: String(summary.promoted),
        blocked: String(summary.blocked),
        reclaimed: String(summary.reclaimed),
        orchestrated: String(summary.orchestrated),
      })}
    </div>
  `;
}

function renderHealthStrip(
  state: WorkboardUiState,
  summary: WorkboardHealthSummary,
  requestUpdate?: () => void,
) {
  const items: Array<[WorkboardHealthKey, string, number]> = [
    ["running", t("workboard.healthRunning"), summary.running],
    ["blocked", t("workboard.healthBlocked"), summary.blocked],
    ["stale", t("workboard.healthStale"), summary.stale],
    ["readyUnassigned", t("workboard.healthReadyUnassigned"), summary.readyUnassigned],
    ["missingProof", t("workboard.healthMissingProof"), summary.missingProof],
    ["failedAttempts", t("workboard.healthFailedAttempts"), summary.failedAttempts],
  ];
  return html`
    <div class="workboard-health" aria-label=${t("workboard.healthLabel")}>
      ${items.map(
        ([key, label, count]) => html`
          <button
            class="workboard-health__item workboard-health__item--${key} ${state.activeHealthHighlight ===
            key
              ? "workboard-health__item--active"
              : ""} ${count === 0 ? "workboard-health__item--empty" : ""}"
            type="button"
            aria-pressed=${state.activeHealthHighlight === key}
            aria-label=${`${count} ${label}`}
            @click=${() => {
              state.activeHealthHighlight = state.activeHealthHighlight === key ? null : key;
              requestUpdate?.();
            }}
          >
            <strong>${count}</strong>${label}
          </button>
        `,
      )}
    </div>
  `;
}

function renderRefreshStatus(state: WorkboardUiState) {
  if (state.lastRefreshAt) {
    return html`<span
      class="workboard-refresh-status ${state.lastRefreshError
        ? "workboard-refresh-status--error"
        : ""}"
      title=${state.lastRefreshError ? t("workboard.refreshError") : ""}
    >
      ${t("workboard.lastRefreshed", { time: formatRefreshTime(state.lastRefreshAt) })}
    </span>`;
  }
  return state.lastRefreshError
    ? html`<span class="workboard-refresh-status workboard-refresh-status--error">
        ${t("workboard.refreshError")}
      </span>`
    : nothing;
}

const viewPresetOptions: Array<{ value: WorkboardUiState["viewPreset"]; labelKey: string }> = [
  { value: "all", labelKey: "workboard.viewAll" },
  { value: "default_agent", labelKey: "workboard.viewDefaultAgent" },
  { value: "ready", labelKey: "workboard.viewReady" },
  { value: "running", labelKey: "workboard.viewRunning" },
  { value: "blocked", labelKey: "workboard.viewBlocked" },
  { value: "review", labelKey: "workboard.viewReview" },
  { value: "stale", labelKey: "workboard.viewStale" },
  { value: "missing_proof", labelKey: "workboard.viewMissingProof" },
  { value: "recently_done", labelKey: "workboard.viewRecentlyDone" },
];

const layoutOptions = [
  ["compact", "workboard.layoutCompact", icons.layoutCompact],
  ["comfortable", "workboard.layoutComfortable", icons.layoutComfortable],
] as const;

const emptyColumnModeOptions = [
  ["show", "workboard.showEmptyColumns"],
  ["collapse", "workboard.collapseEmptyColumns"],
  ["hide", "workboard.hideEmptyColumns"],
] as const;

export function renderWorkboard(props: WorkboardProps) {
  const state = getWorkboardState(props.host);

  if (props.pluginEnabled === null) {
    if (props.pluginEnablementError) {
      return html`
        <section class="workboard">
          <div class="callout danger" role="alert">${props.pluginEnablementError}</div>
          ${props.onReloadConfig
            ? html`<button class="btn" type="button" @click=${props.onReloadConfig}>
                ${t("lazyView.retry")}
              </button>`
            : nothing}
        </section>
      `;
    }
    return renderLoadingState();
  }

  if (!props.pluginEnabled) {
    return html`
      <section class="workboard">
        <div class="callout">
          ${t("workboard.disabledHelpStart")}
          <code>${t("workboard.enableConfigKey")}</code>${t("workboard.disabledHelpEnd")}
        </div>
      </section>
    `;
  }

  const agentOptions = buildAgentFilterOptions(props.agentsList, state.cards);
  state.agentFilter = normalizeActiveAgentFilter(agentOptions, state.agentFilter);
  const boardOptions = buildBoardFilterOptions(state.boards, state.cards);
  // A valid route can outlive a deleted board. Keep that id as the active
  // filter so the page becomes empty instead of silently showing every card.
  const activeBoardFilter = state.boardFilter;
  const applyNonViewFilters = (cards: readonly WorkboardCard[]) =>
    cards
      .filter((card) => state.showArchived || !card.metadata?.archivedAt)
      .filter((card) => matchesBoardFilter(card, activeBoardFilter))
      .filter((card) => matchesAgentScope(card, props.agentsList, props.scopeAgentId))
      .filter((card) => matchesAgentFilter(card, props.agentsList, state.agentFilter))
      .filter((card) =>
        matchesFilter(card, { query: state.query, priority: state.priorityFilter }),
      );
  const cardsForPreset = (preset: WorkboardUiState["viewPreset"]) =>
    applyNonViewFilters(
      filterWorkboardCardsForPreset({
        cards: state.cards,
        preset,
        tasksByCardId: state.tasksByCardId,
        sessions: props.sessions,
        defaultAgentId: props.agentsList?.defaultId,
      }),
    );
  const filtered = cardsForPreset(state.viewPreset);
  const health = summarizeWorkboardHealth({
    cards: filtered,
    tasksByCardId: state.tasksByCardId,
    sessions: props.sessions,
  });
  const visibleError = state.error ?? state.lifecycleTaskRefreshError;
  const writable = canMutate(props);
  const byStatus = new Map<WorkboardStatus, WorkboardCard[]>();
  for (const status of state.statuses) {
    byStatus.set(status, []);
  }
  for (const card of filtered) {
    byStatus.get(card.status)?.push(card);
  }
  const visibleStatuses =
    state.emptyColumnMode === "hide" || state.viewPreset !== "all"
      ? state.statuses.filter((status) => (byStatus.get(status)?.length ?? 0) > 0)
      : state.statuses;
  const activeFiltering =
    state.viewPreset !== "all" ||
    state.query.trim() !== "" ||
    state.priorityFilter !== "all" ||
    state.agentFilter !== "all" ||
    activeBoardFilter !== WORKBOARD_ALL_BOARDS_FILTER ||
    (!state.showArchived && state.cards.some((card) => card.metadata?.archivedAt));
  const viewOptions: Array<WorkboardSelectOption<WorkboardUiState["viewPreset"]>> =
    viewPresetOptions.map((option) => {
      const count = cardsForPreset(option.value).length;
      return {
        value: option.value,
        label: t(option.labelKey),
        description:
          option.value === "all"
            ? undefined
            : t("workboard.viewPresetCount", { count: String(count) }),
        disabled: option.value !== "all" && count === 0,
      };
    });
  const priorityOptions: Array<WorkboardSelectOption<WorkboardUiState["priorityFilter"]>> = [
    { value: "all", label: t("workboard.allPriorities") },
    ...WORKBOARD_PRIORITIES.map((priority) => ({
      value: priority,
      label: formatPriorityLabel(priority),
    })),
  ];
  const emptyColumnOptions: Array<WorkboardSelectOption<WorkboardUiState["emptyColumnMode"]>> =
    emptyColumnModeOptions.map(([value, labelKey]) => ({ value, label: t(labelKey) }));
  const agentSelectOptions = agentOptions.map((option) => ({
    value: option.id,
    label: option.label,
    description: option.description,
    agent:
      option.id === "all" || option.id === "default"
        ? undefined
        : (props.agentsList?.agents.find((agent) => agent.id === option.id) ?? { id: option.id }),
    icon: option.id === "all" ? icons.users : option.id === "default" ? icons.bot : undefined,
  }));
  const dialogOpen = state.draftOpen || Boolean(getVisibleDetailCard(state));
  return html`
    <section class="workboard">
      <div class="workboard-main" ?inert=${dialogOpen} aria-hidden=${dialogOpen ? "true" : nothing}>
        <div class="workboard-toolbar">
          <div class="workboard-toolbar__filters">
            <input
              class="input"
              type="search"
              title=${t("workboard.searchPlaceholder")}
              placeholder=${t("workboard.searchPlaceholder")}
              .value=${state.query}
              @input=${(event: InputEvent) => {
                state.query = (event.currentTarget as HTMLInputElement).value;
                props.onRequestUpdate?.();
              }}
            />
            ${renderWorkboardSelect({
              value: state.viewPreset,
              options: viewOptions,
              label: t("workboard.viewPreset"),
              onChange: (value) => {
                state.viewPreset = value;
              },
              requestUpdate: props.onRequestUpdate,
              className: "workboard-select--toolbar",
              showLabel: false,
            })}
            ${renderWorkboardSelect({
              value: state.priorityFilter,
              options: priorityOptions,
              label: t("workboard.allPriorities"),
              onChange: (value) => {
                state.priorityFilter = value;
              },
              requestUpdate: props.onRequestUpdate,
              className: "workboard-select--toolbar",
              showLabel: false,
            })}
            ${boardOptions.length >= 3
              ? renderWorkboardSelect({
                  value: activeBoardFilter,
                  options: boardOptions,
                  label: t("workboard.boardFilter"),
                  onChange: (value) => {
                    state.boardFilter = value;
                    props.onBoardFilterChange?.(value);
                  },
                  requestUpdate: props.onRequestUpdate,
                  className: "workboard-select--toolbar workboard-select--toolbar-board",
                  showLabel: false,
                })
              : nothing}
            ${props.showAgentFilter !== false
              ? html`
                  <openclaw-agent-select
                    class="workboard-agent-select workboard-agent-select--toolbar"
                    .options=${agentSelectOptions}
                    .value=${state.agentFilter}
                    .accessibleLabel=${t("workboard.agentFilter")}
                    .onSelect=${(value: string) => {
                      const option = agentOptions.find((candidate) => candidate.id === value);
                      if (option) {
                        state.agentFilter = option.id;
                        props.onRequestUpdate?.();
                      }
                    }}
                  ></openclaw-agent-select>
                `
              : nothing}
            <button
              class="btn workboard-archive-toggle ${state.showArchived ? "active" : ""}"
              type="button"
              aria-pressed=${state.showArchived}
              @click=${() => {
                state.showArchived = !state.showArchived;
                props.onRequestUpdate?.();
              }}
            >
              ${state.showArchived ? icons.eye : icons.eyeOff}
              ${state.showArchived
                ? t("workboard.hideArchivedShort")
                : t("workboard.showArchivedShort")}
            </button>
            <div class="workboard-layout-controls">
              <div class="workboard-layout-toggle" role="group" aria-label=${t("workboard.layout")}>
                ${layoutOptions.map(
                  ([layout, labelKey, icon]) => html`
                    <openclaw-tooltip .content=${t(labelKey)}>
                      <button
                        class="btn btn--icon ${state.layout === layout ? "active" : ""}"
                        type="button"
                        aria-label=${t(labelKey)}
                        aria-pressed=${state.layout === layout}
                        @click=${() => {
                          state.layout = layout;
                          props.onRequestUpdate?.();
                        }}
                      >
                        ${icon}
                      </button>
                    </openclaw-tooltip>
                  `,
                )}
              </div>
              ${renderRefreshStatus(state)}
            </div>
            ${renderWorkboardSelect({
              value: state.emptyColumnMode,
              options: emptyColumnOptions,
              label: t("workboard.emptyColumns"),
              onChange: (value) => {
                state.emptyColumnMode = value;
                state.expandedEmptyStatuses.clear();
              },
              requestUpdate: props.onRequestUpdate,
              className: "workboard-select--toolbar workboard-select--empty-columns",
              showLabel: false,
            })}
          </div>
          <div class="workboard-toolbar__actions">
            <button
              class="btn"
              type="button"
              ?disabled=${state.loading || state.dispatching || workboardHasActiveWrites(state)}
              @click=${() =>
                refreshWorkboard({
                  host: props.host,
                  client: props.client,
                  requestUpdate: props.onRequestUpdate,
                  source: "manual",
                  refreshDiagnostics: props.canWrite !== false,
                })}
            >
              ${state.loading ? t("common.refreshing") : t("common.refresh")}
            </button>
            ${writable
              ? html`
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${state.dispatching || workboardHasActiveWrites(state)}
                    @click=${() =>
                      dispatchWorkboard({
                        host: props.host,
                        client: props.client,
                        requestUpdate: props.onRequestUpdate,
                      })}
                  >
                    ${icons.zap} ${t("workboard.dispatch")}
                  </button>
                `
              : nothing}
            ${writable
              ? html`
                  <button
                    class="btn primary"
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded=${state.draftOpen ? "true" : "false"}
                    aria-controls=${workboardCardModalId}
                    ?disabled=${state.dispatching}
                    @click=${() => {
                      openCreateModal(state, props);
                      props.onRequestUpdate?.();
                    }}
                  >
                    ${icons.plus} ${t("workboard.newCard")}
                  </button>
                `
              : nothing}
          </div>
        </div>
        ${renderHealthStrip(state, health, props.onRequestUpdate)}
        ${visibleError ? html`<div class="callout danger">${visibleError}</div>` : nothing}
        ${renderDispatchSummary(state)}
        ${(filtered.length === 0 && activeFiltering) || visibleStatuses.length === 0
          ? html`
              <div class="workboard-empty-state" role="status">
                <strong>${t("workboard.emptyFilteredTitle")}</strong>
                <span>${t("workboard.emptyFilteredHint")}</span>
              </div>
            `
          : html`
              <div
                class="workboard-board workboard-board--page workboard-board--${state.layout} ${visibleStatuses.length ===
                1
                  ? "workboard-board--single-column"
                  : ""}"
              >
                ${visibleStatuses.map((status) =>
                  renderColumn(props, status, byStatus.get(status) ?? []),
                )}
              </div>
            `}
      </div>
      ${renderCardModal(props)} ${renderCardDetailsPanel(props)}
    </section>
  `;
}
