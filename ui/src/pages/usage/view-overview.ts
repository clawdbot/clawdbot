import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Control UI view renders usage render overview screen content.
import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import {
  buildUsageCostWindows,
  buildUsageCostWindowSummary,
  formatUsageCost,
  formatDayLabel,
  formatFullDate,
  formatIsoDate,
  formatUsageTokens,
} from "./metrics.ts";
import type { UsageInsightStats } from "./metrics.ts";
import type {
  UsageAggregates,
  UsageColumnId,
  UsageSessionEntry,
  UsageTotals,
  CostDailyEntry,
} from "./types.ts";

function tokenCategory<Key extends "output" | "input" | "cacheWrite" | "cacheRead">(
  key: Key,
  hintKey: string,
  short: string,
) {
  return {
    key,
    className: key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
    labelKey: `usage.breakdown.${key}`,
    hintKey,
    short,
  };
}

const USAGE_TOKEN_CATEGORIES = [
  tokenCategory("output", "usage.details.assistantOutputTokens", "Out"),
  tokenCategory("input", "usage.details.userToolInputTokens", "In"),
  tokenCategory("cacheWrite", "usage.details.tokensWrittenToCache", "CW"),
  tokenCategory("cacheRead", "usage.details.tokensReadFromCache", "CR"),
] as const;

function pct(part: number, total: number): number {
  return total === 0 ? 0 : (part / total) * 100;
}

function formatAnalysisCost(value: number): string {
  const magnitude = Math.abs(value);
  const decimals = magnitude === 0 || magnitude >= 0.01 ? 2 : magnitude >= 0.0001 ? 4 : 6;
  return formatUsageCost(value, decimals);
}

function handleDailyBarKeydown(
  event: KeyboardEvent,
  day: string,
  onSelectDay: (day: string, shiftKey: boolean) => void,
) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  onSelectDay(day, event.shiftKey);
}

function renderUsageToggle<Value extends string>(
  current: Value,
  onChange: (value: Value) => void,
  options: ReadonlyArray<{ value: Value; labelKey: string }>,
  className = "chart-toggle small",
) {
  return html`
    <div class=${className}>
      ${options.map(
        ({ value, labelKey }) => html`
          <button
            class="btn btn--sm toggle-btn ${current === value ? "active" : ""}"
            @click=${() => onChange(value)}
          >
            ${t(labelKey)}
          </button>
        `,
      )}
    </div>
  `;
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

  const selectedSessionKey = selectedSessions.at(0) ?? "";
  const selectedSession =
    selectedSessions.length === 1 ? sessions.find((s) => s.key === selectedSessionKey) : null;
  const sessionsLabel = selectedSession
    ? truncateUtf16Safe(selectedSession.label || selectedSession.key, 20) +
      ((selectedSession.label || selectedSession.key).length > 20 ? "…" : "")
    : selectedSessions.length === 1
      ? truncateUtf16Safe(selectedSessionKey, 8) + "…"
      : t("usage.filters.sessionsCount", { count: String(selectedSessions.length) });
  const sessionsFullName = selectedSession
    ? selectedSession.label || selectedSession.key
    : selectedSessions.length === 1
      ? selectedSessionKey
      : selectedSessions.join(", ");

  const daysLabel =
    selectedDays.length === 1
      ? selectedDays[0]
      : t("usage.filters.daysCount", { count: String(selectedDays.length) });
  const hoursLabel =
    selectedHours.length === 1
      ? `${selectedHours[0]}:00`
      : t("usage.filters.hoursCount", { count: String(selectedHours.length) });
  const chips = [
    {
      active: selectedDays.length > 0,
      labelKey: "usage.filters.days",
      value: daysLabel,
      removeKey: "usage.filters.removeDays",
      onClear: onClearDays,
    },
    {
      active: selectedHours.length > 0,
      labelKey: "usage.filters.hours",
      value: hoursLabel,
      removeKey: "usage.filters.removeHours",
      onClear: onClearHours,
    },
    {
      active: selectedSessions.length > 0,
      labelKey: "usage.filters.session",
      value: sessionsLabel,
      removeKey: "usage.filters.removeSession",
      onClear: onClearSessions,
      title: sessionsFullName,
    },
  ];

  return html`
    <div class="active-filters">
      ${chips
        .filter(({ active }) => active)
        .map(
          ({ labelKey, value, removeKey, onClear, title }) => html`
            <div class="filter-chip" title=${ifDefined(title)}>
              <span class="filter-chip-label">${t(labelKey)}: ${value}</span>
              <openclaw-tooltip .content=${t("usage.filters.remove")}>
                <button class="filter-chip-remove" @click=${onClear} aria-label=${t(removeKey)}>
                  ×
                </button>
              </openclaw-tooltip>
            </div>
          `,
        )}
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

function renderCostWindowComparison(
  daily: CostDailyEntry[],
  rangeStartDate: string,
  rangeEndDate: string,
) {
  const range = buildUsageCostWindowSummary(daily, rangeStartDate, rangeEndDate);
  if (!range || daily.length === 0) {
    return nothing;
  }

  const windows = buildUsageCostWindows(daily, rangeStartDate, rangeEndDate);
  const today = formatIsoDate(new Date());
  const labelForWindow = (days: number, endDate: string) => {
    if (days === 1) {
      return endDate === today ? t("usage.presets.today") : formatDayLabel(endDate);
    }
    return t("usage.costWindows.lastDays", { count: String(days) });
  };
  const cards = [
    { label: t("usage.costWindows.selectedRange"), summary: range, range: true },
    ...windows.map((summary) => ({
      label: labelForWindow(summary.days, summary.endDate),
      summary,
      range: false,
    })),
  ];

  return html`
    <section class="cost-window-analysis">
      <div class="cost-window-header">
        <div>
          <div class="card-title usage-section-title">${t("usage.costWindows.title")}</div>
          <div class="card-sub">
            ${t("usage.costWindows.subtitle", { date: formatFullDate(rangeEndDate) })}
          </div>
        </div>
        <div class="cost-window-range-label">
          ${formatDayLabel(rangeStartDate)} – ${formatDayLabel(rangeEndDate)}
        </div>
      </div>
      <div class="cost-window-grid">
        ${cards.map(({ label, summary, range: isRange }) => {
          const averageDailyCost = summary.totals.totalCost / summary.days;
          return html`
            <div class="cost-window-card ${isRange ? "cost-window-card--range" : ""}">
              <div class="cost-window-card__label">${label}</div>
              <div class="cost-window-card__value">
                ${formatAnalysisCost(summary.totals.totalCost)}
              </div>
              <div class="cost-window-card__meta">
                ${formatUsageTokens(summary.totals.totalTokens)} ${t("usage.metrics.tokens")} ·
                ${formatAnalysisCost(averageDailyCost)} ${t("usage.costWindows.perDay")}
              </div>
            </div>
          `;
        })}
      </div>
    </section>
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
  const scaleMaximum = Math.max(...values, 0);
  const maxValue = scaleMaximum > 0 ? scaleMaximum : isTokenMode ? 1 : 0.0001;

  // Adaptive scaling: when the spread between largest and smallest non-zero
  // values is extreme (>50×), use square-root compression so small bars stay
  // visible instead of collapsing to a single pixel.
  const nonZero = values.filter((v) => v > 0);
  const minNonZero = nonZero.length > 0 ? Math.min(...nonZero) : maxValue;
  const spread = maxValue / minNonZero;
  const usesCompressedScale = spread > 50;
  const chartAreaPx = 200;
  const minBarPx = 6;
  const barHeights = values.map((v): number => {
    if (v <= 0) {
      return 0;
    }
    const ratio = usesCompressedScale ? Math.sqrt(v / maxValue) : v / maxValue;
    return Math.max(minBarPx, ratio * chartAreaPx);
  });

  // Calculate bar width based on number of days
  const barMaxWidth = daily.length > 30 ? 12 : daily.length > 20 ? 18 : daily.length > 14 ? 24 : 32;
  const showTotals = daily.length <= 14;
  const selectedDaySet = new Set(selectedDays);

  return html`
    <div class="daily-chart-compact">
      <div class="daily-chart-header">
        ${renderUsageToggle(
          dailyChartMode,
          onDailyChartModeChange,
          [
            { value: "total", labelKey: "usage.daily.total" },
            { value: "by-type", labelKey: "usage.daily.byType" },
          ],
          "chart-toggle small sessions-toggle",
        )}
        <div class="card-title">
          ${isTokenMode ? t("usage.daily.tokensTitle") : t("usage.daily.costTitle")}
          ${usesCompressedScale
            ? html`<span
                class="daily-chart-scale-badge"
                title=${t("usage.daily.compressedScaleHint")}
                aria-label=${t("usage.daily.compressedScaleHint")}
                >√</span
              >`
            : nothing}
        </div>
      </div>
      <div class="daily-chart">
        <div class="daily-chart-plot">
          <div class="daily-chart-scale" aria-hidden="true">
            ${(scaleMaximum > 0
              ? [scaleMaximum, scaleMaximum / (usesCompressedScale ? 4 : 2), 0]
              : [0]
            ).map(
              (value) =>
                html`<span
                  >${isTokenMode
                    ? formatUsageTokens(value)
                    : value === 0
                      ? formatUsageCost(0)
                      : formatAnalysisCost(value)}</span
                >`,
            )}
          </div>
          <div class="daily-chart-bars" style="--bar-max-width: ${barMaxWidth}px">
            ${daily.map((d, idx) => {
              const heightPx = expectDefined(barHeights[idx], "daily usage bar height");
              const isSelected = selectedDaySet.has(d.date);
              const label = formatDayLabel(d.date);
              // Shorter label for many days (just day number)
              const shortLabel =
                daily.length > 20 ? String(Number.parseInt(d.date.slice(8), 10)) : label;
              const labelClass =
                daily.length > 20 ? "daily-bar-label daily-bar-label--compact" : "daily-bar-label";
              const segments =
                dailyChartMode === "by-type"
                  ? USAGE_TOKEN_CATEGORIES.map(({ key, className, labelKey }) => ({
                      value: isTokenMode ? d[key] : (d[`${key}Cost`] ?? 0),
                      className,
                      labelKey,
                    }))
                  : [];
              const breakdownLines = segments.map(
                ({ value, labelKey }) =>
                  `${t(labelKey)} ${isTokenMode ? formatUsageTokens(value) : formatAnalysisCost(value)}`,
              );
              const totalLabel = isTokenMode
                ? formatUsageTokens(d.totalTokens)
                : formatAnalysisCost(d.totalCost);
              const dateLabel = formatFullDate(d.date);
              const tokensLabel =
                `${formatUsageTokens(d.totalTokens)} ${normalizeLowercaseStringOrEmpty(
                  t("usage.metrics.tokens"),
                )}`.trim();
              const costLabel = formatAnalysisCost(d.totalCost);
              const segmentTotal = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
              return html`
                <openclaw-tooltip
                  .content=${[dateLabel, tokensLabel, costLabel, ...breakdownLines].join("\n")}
                >
                  <div
                    class="daily-bar-wrapper ${isSelected ? "selected" : ""}"
                    role="button"
                    tabindex="0"
                    aria-pressed=${isSelected ? "true" : "false"}
                    aria-label=${`${dateLabel}: ${tokensLabel}, ${costLabel}`}
                    @keydown=${(e: KeyboardEvent) => handleDailyBarKeydown(e, d.date, onSelectDay)}
                    @click=${(e: MouseEvent) => onSelectDay(d.date, e.shiftKey)}
                  >
                    ${dailyChartMode === "by-type"
                      ? html`
                          <div
                            class="daily-bar daily-bar--stacked"
                            style="height: ${heightPx.toFixed(0)}px;"
                          >
                            ${segments.map(
                              ({ className, value }) => html`
                                <div
                                  class="cost-segment ${className}"
                                  style="height: ${(value / segmentTotal) * 100}%"
                                ></div>
                              `,
                            )}
                          </div>
                        `
                      : html`
                          <div class="daily-bar" style="height: ${heightPx.toFixed(0)}px"></div>
                        `}
                    ${showTotals
                      ? html`<div class="daily-bar-total">${totalLabel}</div>`
                      : html`<div
                          class="daily-bar-total daily-bar-total--placeholder"
                          aria-hidden="true"
                        ></div>`}
                    <div class="${labelClass}">${shortLabel}</div>
                  </div>
                </openclaw-tooltip>
              `;
            })}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderCostBreakdownCompact(totals: UsageTotals, mode: "tokens" | "cost") {
  const isTokenMode = mode === "tokens";
  const total = isTokenMode ? totals.totalTokens || 1 : totals.totalCost || 0;
  const categories = USAGE_TOKEN_CATEGORIES.map(({ key, className, labelKey }) => {
    const value = isTokenMode ? totals[key] : totals[`${key}Cost`] || 0;
    return {
      className,
      labelKey,
      percentage: pct(value, total),
      formatted: isTokenMode ? formatUsageTokens(value) : formatAnalysisCost(value),
    };
  });

  return html`
    <div class="cost-breakdown cost-breakdown-compact">
      <div class="cost-breakdown-header">
        ${isTokenMode ? t("usage.breakdown.tokensByType") : t("usage.breakdown.costByType")}
      </div>
      <div class="cost-breakdown-bar">
        ${categories.map(
          ({ className, labelKey, percentage, formatted }) => html`
            <div
              class="cost-segment ${className}"
              style="width: ${percentage.toFixed(1)}%"
              title="${t(labelKey)}: ${formatted}"
            ></div>
          `,
        )}
      </div>
      <div class="cost-breakdown-legend">
        ${categories.map(
          ({ className, labelKey, formatted }) => html`
            <span class="legend-item"
              ><span class="legend-dot ${className}"></span>${t(labelKey)} ${formatted}</span
            >
          `,
        )}
      </div>
      <div class="cost-breakdown-total">
        ${t("usage.breakdown.total")}:
        ${isTokenMode
          ? formatUsageTokens(totals.totalTokens)
          : formatAnalysisCost(totals.totalCost)}
      </div>
    </div>
  `;
}

function renderInsightList(
  title: string,
  items: Array<{ label: string; value: string; sub?: string }>,
  emptyLabel: string,
  options?: {
    className?: string;
    listClassName?: string;
    error?: boolean;
  },
) {
  const cardClass = ["usage-insight-card", options?.className].filter(Boolean).join(" ");
  const listClass = [options?.error ? "usage-error-list" : "usage-list", options?.listClassName]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${cardClass}>
      <div class="usage-insight-title">${title}</div>
      ${items.length === 0
        ? html`<div class="muted">${emptyLabel}</div>`
        : html`
            <div class=${listClass}>
              ${items.map((item) =>
                options?.error
                  ? html`
                      <div class="usage-error-row">
                        <div class="usage-error-date">${item.label}</div>
                        <div class="usage-error-rate">${item.value}</div>
                        ${item.sub ? html`<div class="usage-error-sub">${item.sub}</div>` : nothing}
                      </div>
                    `
                  : html`
                      <div class="usage-list-item">
                        <span>${item.label}</span>
                        <span class="usage-list-value">
                          <span>${item.value}</span>
                          ${item.sub
                            ? html`<span class="usage-list-sub">${item.sub}</span>`
                            : nothing}
                        </span>
                      </div>
                    `,
              )}
            </div>
          `}
    </div>
  `;
}

function focusSummaryHint(event: MouseEvent) {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    target.focus();
  }
}

function renderSummaryStat(params: {
  hintId: string;
  title: string;
  hint: string;
  value: string | number;
  sub: string;
  tone?: "good" | "warn" | "bad";
  className?: string;
  compactValue?: boolean;
}) {
  const hintId = `usage-summary-hint-${params.hintId}`;
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
        <openclaw-tooltip open-on-click>
          <button
            id=${hintId}
            type="button"
            class="usage-summary-hint"
            aria-label=${params.title}
            @click=${focusSummaryHint}
          >
            ?
          </button>
          <!-- Shared tooltips dismiss pointer activation so action buttons never
               strand one open. This hint exists only to be read, so it opts in to
               click-to-open; the click handler still normalizes browsers that do
               not focus buttons on pointer activation. -->
          <span slot="content">${params.hint}</span>
        </openclaw-tooltip>
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
  showCostShares: boolean,
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
      ? `${formatUsageTokens(Math.round(stats.throughputTokensPerMin))} ${t("usage.overview.tokensPerMinute")}`
      : t("usage.common.emptyValue");
  const throughputCostLabel =
    stats.throughputCostPerMin !== undefined
      ? `${formatAnalysisCost(stats.throughputCostPerMin)} ${t("usage.overview.perMinute")}`
      : t("usage.common.emptyValue");
  const avgDurationLabel =
    stats.durationCount > 0
      ? (formatDurationCompact(stats.avgDurationMs) ?? t("usage.common.emptyValue"))
      : t("usage.common.emptyValue");
  const errorDays = aggregates.daily
    .filter((day) => day.messages > 0 && day.errors > 0)
    .map((day) => {
      const rate = day.errors / day.messages;
      return {
        label: formatDayLabel(day.date),
        value: `${(rate * 100).toFixed(2)}%`,
        sub: `${day.errors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${day.messages} ${t("usage.overview.messagesAbbrev")} · ${formatUsageTokens(day.tokens)}`,
        rate,
      };
    })
    .toSorted((a, b) => b.rate - a.rate)
    .slice(0, 5)
    .map(({ rate: _rate, ...rest }) => rest);

  const costShare = (cost: number) =>
    showCostShares && totals.totalCost > 0
      ? t("usage.overview.costShare", { percent: ((cost / totals.totalCost) * 100).toFixed(1) })
      : null;
  const costAttributionSub = (cost: number, tokens: number, messageCount?: number) =>
    [
      costShare(cost),
      formatUsageTokens(tokens),
      messageCount === undefined ? null : `${messageCount} ${t("usage.overview.messagesAbbrev")}`,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");

  const topModels = aggregates.byModel.slice(0, 5).map((entry) => ({
    label: entry.model ?? t("usage.common.unknown"),
    value: formatAnalysisCost(entry.totals.totalCost),
    sub: costAttributionSub(entry.totals.totalCost, entry.totals.totalTokens, entry.count),
  }));
  const topProviders = aggregates.byProvider.slice(0, 5).map((entry) => ({
    label: entry.provider ?? t("usage.common.unknown"),
    value: formatAnalysisCost(entry.totals.totalCost),
    sub: costAttributionSub(entry.totals.totalCost, entry.totals.totalTokens, entry.count),
  }));
  const topTools = aggregates.tools.tools.slice(0, 6).map((tool) => ({
    label: tool.name,
    value: `${tool.count}`,
    sub: t("usage.overview.calls"),
  }));
  const topAgents = aggregates.byAgent.slice(0, 5).map((entry) => ({
    label: entry.agentId,
    value: formatAnalysisCost(entry.totals.totalCost),
    sub: costAttributionSub(entry.totals.totalCost, entry.totals.totalTokens),
  }));
  const topChannels = aggregates.byChannel.slice(0, 5).map((entry) => ({
    label: entry.channel,
    value: formatAnalysisCost(entry.totals.totalCost),
    sub: costAttributionSub(entry.totals.totalCost, entry.totals.totalTokens),
  }));
  const insightLists = [
    ["usage.overview.topModels", topModels, "usage.overview.noModelData"],
    ["usage.overview.topProviders", topProviders, "usage.overview.noProviderData"],
    ["usage.overview.topTools", topTools, "usage.overview.noToolCalls"],
    ["usage.overview.topAgents", topAgents, "usage.overview.noAgentData"],
    ["usage.overview.topChannels", topChannels, "usage.overview.noChannelData"],
  ] as const;

  return renderSettingsSection(
    { title: t("usage.overview.title") },
    html`
      <section class="usage-panel usage-overview-card">
        <div class="usage-overview-layout">
          <div class="usage-summary-grid">
            ${renderSummaryStat({
              hintId: "messages",
              title: t("usage.overview.messages"),
              hint: t("usage.overview.messagesHint"),
              value: aggregates.messages.total,
              sub: `${aggregates.messages.user} ${normalizeLowercaseStringOrEmpty(t("usage.overview.user"))} · ${aggregates.messages.assistant} ${normalizeLowercaseStringOrEmpty(t("usage.overview.assistant"))}`,
              className: "usage-summary-card--hero",
            })}
            ${renderSummaryStat({
              hintId: "throughput",
              title: t("usage.overview.throughput"),
              hint: t("usage.overview.throughputHint"),
              value: throughputLabel,
              sub: throughputCostLabel,
              className: "usage-summary-card--hero usage-summary-card--throughput",
              compactValue: true,
            })}
            ${renderSummaryStat({
              hintId: "tool-calls",
              title: t("usage.overview.toolCalls"),
              hint: t("usage.overview.toolCallsHint"),
              value: aggregates.tools.totalCalls,
              sub: `${aggregates.tools.uniqueTools} ${t("usage.overview.toolsUsed")}`,
              className: "usage-summary-card--half",
            })}
            ${renderSummaryStat({
              hintId: "average-tokens",
              title: t("usage.overview.avgTokens"),
              hint: t("usage.overview.avgTokensHint"),
              value: formatUsageTokens(avgTokens),
              sub: t("usage.overview.acrossMessages", {
                count: String(aggregates.messages.total || 0),
              }),
              className: "usage-summary-card--half",
            })}
            ${renderSummaryStat({
              hintId: "cache-hit-rate",
              title: t("usage.overview.cacheHitRate"),
              hint: t("usage.overview.cacheHint"),
              value: cacheHitLabel,
              sub: `${formatUsageTokens(totals.cacheRead)} ${t("usage.overview.cached")} · ${formatUsageTokens(cacheBase)} ${t("usage.overview.prompt")}`,
              tone: cacheHitRate > 0.6 ? "good" : cacheHitRate > 0.3 ? "warn" : "bad",
              className: "usage-summary-card--medium",
            })}
            ${renderSummaryStat({
              hintId: "error-rate",
              title: t("usage.overview.errorRate"),
              hint: t("usage.overview.errorHint"),
              value: `${errorRatePct.toFixed(2)}%`,
              sub: `${aggregates.messages.errors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${avgDurationLabel} ${t("usage.overview.avgSession")}`,
              tone: errorRatePct > 5 ? "bad" : errorRatePct > 1 ? "warn" : "good",
              className: "usage-summary-card--medium",
            })}
            ${renderSummaryStat({
              hintId: "average-cost",
              title: t("usage.overview.avgCost"),
              hint: t(
                showCostHint ? "usage.overview.avgCostHintMissing" : "usage.overview.avgCostHint",
              ),
              value: formatAnalysisCost(avgCost),
              sub: `${formatAnalysisCost(totals.totalCost)} ${normalizeLowercaseStringOrEmpty(t("usage.breakdown.total"))}`,
              className: "usage-summary-card--compact",
            })}
            ${renderSummaryStat({
              hintId: "sessions",
              title: t("usage.overview.sessions"),
              hint: t("usage.overview.sessionsHint"),
              value: sessionCount,
              sub: t("usage.overview.sessionsInRange", { count: String(totalSessions) }),
              className: "usage-summary-card--compact",
            })}
            ${renderSummaryStat({
              hintId: "errors",
              title: t("usage.overview.errors"),
              hint: t("usage.overview.errorsHint"),
              value: aggregates.messages.errors,
              sub: `${aggregates.messages.toolResults} ${t("usage.overview.toolResults")}`,
              className: "usage-summary-card--compact",
            })}
          </div>
          <div class="usage-insights-grid">
            ${insightLists.map(([titleKey, items, emptyKey]) =>
              renderInsightList(t(titleKey), items, t(emptyKey)),
            )}
            ${renderInsightList(
              t("usage.overview.peakErrorDays"),
              errorDays,
              t("usage.overview.noErrorData"),
              { error: true },
            )}
            ${renderInsightList(
              t("usage.overview.peakErrorHours"),
              errorHours,
              t("usage.overview.noErrorData"),
              {
                error: true,
                className: "usage-insight-card--wide",
                listClassName: "usage-error-list--hours",
              },
            )}
          </div>
        </div>
      </section>
    `,
  );
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
  const buildSessionMeta = (session: UsageSessionEntry): string[] =>
    [
      showColumn("channel") && session.channel && `channel:${session.channel}`,
      showColumn("agent") && session.agentId && `agent:${session.agentId}`,
      showColumn("provider") &&
        (session.modelProvider || session.providerOverride) &&
        `provider:${session.modelProvider ?? session.providerOverride}`,
      showColumn("model") && session.model && `model:${session.model}`,
      showColumn("messages") &&
        session.usage?.messageCounts &&
        `msgs:${session.usage.messageCounts.total}`,
      showColumn("tools") &&
        session.usage?.toolUsage &&
        `tools:${session.usage.toolUsage.totalCalls}`,
      showColumn("errors") &&
        session.usage?.messageCounts &&
        `errors:${session.usage.messageCounts.errors}`,
      showColumn("duration") &&
        session.usage?.durationMs &&
        `dur:${formatDurationCompact(session.usage.durationMs) ?? "—"}`,
    ].filter((part): part is string => typeof part === "string" && part.length > 0);

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
        @click=${(event: MouseEvent) => {
          if ((event.target as Element | null)?.closest("button")) {
            return;
          }
          onSelectSession(s.key, event.shiftKey);
        }}
        title="${s.key}"
      >
        <button
          type="button"
          class="session-bar-selection"
          aria-label=${displayLabel}
          aria-pressed=${isSelected ? "true" : "false"}
          @click=${(event: MouseEvent) => onSelectSession(s.key, event.shiftKey)}
        >
          <span class="session-bar-label">
            <span class="session-bar-title">${displayLabel}</span>
            ${meta.length > 0
              ? html`<span class="session-bar-meta">${meta.join(" · ")}</span>`
              : nothing}
          </span>
        </button>
        <div class="session-bar-actions">
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            @click=${(e: MouseEvent) => {
              e.stopPropagation();
              void copyToClipboard(formatSessionListLabel(s));
            }}
          >
            ${t("usage.sessions.copy")}
          </button>
          <div class="session-bar-value">
            ${isTokenMode ? formatUsageTokens(value) : formatAnalysisCost(value)}
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

  return renderSettingsSection(
    { title: t("usage.sessions.title") },
    html`
      <div class="usage-panel sessions-card">
        <div class="sessions-card-header">
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
              ${isTokenMode ? formatUsageTokens(avgValue) : formatAnalysisCost(avgValue)}
              ${t("usage.sessions.avg")}
            </span>
            <span
              >${totalErrors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))}</span
            >
          </div>
          ${renderUsageToggle(sessionsTab, onSessionsTabChange, [
            { value: "all", labelKey: "usage.sessions.all" },
            { value: "recent", labelKey: "usage.sessions.recent" },
          ])}
          <label class="sessions-sort">
            <span>${t("usage.sessions.sort")}</span>
            <select
              class="settings-select"
              @change=${(e: Event) =>
                onSessionSortChange((e.target as HTMLSelectElement).value as typeof sessionSort)}
            >
              ${Object.entries({
                cost: "usage.metrics.cost",
                errors: "usage.overview.errors",
                messages: "usage.overview.messages",
                recent: "usage.sessions.recentShort",
                tokens: "usage.metrics.tokens",
              }).map(
                ([value, labelKey]) =>
                  html`<option value=${value} ?selected=${sessionSort === value}>
                    ${t(labelKey)}
                  </option>`,
              )}
            </select>
          </label>
          <openclaw-tooltip
            .content=${sessionSortDir === "desc"
              ? t("usage.sessions.descending")
              : t("usage.sessions.ascending")}
          >
            <button
              class="btn btn--sm"
              aria-label=${sessionSortDir === "desc"
                ? t("usage.sessions.descending")
                : t("usage.sessions.ascending")}
              @click=${() => onSessionSortDirChange(sessionSortDir === "desc" ? "asc" : "desc")}
            >
              ${sessionSortDir === "desc" ? "↓" : "↑"}
            </button>
          </openclaw-tooltip>
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
    `,
  );
}

export {
  renderCostBreakdownCompact,
  renderCostWindowComparison,
  renderDailyChartCompact,
  renderFilterChips,
  renderInsightList,
  renderSessionsCard,
  renderUsageInsights,
  renderUsageToggle,
  USAGE_TOKEN_CATEGORIES,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
