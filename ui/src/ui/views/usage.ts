import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { getUsageCacheRefreshTitle } from "../usage-cache-status.ts";
import { extractQueryTerms, filterSessionsByQuery } from "../usage-helpers.ts";
import {
  buildAggregatesFromSessions,
  buildPeakErrorHours,
  buildUsageInsightStats,
  formatCost,
  formatIsoDate,
  formatTokens,
  renderUsageMosaic,
  sessionTouchesSelectedHours,
} from "./usage-metrics.ts";
import {
  addQueryToken,
  applySuggestionToQuery,
  buildDailyCsv,
  buildQuerySuggestions,
  buildSessionsCsv,
  downloadTextFile,
  normalizeQueryText,
  removeQueryToken,
  setQueryTokensForKey,
} from "./usage-query.ts";
import { renderSessionDetailPanel } from "./usage-render-details.ts";
import {
  renderCostBreakdownCompact,
  renderDailyChartCompact,
  renderFilterChips,
  renderSessionsCard,
  renderUsageInsights,
} from "./usage-render-overview.ts";
import {
  SessionLogEntry,
  SessionLogRole,
  UsageColumnId,
  UsageFilterState,
  UsageProps,
  UsageSessionEntry,
  UsageTotals,
} from "./usageTypes.ts";

export type { UsageColumnId, SessionLogEntry, SessionLogRole };

function createEmptyUsageTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

function addUsageTotals(
  acc: UsageTotals,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    totalCost: number;
    inputCost?: number;
    outputCost?: number;
    cacheReadCost?: number;
    cacheWriteCost?: number;
    missingCostEntries?: number;
  },
): UsageTotals {
  acc.input += usage.input;
  acc.output += usage.output;
  acc.cacheRead += usage.cacheRead;
  acc.cacheWrite += usage.cacheWrite;
  acc.totalTokens += usage.totalTokens;
  acc.totalCost += usage.totalCost;
  acc.inputCost += usage.inputCost ?? 0;
  acc.outputCost += usage.outputCost ?? 0;
  acc.cacheReadCost += usage.cacheReadCost ?? 0;
  acc.cacheWriteCost += usage.cacheWriteCost ?? 0;
  acc.missingCostEntries += usage.missingCostEntries ?? 0;
  return acc;
}

function renderUsageLoadingState(filters: UsageFilterState) {
  return html`
    <section class="card usage-loading-card">
      <div class="usage-loading-header">
        <div class="usage-loading-title-group">
          <div class="card-title usage-section-title">${t("usage.loading.title")}</div>
          <span class="usage-loading-badge">
            <span class="usage-loading-spinner" aria-hidden="true"></span>
            ${t("usage.loading.badge")}
          </span>
        </div>
        <div class="usage-loading-controls">
          <div class="usage-date-range usage-date-range--loading">
            <input class="usage-date-input" type="date" .value=${filters.startDate} disabled />
            <span class="usage-separator">${t("usage.filters.to")}</span>
            <input class="usage-date-input" type="date" .value=${filters.endDate} disabled />
          </div>
        </div>
      </div>
      <div class="usage-loading-grid">
        <div class="usage-skeleton-block usage-skeleton-block--tall"></div>
        <div class="usage-skeleton-block"></div>
        <div class="usage-skeleton-block"></div>
      </div>
    </section>
  `;
}

function renderUsageEmptyState(onRefresh: () => void) {
  return html`
    <section class="card usage-empty-state">
      <div class="usage-empty-state__title">${t("usage.empty.title")}</div>
      <div class="card-sub usage-empty-state__subtitle">${t("usage.empty.subtitle")}</div>
      <div class="usage-empty-state__features">
        <span class="usage-empty-state__feature">${t("usage.empty.featureOverview")}</span>
        <span class="usage-empty-state__feature">${t("usage.empty.featureSessions")}</span>
        <span class="usage-empty-state__feature">${t("usage.empty.featureTimeline")}</span>
      </div>
      <div class="usage-empty-state__actions">
        <button class="btn primary" @click=${onRefresh}>${t("common.refresh")}</button>
      </div>
    </section>
  `;
}

export function renderUsage(props: UsageProps) {
  const { data, filters, display, detail, callbacks } = props;
  const filterActions = callbacks.filters;
  const displayActions = callbacks.display;
  const detailActions = callbacks.details;

  if (data.loading && !data.totals) {
    return html`<div class="usage-page">${renderUsageLoadingState(filters)}</div>`;
  }

  const isTokenMode = display.chartMode === "tokens";
  const hasQuery = filters.query.trim().length > 0;
  const hasDraftQuery = filters.queryDraft.trim().length > 0;

  // Sort sessions by tokens or cost depending on mode
  const sortedSessions = [...data.sessions].toSorted((a, b) => {
    const valA = isTokenMode ? (a.usage?.totalTokens ?? 0) : (a.usage?.totalCost ?? 0);
    const valB = isTokenMode ? (b.usage?.totalTokens ?? 0) : (b.usage?.totalCost ?? 0);
    return valB - valA;
  });

  // Filter sessions by selected days
  const dayFilteredSessions =
    filters.selectedDays.length > 0
      ? sortedSessions.filter((s) => {
          if (s.usage?.activityDates?.length) {
            return s.usage.activityDates.some((d) => filters.selectedDays.includes(d));
          }
          if (!s.updatedAt) {
            return false;
          }
          const d = new Date(s.updatedAt);
          const sessionDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          return filters.selectedDays.includes(sessionDate);
        })
      : sortedSessions;

  const hourFilteredSessions =
    filters.selectedHours.length > 0
      ? dayFilteredSessions.filter((s) =>
          sessionTouchesSelectedHours(s, filters.selectedHours, filters.timeZone),
        )
      : dayFilteredSessions;

  // Filter sessions by query (client-side)
  const queryResult = filterSessionsByQuery(hourFilteredSessions, filters.query);
  const filteredSessions = queryResult.sessions;
  const queryWarnings = queryResult.warnings;
  const querySuggestions = buildQuerySuggestions(
    filters.queryDraft,
    sortedSessions,
    data.aggregates,
  );
  const queryTerms = extractQueryTerms(filters.query);
  const selectedValuesFor = (key: string): string[] => {
    const normalized = normalizeQueryText(key);
    return queryTerms
      .filter((term) => normalizeQueryText(term.key ?? "") === normalized)
      .map((term) => term.value)
      .filter(Boolean);
  };
  const unique = (items: Array<string | undefined>) => {
    const set = new Set<string>();
    for (const item of items) {
      if (item) {
        set.add(item);
      }
    }
    return Array.from(set);
  };
  const agentOptions = unique(sortedSessions.map((s) => s.agentId)).slice(0, 12);
  const channelOptions = unique(sortedSessions.map((s) => s.channel)).slice(0, 12);
  const providerOptions = unique([
    ...sortedSessions.map((s) => s.modelProvider),
    ...sortedSessions.map((s) => s.providerOverride),
    ...(data.aggregates?.byProvider.map((entry) => entry.provider) ?? []),
  ]).slice(0, 12);
  const modelOptions = unique([
    ...sortedSessions.map((s) => s.model),
    ...(data.aggregates?.byModel.map((entry) => entry.model) ?? []),
  ]).slice(0, 12);
  const toolOptions = unique(data.aggregates?.tools.tools.map((tool) => tool.name) ?? []).slice(
    0,
    12,
  );

  // Get first selected session for detail view (timeseries, logs)
  const primarySelectedEntry =
    filters.selectedSessions.length === 1
      ? (data.sessions.find((s) => s.key === filters.selectedSessions[0]) ??
        filteredSessions.find((s) => s.key === filters.selectedSessions[0]))
      : null;

  // Compute totals from sessions
  const computeSessionTotals = (sessions: UsageSessionEntry[]): UsageTotals => {
    return sessions.reduce(
      (acc, s) => (s.usage ? addUsageTotals(acc, s.usage) : acc),
      createEmptyUsageTotals(),
    );
  };

  // Compute totals from daily data for selected days (more accurate than session totals)
  const computeDailyTotals = (days: string[]): UsageTotals => {
    const matchingDays = data.costDaily.filter((d) => days.includes(d.date));
    return matchingDays.reduce((acc, day) => addUsageTotals(acc, day), createEmptyUsageTotals());
  };

  // Compute display totals and count based on filters
  let displayTotals: UsageTotals | null;
  let displaySessionCount: number;
  const totalSessions = sortedSessions.length;

  if (filters.selectedSessions.length > 0) {
    // Sessions selected - compute totals from selected sessions
    const selectedSessionEntries = filteredSessions.filter((s) =>
      filters.selectedSessions.includes(s.key),
    );
    displayTotals = computeSessionTotals(selectedSessionEntries);
    displaySessionCount = selectedSessionEntries.length;
  } else if (filters.selectedDays.length > 0 && filters.selectedHours.length === 0) {
    // Days selected - use daily aggregates for accurate per-day totals
    displayTotals = computeDailyTotals(filters.selectedDays);
    displaySessionCount = filteredSessions.length;
  } else if (filters.selectedHours.length > 0) {
    displayTotals = computeSessionTotals(filteredSessions);
    displaySessionCount = filteredSessions.length;
  } else if (hasQuery) {
    displayTotals = computeSessionTotals(filteredSessions);
    displaySessionCount = filteredSessions.length;
  } else {
    // No filters - show all
    displayTotals = data.totals;
    displaySessionCount = totalSessions;
  }

  const aggregateSessions =
    filters.selectedSessions.length > 0
      ? filteredSessions.filter((s) => filters.selectedSessions.includes(s.key))
      : hasQuery || filters.selectedHours.length > 0
        ? filteredSessions
        : filters.selectedDays.length > 0
          ? dayFilteredSessions
          : sortedSessions;
  const activeAggregates = buildAggregatesFromSessions(aggregateSessions, data.aggregates);

  // Filter daily chart data if sessions are selected
  const filteredDaily =
    filters.selectedSessions.length > 0
      ? (() => {
          const selectedEntries = filteredSessions.filter((s) =>
            filters.selectedSessions.includes(s.key),
          );
          const allActivityDates = new Set<string>();
          for (const entry of selectedEntries) {
            for (const date of entry.usage?.activityDates ?? []) {
              allActivityDates.add(date);
            }
          }
          return allActivityDates.size > 0
            ? data.costDaily.filter((d) => allActivityDates.has(d.date))
            : data.costDaily;
        })()
      : data.costDaily;

  const insightStats = buildUsageInsightStats(aggregateSessions, displayTotals, activeAggregates);
  const isEmpty = !data.loading && !data.totals && data.sessions.length === 0;
  const cacheStatusTitle = getUsageCacheRefreshTitle(data.cacheStatus);
  const hasMissingCost =
    (displayTotals?.missingCostEntries ?? 0) > 0 ||
    (displayTotals
      ? displayTotals.totalTokens > 0 &&
        displayTotals.totalCost === 0 &&
        displayTotals.input +
          displayTotals.output +
          displayTotals.cacheRead +
          displayTotals.cacheWrite >
          0
      : false);
  const datePresets = [
    { label: t("usage.presets.today"), days: 1 },
    { label: t("usage.presets.last7d"), days: 7 },
    { label: t("usage.presets.last30d"), days: 30 },
  ];
  const applyPreset = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    filterActions.onStartDateChange(formatIsoDate(start));
    filterActions.onEndDateChange(formatIsoDate(end));
  };
  const renderFilterSelect = (key: string, label: string, options: string[]) => {
    if (options.length === 0) {
      return nothing;
    }
    const selected = selectedValuesFor(key);
    const selectedSet = new Set(selected.map((value) => normalizeQueryText(value)));
    const allSelected =
      options.length > 0 && options.every((value) => selectedSet.has(normalizeQueryText(value)));
    const selectedCount = selected.length;
    return html`
      <details
        class="usage-filter-select"
        @toggle=${(e: Event) => {
          const el = e.currentTarget as HTMLDetailsElement;
          if (!el.open) {
            return;
          }
          const onClick = (ev: MouseEvent) => {
            const path = ev.composedPath();
            if (!path.includes(el)) {
              el.open = false;
              window.removeEventListener("click", onClick, true);
            }
          };
          window.addEventListener("click", onClick, true);
        }}
      >
        <summary>
          <span>${label}</span>
          ${selectedCount > 0
            ? html`<span class="usage-filter-badge">${selectedCount}</span>`
            : html` <span class="usage-filter-badge">${t("usage.filters.all")}</span> `}
        </summary>
        <div class="usage-filter-popover">
          <div class="usage-filter-actions">
            <button
              class="btn btn--sm"
              @click=${(e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                filterActions.onQueryDraftChange(
                  setQueryTokensForKey(filters.queryDraft, key, options),
                );
              }}
              ?disabled=${allSelected}
            >
              ${t("usage.filters.selectAll")}
            </button>
            <button
              class="btn btn--sm"
              @click=${(e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                filterActions.onQueryDraftChange(setQueryTokensForKey(filters.queryDraft, key, []));
              }}
              ?disabled=${selectedCount === 0}
            >
              ${t("usage.filters.clear")}
            </button>
          </div>
          <div class="usage-filter-options">
            ${options.map((value) => {
              const checked = selectedSet.has(normalizeQueryText(value));
              return html`
                <label class="usage-filter-option">
                  <input
                    type="checkbox"
                    .checked=${checked}
                    @change=${(e: Event) => {
                      const target = e.target as HTMLInputElement;
                      const token = `${key}:${value}`;
                      filterActions.onQueryDraftChange(
                        target.checked
                          ? addQueryToken(filters.queryDraft, token)
                          : removeQueryToken(filters.queryDraft, token),
                      );
                    }}
                  />
                  <span>${value}</span>
                </label>
              `;
            })}
          </div>
        </div>
      </details>
    `;
  };
  const exportStamp = formatIsoDate(new Date());

  return html`
    <div class="usage-page">
      <section class="usage-page-header">
        <div class="usage-page-title">${t("tabs.usage")}</div>
        <div class="usage-page-subtitle">${t("usage.page.subtitle")}</div>
      </section>

      <section class="card usage-header ${display.headerPinned ? "pinned" : ""}">
        <div class="usage-header-row">
          <div class="usage-header-title">
            <div class="card-title usage-section-title">${t("usage.filters.title")}</div>
            ${data.loading || cacheStatusTitle
              ? html`<span class="usage-refresh-indicator" title=${cacheStatusTitle ?? ""}>
                  ${t("usage.loading.badge")}
                </span>`
              : nothing}
            ${isEmpty
              ? html`<span class="usage-query-hint">${t("usage.empty.hint")}</span>`
              : nothing}
          </div>
          <div class="usage-header-metrics">
            ${displayTotals
              ? html`
                  <span class="usage-metric-badge">
                    <strong>${formatTokens(displayTotals.totalTokens)}</strong>
                    ${t("usage.metrics.tokens")}
                  </span>
                  <span class="usage-metric-badge">
                    <strong>${formatCost(displayTotals.totalCost)}</strong>
                    ${t("usage.metrics.cost")}
                  </span>
                  <span class="usage-metric-badge">
                    <strong>${displaySessionCount}</strong>
                    ${displaySessionCount === 1
                      ? t("usage.metrics.session")
                      : t("usage.metrics.sessions")}
                  </span>
                `
              : nothing}
            <button
              class="btn btn--sm usage-pin-btn ${display.headerPinned ? "active" : ""}"
              title=${display.headerPinned ? t("usage.filters.unpin") : t("usage.filters.pin")}
              @click=${filterActions.onToggleHeaderPinned}
            >
              ${display.headerPinned ? t("usage.filters.pinned") : t("usage.filters.pin")}
            </button>
            <details
              class="usage-export-menu"
              @toggle=${(e: Event) => {
                const el = e.currentTarget as HTMLDetailsElement;
                if (!el.open) {
                  return;
                }
                const onClick = (ev: MouseEvent) => {
                  const path = ev.composedPath();
                  if (!path.includes(el)) {
                    el.open = false;
                    window.removeEventListener("click", onClick, true);
                  }
                };
                window.addEventListener("click", onClick, true);
              }}
            >
              <summary class="btn btn--sm">${t("usage.export.label")} ▾</summary>
              <div class="usage-export-popover">
                <div class="usage-export-list">
                  <button
                    class="usage-export-item"
                    @click=${() =>
                      downloadTextFile(
                        `openclaw-usage-sessions-${exportStamp}.csv`,
                        buildSessionsCsv(filteredSessions),
                        "text/csv",
                      )}
                    ?disabled=${filteredSessions.length === 0}
                  >
                    ${t("usage.export.sessionsCsv")}
                  </button>
                  <button
                    class="usage-export-item"
                    @click=${() =>
                      downloadTextFile(
                        `openclaw-usage-daily-${exportStamp}.csv`,
                        buildDailyCsv(filteredDaily),
                        "text/csv",
                      )}
                    ?disabled=${filteredDaily.length === 0}
                  >
                    ${t("usage.export.dailyCsv")}
                  </button>
                  <button
                    class="usage-export-item"
                    @click=${() =>
                      downloadTextFile(
                        `openclaw-usage-${exportStamp}.json`,
                        JSON.stringify(
                          {
                            totals: displayTotals,
                            sessions: filteredSessions,
                            daily: filteredDaily,
                            aggregates: activeAggregates,
                          },
                          null,
                          2,
                        ),
                        "application/json",
                      )}
                    ?disabled=${filteredSessions.length === 0 && filteredDaily.length === 0}
                  >
                    ${t("usage.export.json")}
                  </button>
                </div>
              </div>
            </details>
          </div>
        </div>

        <div class="usage-header-row">
          <div class="usage-controls">
            ${renderFilterChips(
              filters.selectedDays,
              filters.selectedHours,
              filters.selectedSessions,
              data.sessions,
              filterActions.onClearDays,
              filterActions.onClearHours,
              filterActions.onClearSessions,
              filterActions.onClearFilters,
            )}
            <div class="usage-presets">
              ${datePresets.map(
                (preset) => html`
                  <button class="btn btn--sm" @click=${() => applyPreset(preset.days)}>
                    ${preset.label}
                  </button>
                `,
              )}
            </div>
            <div class="usage-date-range">
              <input
                class="usage-date-input"
                type="date"
                .value=${filters.startDate}
                title=${t("usage.filters.startDate")}
                aria-label=${t("usage.filters.startDate")}
                @change=${(e: Event) =>
                  filterActions.onStartDateChange((e.target as HTMLInputElement).value)}
              />
              <span class="usage-separator">${t("usage.filters.to")}</span>
              <input
                class="usage-date-input"
                type="date"
                .value=${filters.endDate}
                title=${t("usage.filters.endDate")}
                aria-label=${t("usage.filters.endDate")}
                @change=${(e: Event) =>
                  filterActions.onEndDateChange((e.target as HTMLInputElement).value)}
              />
            </div>
            <select
              class="usage-select"
              title=${t("usage.filters.timeZone")}
              aria-label=${t("usage.filters.timeZone")}
              .value=${filters.timeZone}
              @change=${(e: Event) =>
                filterActions.onTimeZoneChange(
                  (e.target as HTMLSelectElement).value as "local" | "utc",
                )}
            >
              <option value="local">${t("usage.filters.timeZoneLocal")}</option>
              <option value="utc">${t("usage.filters.timeZoneUtc")}</option>
            </select>
            <div class="chart-toggle">
              <button
                class="btn btn--sm toggle-btn ${isTokenMode ? "active" : ""}"
                @click=${() => displayActions.onChartModeChange("tokens")}
              >
                ${t("usage.metrics.tokens")}
              </button>
              <button
                class="btn btn--sm toggle-btn ${!isTokenMode ? "active" : ""}"
                @click=${() => displayActions.onChartModeChange("cost")}
              >
                ${t("usage.metrics.cost")}
              </button>
            </div>
            <button
              class="btn btn--sm primary"
              @click=${filterActions.onRefresh}
              ?disabled=${data.loading}
            >
              ${t("common.refresh")}
            </button>
          </div>
        </div>

        <div class="usage-query-section">
          <div class="usage-query-bar">
            <input
              class="usage-query-input"
              type="text"
              .value=${filters.queryDraft}
              placeholder=${t("usage.query.placeholder")}
              @input=${(e: Event) =>
                filterActions.onQueryDraftChange((e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  filterActions.onApplyQuery();
                }
              }}
            />
            <div class="usage-query-actions">
              <button
                class="btn btn--sm"
                @click=${filterActions.onApplyQuery}
                ?disabled=${data.loading || (!hasDraftQuery && !hasQuery)}
              >
                ${t("usage.query.apply")}
              </button>
              ${hasDraftQuery || hasQuery
                ? html`
                    <button class="btn btn--sm" @click=${filterActions.onClearQuery}>
                      ${t("usage.filters.clear")}
                    </button>
                  `
                : nothing}
              <span class="usage-query-hint">
                ${hasQuery
                  ? t("usage.query.matching", {
                      shown: String(filteredSessions.length),
                      total: String(totalSessions),
                    })
                  : t("usage.query.inRange", { total: String(totalSessions) })}
              </span>
            </div>
          </div>
          <div class="usage-filter-row">
            ${renderFilterSelect("agent", t("usage.filters.agent"), agentOptions)}
            ${renderFilterSelect("channel", t("usage.filters.channel"), channelOptions)}
            ${renderFilterSelect("provider", t("usage.filters.provider"), providerOptions)}
            ${renderFilterSelect("model", t("usage.filters.model"), modelOptions)}
            ${renderFilterSelect("tool", t("usage.filters.tool"), toolOptions)}
            <span class="usage-query-hint">${t("usage.query.tip")}</span>
          </div>
          ${queryTerms.length > 0
            ? html`
                <div class="usage-query-chips">
                  ${queryTerms.map((term) => {
                    const label = term.raw;
                    return html`
                      <span class="usage-query-chip">
                        ${label}
                        <button
                          title=${t("usage.filters.remove")}
                          @click=${() =>
                            filterActions.onQueryDraftChange(
                              removeQueryToken(filters.queryDraft, label),
                            )}
                        >
                          ×
                        </button>
                      </span>
                    `;
                  })}
                </div>
              `
            : nothing}
          ${querySuggestions.length > 0
            ? html`
                <div class="usage-query-suggestions">
                  ${querySuggestions.map(
                    (suggestion) => html`
                      <button
                        class="usage-query-suggestion"
                        @click=${() =>
                          filterActions.onQueryDraftChange(
                            applySuggestionToQuery(filters.queryDraft, suggestion.value),
                          )}
                      >
                        ${suggestion.label}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing}
          ${queryWarnings.length > 0
            ? html`
                <div class="callout warning usage-callout usage-callout--tight">
                  ${queryWarnings.join(" · ")}
                </div>
              `
            : nothing}
        </div>

        ${data.error
          ? html`<div class="callout danger usage-callout">${data.error}</div>`
          : nothing}
        ${cacheStatusTitle
          ? html`
              <div class="callout warning usage-callout usage-cache-warning">
                ${t("usage.cacheStatus.warning")} ${cacheStatusTitle}
              </div>
            `
          : nothing}
        ${data.sessionsLimitReached
          ? html`
              <div class="callout warning usage-callout">${t("usage.sessions.limitReached")}</div>
            `
          : nothing}
      </section>

      ${isEmpty
        ? renderUsageEmptyState(filterActions.onRefresh)
        : html`
            ${renderUsageInsights(
              displayTotals,
              activeAggregates,
              insightStats,
              hasMissingCost,
              buildPeakErrorHours(aggregateSessions, filters.timeZone),
              displaySessionCount,
              totalSessions,
            )}
            ${renderUsageMosaic(
              aggregateSessions,
              filters.timeZone,
              filters.selectedHours,
              filterActions.onSelectHour,
            )}

            <div class="usage-grid">
              <div class="usage-grid-column">
                <div class="card usage-left-card">
                  ${renderDailyChartCompact(
                    filteredDaily,
                    filters.selectedDays,
                    display.chartMode,
                    display.dailyChartMode,
                    displayActions.onDailyChartModeChange,
                    filterActions.onSelectDay,
                  )}
                  ${displayTotals
                    ? renderCostBreakdownCompact(displayTotals, display.chartMode)
                    : nothing}
                </div>
                ${renderSessionsCard(
                  filteredSessions,
                  filters.selectedSessions,
                  filters.selectedDays,
                  isTokenMode,
                  display.sessionSort,
                  display.sessionSortDir,
                  display.recentSessions,
                  display.sessionsTab,
                  detailActions.onSelectSession,
                  displayActions.onSessionSortChange,
                  displayActions.onSessionSortDirChange,
                  displayActions.onSessionsTabChange,
                  display.visibleColumns,
                  totalSessions,
                  filterActions.onClearSessions,
                )}
              </div>
              ${primarySelectedEntry
                ? html`<div class="usage-grid-column">
                    ${renderSessionDetailPanel(
                      primarySelectedEntry,
                      detail.timeSeries,
                      detail.timeSeriesLoading,
                      detail.timeSeriesMode,
                      detailActions.onTimeSeriesModeChange,
                      detail.timeSeriesBreakdownMode,
                      detailActions.onTimeSeriesBreakdownChange,
                      detail.timeSeriesCursorStart,
                      detail.timeSeriesCursorEnd,
                      detailActions.onTimeSeriesCursorRangeChange,
                      filters.startDate,
                      filters.endDate,
                      filters.selectedDays,
                      detail.sessionLogs,
                      detail.sessionLogsLoading,
                      detail.sessionLogsExpanded,
                      detailActions.onToggleSessionLogsExpanded,
                      detail.logFilters,
                      detailActions.onLogFilterRolesChange,
                      detailActions.onLogFilterToolsChange,
                      detailActions.onLogFilterHasToolsChange,
                      detailActions.onLogFilterQueryChange,
                      detailActions.onLogFilterClear,
                      display.contextExpanded,
                      detailActions.onToggleContextExpanded,
                      filterActions.onClearSessions,
                    )}
                  </div>`
                : nothing}
            </div>
          `}
    </div>
  `;
}

// Exposed for Playwright/Vitest browser unit tests.
