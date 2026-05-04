import { html, nothing } from "lit";
import { formatDurationCompact } from "../../../../src/infra/format-time/format-duration.ts";
import { t } from "../../i18n/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import {
  formatCost,
  formatDayLabel,
  formatFullDate,
  formatTokens,
  UsageInsightStats,
} from "./usage-metrics.ts";
import {
  UsageAggregates,
  UsageColumnId,
  UsageSessionEntry,
  UsageTotals,
  CostDailyEntry,
} from "./usageTypes.ts";

function pct(part: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return (part / total) * 100;
}

function getCostBreakdown(totals: UsageTotals) {
  // Use actual costs from API data (already aggregated in backend)
  const totalCost = totals.totalCost || 0;

  return {
    input: {
      tokens: totals.input,
      cost: totals.inputCost || 0,
      pct: pct(totals.inputCost || 0, totalCost),
    },
    output: {
      tokens: totals.output,
      cost: totals.outputCost || 0,
      pct: pct(totals.outputCost || 0, totalCost),
    },
    cacheRead: {
      tokens: totals.cacheRead,
      cost: totals.cacheReadCost || 0,
      pct: pct(totals.cacheReadCost || 0, totalCost),
    },
    cacheWrite: {
      tokens: totals.cacheWrite,
      cost: totals.cacheWriteCost || 0,
      pct: pct(totals.cacheWriteCost || 0, totalCost),
    },
    totalCost,
  };
}

function renderFilterChips(
  selectedDays: string[],
  selectedHours: number[],
  selectedSessions: string[],
  sessions: UsageSessionEntry[],
  onClearDays: () => void,
  onClearHours: () => void,
  onClearSessions: () => void,
  onClearFilters: () => void,
) {
  const hasFilters =
    selectedDays.length > 0 || selectedHours.length > 0 || selectedSessions.length > 0;
  if (!hasFilters) {
    return nothing;
  }

  const selectedSession =
    selectedSessions.length === 1 ? sessions.find((s) => s.key === selectedSessions[0]) : null;
  const sessionsLabel = selectedSession
    ? (selectedSession.label || selectedSession.key).slice(0, 20) +
      ((selectedSession.label || selectedSession.key).length > 20 ? "…" : "")
    : selectedSessions.length === 1
      ? selectedSessions[0].slice(0, 8) + "…"
      : t("usage.filters.sessionsCount", { count: String(selectedSessions.length) });
  const sessionsFullName = selectedSession
    ? selectedSession.label || selectedSession.key
    : selectedSessions.length === 1
      ? selectedSessions[0]
      : selectedSessions.join(", ");

  const daysLabel =
    selectedDays.length === 1
      ? selectedDays[0]
      : t("usage.filters.daysCount", { count: String(selectedDays.length) });
  const hoursLabel =
    selectedHours.length === 1
      ? `${selectedHours[0]}:00`
      : t("usage.filters.hoursCount", { count: String(selectedHours.length) });

  return html`
    <div class="active-filters">
      ${selectedDays.length > 0
        ? html`
            <div class="filter-chip">
              <span class="filter-chip-label">${t("usage.filters.days")}: ${daysLabel}</span>
              <button
                class="filter-chip-remove"
                @click=${onClearDays}
                title=${t("usage.filters.remove")}
                aria-label="Remove days filter"
              >
                ×
              </button>
            </div>
          `
        : nothing}
      ${selectedHours.length > 0
        ? html`
            <div class="filter-chip">
              <span class="filter-chip-label">${t("usage.filters.hours")}: ${hoursLabel}</span>
              <button
                class="filter-chip-remove"
                @click=${onClearHours}
                title=${t("usage.filters.remove")}
                aria-label="Remove hours filter"
              >
                ×
              </button>
            </div>
          `
        : nothing}
      ${selectedSessions.length > 0
        ? html`
            <div class="filter-chip" title="${sessionsFullName}">
              <span class="filter-chip-label">${t("usage.filters.session")}: ${sessionsLabel}</span>
              <button
                class="filter-chip-remove"
                @click=${onClearSessions}
                title=${t("usage.filters.remove")}
                aria-label="Remove session filter"
              >
                ×
              </button>
            </div>
          `
        : nothing}
      ${(selectedDays.length > 0 || selectedHours.length > 0) && selectedSessions.length > 0
        ? html`
            <button class="btn btn--sm" @click=${onClearFilters}>
              ${t("usage.filters.clearAll")}
            </button>
          `
        : nothing}
    </div>
  `;
}

function renderDailyChartCompact(
  daily: CostDailyEntry[],
  selectedDays: string[],
  chartMode: "tokens" | "cost",
  dailyChartMode: "total" | "by-type",
  onDailyChartModeChange: (mode: "total" | "by-type") => void,
  onSelectDay: (day: string, shiftKey: boolean) => void,
) {
  if (!daily.length) {
    return html`
      <div class="daily-chart-compact">
        <div class="card-title usage-section-title">${t("usage.daily.title")}</div>
        <div class="usage-empty-block">${t("usage.empty.noData")}</div>
      </div>
    `;
  }

  const isTokenMode = chartMode === "tokens";
  const values = daily.map((d) => (isTokenMode ? d.totalTokens : d.totalCost));
  const maxValue = Math.max(...values, isTokenMode ? 1 : 0.0001);

  // Adaptive scaling: when the spread between largest and smallest non-zero
  // values is extreme (>50×), use square-root compression so small bars stay
  // visible instead of collapsing to a single pixel.
  const nonZero = values.filter((v) => v > 0);
  const minNonZero = nonZero.length > 0 ? Math.min(...nonZero) : maxValue;
  const spread = maxValue / minNonZero;
  const chartAreaPx = 200;
  const minBarPx = 6;
  const barHeights = values.map((v): number => {
    if (v <= 0) {
      return 0;
    }
    const ratio = spread > 50 ? Math.sqrt(v / maxValue) : v / maxValue;
    return Math.max(minBarPx, ratio * chartAreaPx);
  });

  // Calculate bar width based on number of days
  const barMaxWidth = daily.length > 30 ? 12 : daily.length > 20 ? 18 : daily.length > 14 ? 24 : 32;
  const showTotals = daily.length <= 14;

  return html`
    <div class="daily-chart-compact">
      <div class="daily-chart-header">
        <div class="chart-toggle small sessions-toggle">
          <button
            class="btn btn--sm toggle-btn ${dailyChartMode === "total" ? "active" : ""}"
            @click=${() => onDailyChartModeChange("total")}
          >
            ${t("usage.daily.total")}
          </button>
          <button
            class="btn btn--sm toggle-btn ${dailyChartMode === "by-type" ? "active" : ""}"
            @click=${() => onDailyChartModeChange("by-type")}
          >
            ${t("usage.daily.byType")}
          </button>
        </div>
        <div class="card-title">
          ${isTokenMode ? t("usage.daily.tokensTitle") : t("usage.daily.costTitle")}
        </div>
      </div>
      <div class="daily-chart">
        <div class="daily-chart-bars" style="--bar-max-width: ${barMaxWidth}px">
          ${daily.map((d, idx) => {
            const heightPx = barHeights[idx];
            const isSelected = selectedDays.includes(d.date);
            const label = formatDayLabel(d.date);
            // Shorter label for many days (just day number)
            const shortLabel =
              daily.length > 20 ? String(Number.parseInt(d.date.slice(8), 10)) : label;
            const labelClass =
              daily.length > 20 ? "daily-bar-label daily-bar-label--compact" : "daily-bar-label";
            const segments =
              dailyChartMode === "by-type"
                ? isTokenMode
                  ? [
                      { value: d.output, class: "output" },
                      { value: d.input, class: "input" },
                      { value: d.cacheWrite, class: "cache-write" },
                      { value: d.cacheRead, class: "cache-read" },
                    ]
                  : [
                      { value: d.outputCost ?? 0, class: "output" },
                      { value: d.inputCost ?? 0, class: "input" },
                      { value: d.cacheWriteCost ?? 0, class: "cache-write" },
                      { value: d.cacheReadCost ?? 0, class: "cache-read" },
                    ]
                : [];
            const breakdownLines =
              dailyChartMode === "by-type"
                ? isTokenMode
                  ? [
                      `${t("usage.breakdown.output")} ${formatTokens(d.output)}`,
                      `${t("usage.breakdown.input")} ${formatTokens(d.input)}`,
                      `${t("usage.breakdown.cacheWrite")} ${formatTokens(d.cacheWrite)}`,
                      `${t("usage.breakdown.cacheRead")} ${formatTokens(d.cacheRead)}`,
                    ]
                  : [
                      `${t("usage.breakdown.output")} ${formatCost(d.outputCost ?? 0)}`,
                      `${t("usage.breakdown.input")} ${formatCost(d.inputCost ?? 0)}`,
                      `${t("usage.breakdown.cacheWrite")} ${formatCost(d.cacheWriteCost ?? 0)}`,
                      `${t("usage.breakdown.cacheRead")} ${formatCost(d.cacheReadCost ?? 0)}`,
                    ]
                : [];
            const totalLabel = isTokenMode ? formatTokens(d.totalTokens) : formatCost(d.totalCost);
            return html`
              <div
                class="daily-bar-wrapper ${isSelected ? "selected" : ""}"
                @click=${(e: MouseEvent) => onSelectDay(d.date, e.shiftKey)}
              >
                ${dailyChartMode === "by-type"
                  ? html`
                      <div
                        class="daily-bar daily-bar--stacked"
                        style="height: ${heightPx.toFixed(0)}px;"
                      >
                        ${(() => {
                          const total = segments.reduce((sum, seg) => sum + seg.value, 0) || 1;
                          return segments.map(
                            (seg) => html`
                              <div
                                class="cost-segment ${seg.class}"
                                style="height: ${(seg.value / total) * 100}%"
                              ></div>
                            `,
                          );
                        })()}
                      </div>
                    `
                  : html` <div class="daily-bar" style="height: ${heightPx.toFixed(0)}px"></div> `}
                ${showTotals ? html`<div class="daily-bar-total">${totalLabel}</div>` : nothing}
                <div class="${labelClass}">${shortLabel}</div>
                <div class="daily-bar-tooltip">
                  <strong>${formatFullDate(d.date)}</strong><br />
                  ${formatTokens(d.totalTokens)}
                  ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}<br />
                  ${formatCost(d.totalCost)}
                  ${breakdownLines.length
                    ? html`${breakdownLines.map((line) => html`<div>${line}</div>`)}`
                    : nothing}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}

function renderCostBreakdownCompact(totals: UsageTotals, mode: "tokens" | "cost") {
  const breakdown = getCostBreakdown(totals);
  const isTokenMode = mode === "tokens";
  const totalTokens = totals.totalTokens || 1;
  const tokenPcts = {
    output: pct(totals.output, totalTokens),
    input: pct(totals.input, totalTokens),
    cacheWrite: pct(totals.cacheWrite, totalTokens),
    cacheRead: pct(totals.cacheRead, totalTokens),
  };

  return html`
    <div class="cost-breakdown cost-breakdown-compact">
      <div class="cost-breakdown-header">
        ${isTokenMode ? t("usage.breakdown.tokensByType") : t("usage.breakdown.costByType")}
      </div>
      <div class="cost-breakdown-bar">
        <div
          class="cost-segment output"
          style="width: ${(isTokenMode ? tokenPcts.output : breakdown.output.pct).toFixed(1)}%"
          title="${t("usage.breakdown.output")}: ${isTokenMode
            ? formatTokens(totals.output)
            : formatCost(breakdown.output.cost)}"
        ></div>
        <div
          class="cost-segment input"
          style="width: ${(isTokenMode ? tokenPcts.input : breakdown.input.pct).toFixed(1)}%"
          title="${t("usage.breakdown.input")}: ${isTokenMode
            ? formatTokens(totals.input)
            : formatCost(breakdown.input.cost)}"
        ></div>
        <div
          class="cost-segment cache-write"
          style="width: ${(isTokenMode ? tokenPcts.cacheWrite : breakdown.cacheWrite.pct).toFixed(
            1,
          )}%"
          title="${t("usage.breakdown.cacheWrite")}: ${isTokenMode
            ? formatTokens(totals.cacheWrite)
            : formatCost(breakdown.cacheWrite.cost)}"
        ></div>
        <div
          class="cost-segment cache-read"
          style="width: ${(isTokenMode ? tokenPcts.cacheRead : breakdown.cacheRead.pct).toFixed(
            1,
          )}%"
          title="${t("usage.breakdown.cacheRead")}: ${isTokenMode
            ? formatTokens(totals.cacheRead)
            : formatCost(breakdown.cacheRead.cost)}"
        ></div>
      </div>
      <div class="cost-breakdown-legend">
        <span class="legend-item"
          ><span class="legend-dot output"></span>${t("usage.breakdown.output")}
          ${isTokenMode ? formatTokens(totals.output) : formatCost(breakdown.output.cost)}</span
        >
        <span class="legend-item"
          ><span class="legend-dot input"></span>${t("usage.breakdown.input")}
          ${isTokenMode ? formatTokens(totals.input) : formatCost(breakdown.input.cost)}</span
        >
        <span class="legend-item"
          ><span class="legend-dot cache-write"></span>${t("usage.breakdown.cacheWrite")}
          ${isTokenMode
            ? formatTokens(totals.cacheWrite)
            : formatCost(breakdown.cacheWrite.cost)}</span
        >
        <span class="legend-item"
          ><span class="legend-dot cache-read"></span>${t("usage.breakdown.cacheRead")}
          ${isTokenMode
            ? formatTokens(totals.cacheRead)
            : formatCost(breakdown.cacheRead.cost)}</span
        >
      </div>
      <div class="cost-breakdown-total">
        ${t("usage.breakdown.total")}:
        ${isTokenMode ? formatTokens(totals.totalTokens) : formatCost(totals.totalCost)}
      </div>
    </div>
  `;
}

function renderInsightList(
  title: string,
  items: Array<{ label: string; value: string; sub?: string }>,
  emptyLabel: string,
) {
  return html`
    <div class="usage-insight-card">
      <div class="usage-insight-title">${title}</div>
      ${items.length === 0
        ? html`<div class="muted">${emptyLabel}</div>`
        : html`
            <div class="usage-list">
              ${items.map(
                (item) => html`
                  <div class="usage-list-item">
                    <span>${item.label}</span>
                    <span class="usage-list-value">
                      <span>${item.value}</span>
                      ${item.sub ? html`<span class="usage-list-sub">${item.sub}</span>` : nothing}
                    </span>
                  </div>
                `,
              )}
            </div>
          `}
    </div>
  `;
}

function renderPeakErrorList(
  title: string,
  items: Array<{ label: string; value: string; sub?: string }>,
  emptyLabel: string,
  options?: {
    className?: string;
    listClassName?: string;
  },
) {
  const cardClass = ["usage-insight-card", options?.className].filter(Boolean).join(" ");
  const listClass = ["usage-error-list", options?.listClassName].filter(Boolean).join(" ");
  return html`
    <div class=${cardClass}>
      <div class="usage-insight-title">${title}</div>
      ${items.length === 0
        ? html`<div class="muted">${emptyLabel}</div>`
        : html`
            <div class=${listClass}>
              ${items.map(
                (item) => html`
                  <div class="usage-error-row">
                    <div class="usage-error-date">${item.label}</div>
                    <div class="usage-error-rate">${item.value}</div>
                    ${item.sub ? html`<div class="usage-error-sub">${item.sub}</div>` : nothing}
                  </div>
                `,
              )}
            </div>
          `}
    </div>
  `;
}

function renderSummaryStat(params: {
  title: string;
  hint: string;
  value: string | number;
  sub: string;
  tone?: "good" | "warn" | "bad";
  className?: string;
  compactValue?: boolean;
}) {
  const classes = [
    "stat",
    "usage-summary-card",
    params.className,
    params.tone ? `usage-summary-card--${params.tone}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const valueClasses = [
    "stat-value",
    "usage-summary-value",
    params.tone ?? "",
    params.compactValue ? "usage-summary-value--compact" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${classes}>
      <div class="usage-summary-title">
        ${params.title}
        <span class="usage-summary-hint" title=${params.hint}>?</span>
      </div>
      <div class=${valueClasses}>${params.value}</div>
      <div class="usage-summary-sub">${params.sub}</div>
    </div>
  `;
}

function renderUsageInsights(
  totals: UsageTotals | null,
  aggregates: UsageAggregates,
  stats: UsageInsightStats,
  showCostHint: boolean,
  errorHours: Array<{ label: string; value: string; sub?: string }>,
  sessionCount: number,
  totalSessions: number,
) {
  if (!totals) {
    return nothing;
  }

  const avgTokens = aggregates.messages.total
    ? Math.round(totals.totalTokens / aggregates.messages.total)
    : 0;
  const avgCost = aggregates.messages.total ? totals.totalCost / aggregates.messages.total : 0;
  const cacheBase = totals.input + totals.cacheRead + totals.cacheWrite;
  const cacheHitRate = cacheBase > 0 ? totals.cacheRead / cacheBase : 0;
  const cacheHitLabel =
    cacheBase > 0 ? `${(cacheHitRate * 100).toFixed(1)}%` : t("usage.common.emptyValue");
  const errorRatePct = stats.errorRate * 100;
  const throughputLabel =
    stats.throughputTokensPerMin !== undefined
      ? `${formatTokens(Math.round(stats.throughputTokensPerMin))} ${t("usage.overview.tokensPerMinute")}`
      : t("usage.common.emptyValue");
  const throughputCostLabel =
    stats.throughputCostPerMin !== undefined
      ? `${formatCost(stats.throughputCostPerMin, 4)} ${t("usage.overview.perMinute")}`
      : t("usage.common.emptyValue");
  const avgDurationLabel =
    stats.durationCount > 0
      ? (formatDurationCompact(stats.avgDurationMs, { spaced: true }) ??
        t("usage.common.emptyValue"))
      : t("usage.common.emptyValue");
  const cacheHint = t("usage.overview.cacheHint");
  const errorHint = t("usage.overview.errorHint");
  const throughputHint = t("usage.overview.throughputHint");
  const tokensHint = t("usage.overview.avgTokensHint");
  const costHint = showCostHint
    ? t("usage.overview.avgCostHintMissing")
    : t("usage.overview.avgCostHint");

  const errorDays = aggregates.daily
    .filter((day) => day.messages > 0 && day.errors > 0)
    .map((day) => {
      const rate = day.errors / day.messages;
      return {
        label: formatDayLabel(day.date),
        value: `${(rate * 100).toFixed(2)}%`,
        sub: `${day.errors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${day.messages} ${t("usage.overview.messagesAbbrev")} · ${formatTokens(day.tokens)}`,
        rate,
      };
    })
    .toSorted((a, b) => b.rate - a.rate)
    .slice(0, 5)
    .map(({ rate: _rate, ...rest }) => rest);

  const topModels = aggregates.byModel.slice(0, 5).map((entry) => ({
    label: entry.model ?? t("usage.common.unknown"),
    value: formatCost(entry.totals.totalCost),
    sub: `${formatTokens(entry.totals.totalTokens)} · ${entry.count} ${t("usage.overview.messagesAbbrev")}`,
  }));
  const topProviders = aggregates.byProvider.slice(0, 5).map((entry) => ({
    label: entry.provider ?? t("usage.common.unknown"),
    value: formatCost(entry.totals.totalCost),
    sub: `${formatTokens(entry.totals.totalTokens)} · ${entry.count} ${t("usage.overview.messagesAbbrev")}`,
  }));
  const topTools = aggregates.tools.tools.slice(0, 6).map((tool) => ({
    label: tool.name,
    value: `${tool.count}`,
    sub: t("usage.overview.calls"),
  }));
  const topAgents = aggregates.byAgent.slice(0, 5).map((entry) => ({
    label: entry.agentId,
    value: formatCost(entry.totals.totalCost),
    sub: formatTokens(entry.totals.totalTokens),
  }));
  const topChannels = aggregates.byChannel.slice(0, 5).map((entry) => ({
    label: entry.channel,
    value: formatCost(entry.totals.totalCost),
    sub: formatTokens(entry.totals.totalTokens),
  }));

  return html`
    <section class="card usage-overview-card">
      <div class="card-title">${t("usage.overview.title")}</div>
      <div class="usage-overview-layout">
        <div class="usage-summary-grid">
          ${renderSummaryStat({
            title: t("usage.overview.messages"),
            hint: t("usage.overview.messagesHint"),
            value: aggregates.messages.total,
            sub: `${aggregates.messages.user} ${normalizeLowercaseStringOrEmpty(t("usage.overview.user"))} · ${aggregates.messages.assistant} ${normalizeLowercaseStringOrEmpty(t("usage.overview.assistant"))}`,
            className: "usage-summary-card--hero",
          })}
          ${renderSummaryStat({
            title: t("usage.overview.throughput"),
            hint: throughputHint,
            value: throughputLabel,
            sub: throughputCostLabel,
            className: "usage-summary-card--hero usage-summary-card--throughput",
            compactValue: true,
          })}
          ${renderSummaryStat({
            title: t("usage.overview.toolCalls"),
            hint: t("usage.overview.toolCallsHint"),
            value: aggregates.tools.totalCalls,
            sub: `${aggregates.tools.uniqueTools} ${t("usage.overview.toolsUsed")}`,
            className: "usage-summary-card--half",
          })}
          ${renderSummaryStat({
            title: t("usage.overview.avgTokens"),
            hint: tokensHint,
            value: formatTokens(avgTokens),
            sub: t("usage.overview.acrossMessages", {
              count: String(aggregates.messages.total || 0),
            }),
            className: "usage-summary-card--half",
          })}
          ${renderSummaryStat({
            title: t("usage.overview.cacheHitRate"),
            hint: cacheHint,
            value: cacheHitLabel,
            sub: `${formatTokens(totals.cacheRead)} ${t("usage.overview.cached")} · ${formatTokens(cacheBase)} ${t("usage.overview.prompt")}`,
            tone: cacheHitRate > 0.6 ? "good" : cacheHitRate > 0.3 ? "warn" : "bad",
            className: "usage-summary-card--medium",
          })}
          ${renderSummaryStat({
            title: t("usage.overview.errorRate"),
            hint: errorHint,
            value: `${errorRatePct.toFixed(2)}%`,
            sub: `${aggregates.messages.errors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${avgDurationLabel} ${t("usage.overview.avgSession")}`,
            tone: errorRatePct > 5 ? "bad" : errorRatePct > 1 ? "warn" : "good",
            className: "usage-summary-card--medium",
          })}
          ${renderSummaryStat({
            title: t("usage.overview.avgCost"),
            hint: costHint,
            value: formatCost(avgCost, 4),
            sub: `${formatCost(totals.totalCost)} ${normalizeLowercaseStringOrEmpty(t("usage.breakdown.total"))}`,
            className: "usage-summary-card--compact",
          })}
          ${renderSummaryStat({
            title: t("usage.overview.sessions"),
            hint: t("usage.overview.sessionsHint"),
            value: sessionCount,
            sub: t("usage.overview.sessionsInRange", { count: String(totalSessions) }),
            className: "usage-summary-card--compact",
          })}
          ${renderSummaryStat({
            title: t("usage.overview.errors"),
            hint: t("usage.overview.errorsHint"),
            value: aggregates.messages.errors,
            sub: `${aggregates.messages.toolResults} ${t("usage.overview.toolResults")}`,
            className: "usage-summary-card--compact",
          })}
        </div>
        <div class="usage-insights-grid">
          ${renderInsightList(
            t("usage.overview.topModels"),
            topModels,
            t("usage.overview.noModelData"),
          )}
          ${renderInsightList(
            t("usage.overview.topProviders"),
            topProviders,
            t("usage.overview.noProviderData"),
          )}
          ${renderInsightList(
            t("usage.overview.topTools"),
            topTools,
            t("usage.overview.noToolCalls"),
          )}
          ${renderInsightList(
            t("usage.overview.topAgents"),
            topAgents,
            t("usage.overview.noAgentData"),
          )}
          ${renderInsightList(
            t("usage.overview.topChannels"),
            topChannels,
            t("usage.overview.noChannelData"),
          )}
          ${renderPeakErrorList(
            t("usage.overview.peakErrorDays"),
            errorDays,
            t("usage.overview.noErrorData"),
          )}
          ${renderPeakErrorList(
            t("usage.overview.peakErrorHours"),
            errorHours,
            t("usage.overview.noErrorData"),
            {
              className: "usage-insight-card--wide",
              listClassName: "usage-error-list--hours",
            },
          )}
        </div>
      </div>
    </section>
  `;
}

function renderSessionsCard(
  sessions: UsageSessionEntry[],
  selectedSessions: string[],
  selectedDays: string[],
  isTokenMode: boolean,
  sessionSort: "tokens" | "cost" | "recent" | "messages" | "errors",
  sessionSortDir: "asc" | "desc",
  recentSessions: string[],
  sessionsTab: "all" | "recent",
  onSelectSession: (key: string, shiftKey: boolean) => void,
  onSessionSortChange: (sort: "tokens" | "cost" | "recent" | "messages" | "errors") => void,
  onSessionSortDirChange: (dir: "asc" | "desc") => void,
  onSessionsTabChange: (tab: "all" | "recent") => void,
  visibleColumns: UsageColumnId[],
  totalSessions: number,
  onClearSessions: () => void,
) {
  const showColumn = (id: UsageColumnId) => visibleColumns.includes(id);
  const formatSessionListLabel = (s: UsageSessionEntry): string => {
    const raw = s.label || s.key;
    // Agent session keys often include a token query param; remove it for readability.
    if (raw.startsWith("agent:") && raw.includes("?token=")) {
      return raw.slice(0, raw.indexOf("?token="));
    }
    return raw;
  };
  const copySessionName = async (s: UsageSessionEntry) => {
    const text = formatSessionListLabel(s);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Best effort; clipboard can fail on insecure contexts or denied permission.
    }
  };

  const buildSessionMeta = (s: UsageSessionEntry): string[] => {
    const parts: string[] = [];
    if (showColumn("channel") && s.channel) {
      parts.push(`channel:${s.channel}`);
    }
    if (showColumn("agent") && s.agentId) {
      parts.push(`agent:${s.agentId}`);
    }
    if (showColumn("provider") && (s.modelProvider || s.providerOverride)) {
      parts.push(`provider:${s.modelProvider ?? s.providerOverride}`);
    }
    if (showColumn("model") && s.model) {
      parts.push(`model:${s.model}`);
    }
    if (showColumn("messages") && s.usage?.messageCounts) {
      parts.push(`msgs:${s.usage.messageCounts.total}`);
    }
    if (showColumn("tools") && s.usage?.toolUsage) {
      parts.push(`tools:${s.usage.toolUsage.totalCalls}`);
    }
    if (showColumn("errors") && s.usage?.messageCounts) {
      parts.push(`errors:${s.usage.messageCounts.errors}`);
    }
    if (showColumn("duration") && s.usage?.durationMs) {
      parts.push(`dur:${formatDurationCompact(s.usage.durationMs, { spaced: true }) ?? "—"}`);
    }
    return parts;
  };

  const selectedDaySet = new Set(selectedDays);

  const getSessionMetricValue = (s: UsageSessionEntry, metric: "tokens" | "cost"): number => {
    const usage = s.usage;
    if (!usage) {
      return 0;
    }

    if (selectedDaySet.size > 0 && usage.dailyBreakdown && usage.dailyBreakdown.length > 0) {
      return usage.dailyBreakdown.reduce((sum, day) => {
        if (!selectedDaySet.has(day.date)) {
          return sum;
        }
        return sum + (metric === "tokens" ? day.tokens : day.cost);
      }, 0);
    }

    return metric === "tokens" ? (usage.totalTokens ?? 0) : (usage.totalCost ?? 0);
  };

  const getSessionValue = (s: UsageSessionEntry): number => {
    return getSessionMetricValue(s, isTokenMode ? "tokens" : "cost");
  };

  const getSessionSortValue = (s: UsageSessionEntry): number => {
    switch (sessionSort) {
      case "recent":
        return s.updatedAt ?? 0;
      case "messages":
        return s.usage?.messageCounts?.total ?? 0;
      case "errors":
        return s.usage?.messageCounts?.errors ?? 0;
      case "cost":
        return getSessionMetricValue(s, "cost");
      case "tokens":
        return getSessionMetricValue(s, "tokens");
    }
    const exhaustiveSort: never = sessionSort;
    return exhaustiveSort;
  };

  const sortedSessions = [...sessions].toSorted((a, b) => {
    const valueDiff = getSessionSortValue(b) - getSessionSortValue(a);
    if (valueDiff !== 0) {
      return valueDiff;
    }
    const recentDiff = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    if (recentDiff !== 0) {
      return recentDiff;
    }
    return formatSessionListLabel(a).localeCompare(formatSessionListLabel(b));
  });
  const sortedWithDir = sessionSortDir === "asc" ? sortedSessions.toReversed() : sortedSessions;

  const totalValue = sortedWithDir.reduce((sum, session) => sum + getSessionValue(session), 0);
  const avgValue = sortedWithDir.length ? totalValue / sortedWithDir.length : 0;
  const totalErrors = sortedWithDir.reduce(
    (sum, session) => sum + (session.usage?.messageCounts?.errors ?? 0),
    0,
  );

  const renderSessionBarRow = (s: UsageSessionEntry, isSelected: boolean) => {
    const value = getSessionValue(s);
    const displayLabel = formatSessionListLabel(s);
    const meta = buildSessionMeta(s);
    return html`
      <div
        class="session-bar-row ${isSelected ? "selected" : ""}"
        @click=${(e: MouseEvent) => onSelectSession(s.key, e.shiftKey)}
        title="${s.key}"
      >
        <div class="session-bar-label">
          <div class="session-bar-title">${displayLabel}</div>
          ${meta.length > 0
            ? html`<div class="session-bar-meta">${meta.join(" · ")}</div>`
            : nothing}
        </div>
        <div class="session-bar-actions">
          <button
            class="btn btn--sm btn--ghost"
            title=${t("usage.sessions.copyName")}
            @click=${(e: MouseEvent) => {
              e.stopPropagation();
              void copySessionName(s);
            }}
          >
            ${t("usage.sessions.copy")}
          </button>
          <div class="session-bar-value">
            ${isTokenMode ? formatTokens(value) : formatCost(value)}
          </div>
        </div>
      </div>
    `;
  };

  const selectedSet = new Set(selectedSessions);
  const selectedEntries = sortedWithDir.filter((s) => selectedSet.has(s.key));
  const selectedCount = selectedEntries.length;
  const sessionMap = new Map(sortedWithDir.map((s) => [s.key, s]));
  const recentEntries = recentSessions
    .map((key) => sessionMap.get(key))
    .filter((entry): entry is UsageSessionEntry => Boolean(entry));

  return html`
    <div class="card sessions-card">
      <div class="sessions-card-header">
        <div class="card-title">${t("usage.sessions.title")}</div>
        <div class="sessions-card-count">
          ${t("usage.sessions.shown", { count: String(sessions.length) })}
          ${totalSessions !== sessions.length
            ? ` · ${t("usage.sessions.total", { count: String(totalSessions) })}`
            : ""}
        </div>
      </div>
      <div class="sessions-card-meta">
        <div class="sessions-card-stats">
          <span>
            ${isTokenMode ? formatTokens(avgValue) : formatCost(avgValue)}
            ${t("usage.sessions.avg")}
          </span>
          <span>${totalErrors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))}</span>
        </div>
        <div class="chart-toggle small">
          <button
            class="btn btn--sm toggle-btn ${sessionsTab === "all" ? "active" : ""}"
            @click=${() => onSessionsTabChange("all")}
          >
            ${t("usage.sessions.all")}
          </button>
          <button
            class="btn btn--sm toggle-btn ${sessionsTab === "recent" ? "active" : ""}"
            @click=${() => onSessionsTabChange("recent")}
          >
            ${t("usage.sessions.recent")}
          </button>
        </div>
        <label class="sessions-sort">
          <span>${t("usage.sessions.sort")}</span>
          <select
            @change=${(e: Event) =>
              onSessionSortChange((e.target as HTMLSelectElement).value as typeof sessionSort)}
          >
            <option value="cost" ?selected=${sessionSort === "cost"}>
              ${t("usage.metrics.cost")}
            </option>
            <option value="errors" ?selected=${sessionSort === "errors"}>
              ${t("usage.overview.errors")}
            </option>
            <option value="messages" ?selected=${sessionSort === "messages"}>
              ${t("usage.overview.messages")}
            </option>
            <option value="recent" ?selected=${sessionSort === "recent"}>
              ${t("usage.sessions.recentShort")}
            </option>
            <option value="tokens" ?selected=${sessionSort === "tokens"}>
              ${t("usage.metrics.tokens")}
            </option>
          </select>
        </label>
        <button
          class="btn btn--sm"
          @click=${() => onSessionSortDirChange(sessionSortDir === "desc" ? "asc" : "desc")}
          title=${sessionSortDir === "desc"
            ? t("usage.sessions.descending")
            : t("usage.sessions.ascending")}
        >
          ${sessionSortDir === "desc" ? "↓" : "↑"}
        </button>
        ${selectedCount > 0
          ? html`
              <button class="btn btn--sm" @click=${onClearSessions}>
                ${t("usage.sessions.clearSelection")}
              </button>
            `
          : nothing}
      </div>
      ${sessionsTab === "recent"
        ? recentEntries.length === 0
          ? html` <div class="usage-empty-block">${t("usage.sessions.noRecent")}</div> `
          : html`
              <div class="session-bars session-bars--recent">
                ${recentEntries.map((s) => renderSessionBarRow(s, selectedSet.has(s.key)))}
              </div>
            `
        : sessions.length === 0
          ? html` <div class="usage-empty-block">${t("usage.sessions.noneInRange")}</div> `
          : html`
              <div class="session-bars">
                ${sortedWithDir
                  .slice(0, 50)
                  .map((s) => renderSessionBarRow(s, selectedSet.has(s.key)))}
                ${sessions.length > 50
                  ? html`
                      <div class="usage-more-sessions">
                        ${t("usage.sessions.more", { count: String(sessions.length - 50) })}
                      </div>
                    `
                  : nothing}
              </div>
            `}
      ${selectedCount > 1
        ? html`
            <div class="sessions-selected-group">
              <div class="sessions-card-count">
                ${t("usage.sessions.selected", { count: String(selectedCount) })}
              </div>
              <div class="session-bars session-bars--selected">
                ${selectedEntries.map((s) => renderSessionBarRow(s, true))}
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

export {
  renderCostBreakdownCompact,
  renderDailyChartCompact,
  renderFilterChips,
  renderInsightList,
  renderPeakErrorList,
  renderSessionsCard,
  renderUsageInsights,
};
