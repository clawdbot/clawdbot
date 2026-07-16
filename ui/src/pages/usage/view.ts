// Control UI view renders usage screen content.
import { html, nothing } from "lit";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import { renderSettingsPage, renderSettingsSection } from "../../components/settings-ui.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/usage.css";
import { getUsageCacheRefreshTitle } from "./cache-status.ts";
import type { ProviderUsageSummary } from "./data-types.ts";
import { extractQueryTerms, filterSessionsByQuery } from "./helpers.ts";
import {
  buildAggregatesFromSessions,
  buildPeakErrorHours,
  buildUsageInsightStats,
  formatCost,
  formatIsoDate,
  formatTokens,
  renderUsageMosaic,
  sessionTouchesSelectedHours,
} from "./metrics.ts";
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
} from "./query.ts";
import type { UsageFilterState, UsageProps, UsageSessionEntry, UsageTotals } from "./types.ts";
import { renderSessionDetailPanel } from "./view-details.ts";
import {
  renderCostBreakdownCompact,
  renderCostWindowComparison,
  renderDailyChartCompact,
  renderFilterChips,
  renderSessionsCard,
  renderUsageInsights,
} from "./view-overview.ts";

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

function renderUsageLoadingStatus(label: unknown, title?: string) {
  return html`
    <span class="settings-status settings-status--accent" title=${title ?? nothing}>
      <span class="usage-loading-spinner" aria-hidden="true"></span>
      ${label}
    </span>
  `;
}

function renderUsageLoadingState(filters: UsageFilterState) {
  return renderSettingsSection(
    {
      title: t("usage.loading.title"),
      actions: renderUsageLoadingStatus(t("usage.loading.badge")),
    },
    html`
      <div class="usage-panel usage-loading-card">
        <div class="usage-loading-header">
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
      </div>
    `,
  );
}

function renderUsageEmptyState(onRefresh: () => void) {
  return html`
    <section class="settings-group usage-panel usage-empty-state">
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

type ProviderUsageSnapshot = ProviderUsageSummary["providers"][number];

function renderProviderUsage(providers: ProviderUsageSnapshot[]) {
  if (providers.length === 0) {
    return nothing;
  }
  return renderSettingsSection(
    {
      title: t("usage.providerUsage.title"),
      count: providers.length,
      description: t("usage.providerUsage.subtitle"),
    },
    html`
      <div class="usage-panel provider-usage-section">
        <div class="provider-usage-grid">
          ${providers.map(
            (provider) => html`
              <article class="provider-usage-card">
                <div class="provider-usage-card__header">
                  <div>
                    <div class="provider-usage-card__name">${provider.displayName}</div>
                    <div class="provider-usage-card__id">${provider.provider}</div>
                  </div>
                  ${provider.plan
                    ? html`<span class="provider-usage-plan">${provider.plan}</span>`
                    : nothing}
                </div>
                ${renderProviderUsageDetails(provider)}
              </article>
            `,
          )}
        </div>
      </div>
    `,
  );
}

export function renderUsage(props: UsageProps) {
  const { data, filters, display, detail, callbacks } = props;
  const filterActions = callbacks.filters;
  const displayActions = callbacks.display;
  const detailActions = callbacks.details;

  if (data.loading && !data.totals) {
    return renderSettingsPage(
      html`<div class="usage-page">${renderUsageLoadingState(filters)}</div>`,
      { wide: true },
    );
  }

  const isTokenMode = display.chartMode === "tokens";
  const hasQuery = filters.query.trim().length > 0;
  const hasDraftQuery = filters.queryDraft.trim().length > 0;
  const selectedDaySet = new Set(filters.selectedDays);
  const selectedSessionSet = new Set(filters.selectedSessions);

  // Sort sessions by tokens or cost depending on mode
  const sortedSessions = [...data.sessions].toSorted((a, b) => {
    const valA = isTokenMode ? (a.usage?.totalTokens ?? 0) : (a.usage?.totalCost ?? 0);
    const valB = isTokenMode ? (b.usage?.totalTokens ?? 0) : (b.usage?.totalCost ?? 0);
    return valB - valA;
  });

  const agentScopedSessions = filters.agentId
    ? sortedSessions.filter(
        (s) => normalizeQueryText(s.agentId ?? "") === normalizeQueryText(filters.agentId ?? ""),
      )
    : sortedSessions;

  // Filter sessions by selected days
  const dayFilteredSessions =
    selectedDaySet.size > 0
      ? agentScopedSessions.filter((s) => {
          if (s.usage?.activityDates?.length) {
            return s.usage.activityDates.some((d) => selectedDaySet.has(d));
          }
          if (!s.updatedAt) {
            return false;
          }
          const d = new Date(s.updatedAt);
          const sessionDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          return selectedDaySet.has(sessionDate);
        })
      : agentScopedSessions;

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
    agentScopedSessions,
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
  const channelOptions = unique(agentScopedSessions.map((s) => s.channel)).slice(0, 12);
  const providerOptions = unique([
    ...agentScopedSessions.map((s) => s.modelProvider),
    ...agentScopedSessions.map((s) => s.providerOverride),
    ...(data.aggregates?.byProvider.map((entry) => entry.provider) ?? []),
  ]).slice(0, 12);
  const modelOptions = unique([
    ...agentScopedSessions.map((s) => s.model),
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
  const computeDailyTotals = (days: ReadonlySet<string>): UsageTotals => {
    const matchingDays = data.costDaily.filter((d) => days.has(d.date));
    return matchingDays.reduce((acc, day) => addUsageTotals(acc, day), createEmptyUsageTotals());
  };

  // Compute display totals and count based on filters
  let displayTotals: UsageTotals | null;
  let displaySessionCount: number;
  const totalSessions = agentScopedSessions.length;

  if (filters.selectedSessions.length > 0) {
    // Sessions selected - compute totals from selected sessions
    const selectedSessionEntries = filteredSessions.filter((s) => selectedSessionSet.has(s.key));
    displayTotals = computeSessionTotals(selectedSessionEntries);
    displaySessionCount = selectedSessionEntries.length;
  } else if (filters.selectedDays.length > 0 && filters.selectedHours.length === 0) {
    // Days selected - use daily aggregates for accurate per-day totals
    displayTotals = computeDailyTotals(selectedDaySet);
    displaySessionCount = filteredSessions.length;
  } else if (filters.selectedHours.length > 0) {
    displayTotals = computeSessionTotals(filteredSessions);
    displaySessionCount = filteredSessions.length;
  } else if (hasQuery) {
    displayTotals = computeSessionTotals(filteredSessions);
    displaySessionCount = filteredSessions.length;
  } else if (filters.agentId) {
    displayTotals = computeSessionTotals(agentScopedSessions);
    displaySessionCount = totalSessions;
  } else {
    // No filters - show all
    displayTotals = data.totals;
    displaySessionCount = totalSessions;
  }

  const aggregateSessions =
    filters.selectedSessions.length > 0
      ? filteredSessions.filter((s) => selectedSessionSet.has(s.key))
      : hasQuery || filters.selectedHours.length > 0
        ? filteredSessions
        : filters.selectedDays.length > 0
          ? dayFilteredSessions
          : agentScopedSessions;
  const hasAggregateFilters =
    filters.selectedSessions.length > 0 ||
    hasQuery ||
    filters.selectedHours.length > 0 ||
    filters.selectedDays.length > 0 ||
    Boolean(filters.agentId);
  const activeAggregates = hasAggregateFilters
    ? buildAggregatesFromSessions(aggregateSessions)
    : buildAggregatesFromSessions([], data.aggregates);
  const insightsUseVisiblePage = data.sessionsLimitReached && !hasAggregateFilters;
  const insightTotals = insightsUseVisiblePage
    ? computeSessionTotals(aggregateSessions)
    : displayTotals;
  const insightAggregates = insightsUseVisiblePage
    ? buildAggregatesFromSessions(aggregateSessions)
    : activeAggregates;
  // Cost windows use range-wide daily totals; filtered pages need exact scoped data.
  const costWindowComparison = hasAggregateFilters
    ? nothing
    : renderCostWindowComparison(data.costDaily, filters.startDate, filters.endDate);

  // Filter daily chart data if sessions are selected
  const filteredDaily =
    filters.selectedSessions.length > 0
      ? (() => {
          const selectedEntries = filteredSessions.filter((s) => selectedSessionSet.has(s.key));
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

  const insightStats = buildUsageInsightStats(aggregateSessions, insightTotals, insightAggregates);
  const isEmpty = !data.loading && !data.totals && data.sessions.length === 0;
  const cacheStatusTitle = getUsageCacheRefreshTitle(data.cacheStatus);
  const hasMissingCost =
    (insightTotals?.missingCostEntries ?? 0) > 0 ||
    (insightTotals
      ? insightTotals.totalTokens > 0 &&
        insightTotals.totalCost === 0 &&
        insightTotals.input +
          insightTotals.output +
          insightTotals.cacheRead +
          insightTotals.cacheWrite >
          0
      : false);
  const datePresets = [
    { label: t("usage.presets.today"), days: 1 },
    { label: t("usage.presets.last7d"), days: 7 },
    { label: t("usage.presets.last30d"), days: 30 },
    { label: t("usage.presets.last90d"), days: 90 },
    { label: t("usage.presets.last1y"), days: 365 },
  ];
  const applyPreset = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    filterActions.onStartDateChange(formatIsoDate(start));
    filterActions.onEndDateChange(formatIsoDate(end));
  };
  const applyAllRange = () => {
    filterActions.onStartDateChange("1970-01-01");
    filterActions.onEndDateChange(formatIsoDate(new Date()));
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
      <wa-dropdown
        class="usage-filter-select"
        placement="bottom-start"
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
          event.preventDefault();
          const value = event.detail.item.value;
          if (value === "command:select-all") {
            filterActions.onQueryDraftChange(
              setQueryTokensForKey(filters.queryDraft, key, options),
            );
            return;
          }
          if (value === "command:clear") {
            filterActions.onQueryDraftChange(setQueryTokensForKey(filters.queryDraft, key, []));
            return;
          }
          if (value?.startsWith("option:")) {
            const optionValue = decodeURIComponent(value.slice("option:".length));
            const token = `${key}:${optionValue}`;
            const checked = selectedSet.has(normalizeQueryText(optionValue));
            filterActions.onQueryDraftChange(
              checked
                ? removeQueryToken(filters.queryDraft, token)
                : addQueryToken(filters.queryDraft, token),
            );
          }
        }}
      >
        <button slot="trigger" type="button" class="usage-filter-trigger">
          <span>${label}</span>
          ${selectedCount > 0
            ? html`<span class="settings-count">${selectedCount}</span>`
            : html` <span class="settings-count">${t("usage.filters.all")}</span> `}
        </button>
        <wa-dropdown-item value="command:select-all" ?disabled=${allSelected}>
          ${t("usage.filters.selectAll")}
        </wa-dropdown-item>
        <wa-dropdown-item value="command:clear" ?disabled=${selectedCount === 0}>
          ${t("usage.filters.clear")}
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator"></div>
        ${options.map((value) => {
          const checked = selectedSet.has(normalizeQueryText(value));
          return html`
            <wa-dropdown-item
              class="usage-filter-option"
              type="checkbox"
              value=${`option:${encodeURIComponent(value)}`}
              .checked=${checked}
            >
              ${value}
            </wa-dropdown-item>
          `;
        })}
      </wa-dropdown>
    `;
  };
  const exportStamp = formatIsoDate(new Date());

  return renderSettingsPage(
    html`
      <div class="usage-page">
        <section class="settings-section">
          <div class="settings-section__header">
            <h2 class="settings-section__heading">${t("usage.filters.title")}</h2>
            <div class="settings-section__actions">
              ${data.loading || cacheStatusTitle
                ? renderUsageLoadingStatus(t("usage.loading.badge"), cacheStatusTitle ?? "")
                : nothing}
              ${isEmpty
                ? html`<span class="usage-query-hint">${t("usage.empty.hint")}</span>`
                : nothing}
            </div>
          </div>
          <div
            class="settings-group usage-panel usage-header ${display.headerPinned ? "pinned" : ""}"
          >
            <div class="usage-header-row">
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
                  @click=${filterActions.onToggleHeaderPinned}
                >
                  ${display.headerPinned ? t("usage.filters.pinned") : t("usage.filters.pin")}
                </button>
                <wa-dropdown
                  class="usage-export-menu"
                  placement="bottom-end"
                  @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
                    switch (event.detail.item.value) {
                      case "sessions-csv":
                        downloadTextFile(
                          `openclaw-usage-sessions-${exportStamp}.csv`,
                          buildSessionsCsv(filteredSessions),
                          "text/csv",
                        );
                        break;
                      case "daily-csv":
                        downloadTextFile(
                          `openclaw-usage-daily-${exportStamp}.csv`,
                          buildDailyCsv(filteredDaily),
                          "text/csv",
                        );
                        break;
                      case "json":
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
                        );
                        break;
                      case undefined:
                        break;
                    }
                  }}
                >
                  <button slot="trigger" type="button" class="btn btn--sm">
                    ${t("usage.export.label")} ▾
                  </button>
                  <wa-dropdown-item value="sessions-csv" ?disabled=${filteredSessions.length === 0}>
                    ${t("usage.export.sessionsCsv")}
                  </wa-dropdown-item>
                  <wa-dropdown-item value="daily-csv" ?disabled=${filteredDaily.length === 0}>
                    ${t("usage.export.dailyCsv")}
                  </wa-dropdown-item>
                  <wa-dropdown-item
                    value="json"
                    ?disabled=${filteredSessions.length === 0 && filteredDaily.length === 0}
                  >
                    ${t("usage.export.json")}
                  </wa-dropdown-item>
                </wa-dropdown>
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
                  <button class="btn btn--sm" @click=${applyAllRange}>
                    ${t("usage.presets.all")}
                  </button>
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
                    class="btn btn--sm toggle-btn ${filters.scope === "instance" ? "active" : ""}"
                    title=${t("usage.scope.instanceHint")}
                    @click=${() => filterActions.onScopeChange("instance")}
                  >
                    ${t("usage.scope.instance")}
                  </button>
                  <button
                    class="btn btn--sm toggle-btn ${filters.scope === "family" ? "active" : ""}"
                    title=${t("usage.scope.familyHint")}
                    @click=${() => filterActions.onScopeChange("family")}
                  >
                    ${t("usage.scope.family")}
                  </button>
                </div>
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
                            <openclaw-tooltip .content=${t("usage.filters.remove")}>
                              <button
                                aria-label=${t("usage.filters.remove")}
                                @click=${() =>
                                  filterActions.onQueryDraftChange(
                                    removeQueryToken(filters.queryDraft, label),
                                  )}
                              >
                                ×
                              </button>
                            </openclaw-tooltip>
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
                  <div class="callout warning usage-callout">
                    ${t("usage.sessions.limitReached")}
                  </div>
                `
              : nothing}
          </div>
        </section>

        ${renderProviderUsage(data.providerUsage)}
        ${isEmpty
          ? renderUsageEmptyState(filterActions.onRefresh)
          : html`
              ${renderUsageInsights(
                insightTotals,
                insightAggregates,
                insightStats,
                hasMissingCost,
                // Day totals are exact daily buckets; category rollups remain full-session totals.
                // Hide shares instead of mixing those scopes into percentages above 100%.
                filters.selectedDays.length === 0,
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
                  <div class="settings-group usage-panel usage-left-card">
                    ${costWindowComparison}
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
    `,
    { wide: true },
  );
}

// Exposed for Playwright/Vitest browser unit tests.
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
