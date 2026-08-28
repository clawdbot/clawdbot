import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Control UI view renders usage render details screen content.
import { html, svg, nothing } from "lit";
import {
  renderPanelRefreshStatus,
  type PanelRefreshStatus,
} from "../../components/panel-refresh-status.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import {
  formatDurationCompact,
  formatDateTimeMs,
  formatMs,
  formatTimeMs,
} from "../../lib/format.ts";
import { parseToolSummary } from "./helpers.ts";
import { charsToTokens, formatUsageCost, formatUsageTokens } from "./metrics.ts";
import type {
  SessionLogEntry,
  SessionLogRole,
  TimeSeriesPoint,
  UsageSessionEntry,
} from "./types.ts";
import { renderInsightList, renderUsageToggle, USAGE_TOKEN_CATEGORIES } from "./view-overview.ts";

// Chart constants
const CHART_BAR_WIDTH_RATIO = 0.75; // Fraction of slot used for bar (rest is gap)
const CHART_MAX_BAR_WIDTH = 8; // Max bar width in SVG viewBox units
const CHART_SELECTION_OPACITY = 0.06; // Opacity of range selection overlay
const HANDLE_WIDTH = 5; // Width of drag handle in SVG units
const HANDLE_HEIGHT = 12; // Height of drag handle
const HANDLE_GRIP_OFFSET = 0.7; // Offset of grip lines inside handle

function pct(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

/** Normalize a log timestamp to milliseconds (handles seconds vs ms). */
function normalizeLogTimestamp(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

function dateBoundaryMs(date: string, timeZone: "local" | "utc", dayOffset: 0 | 1): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10)) + dayOffset;
  // Build the target date directly; advancing a normalized skipped midnight can retain 01:00.
  return timeZone === "utc" ? Date.UTC(year, month, day) : new Date(year, month, day).getTime();
}

export function usageDateKey(timestamp: number, timeZone: "local" | "utc"): string {
  const value = new Date(timestamp);
  const year = timeZone === "utc" ? value.getUTCFullYear() : value.getFullYear();
  const month = (timeZone === "utc" ? value.getUTCMonth() : value.getMonth()) + 1;
  const day = timeZone === "utc" ? value.getUTCDate() : value.getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Filter session logs by a timestamp range. */
function filterLogsByRange(
  logs: SessionLogEntry[],
  rangeStart: number,
  rangeEnd: number,
): SessionLogEntry[] {
  const lo = Math.min(rangeStart, rangeEnd);
  const hi = Math.max(rangeStart, rangeEnd);
  return logs.filter((log) => {
    if (log.timestamp <= 0) {
      return true;
    }
    const ts = normalizeLogTimestamp(log.timestamp);
    return ts >= lo && ts <= hi;
  });
}

function renderUsageRefreshStatus(
  status: PanelRefreshStatus,
  onRetry: () => void,
  detailKey: string,
  kind: "timeline" | "conversation",
) {
  return renderPanelRefreshStatus({
    status,
    errorMessage: status.error
      ? t("usage.details.loadFailed", {
          detail: normalizeLowercaseStringOrEmpty(t(detailKey)),
          error: status.error,
        })
      : undefined,
    onRetry,
    className: `usage-callout usage-detail-error--${kind}`,
  });
}

function renderSessionSummary(
  session: UsageSessionEntry,
  filteredUsage?: UsageSessionEntry["usage"],
  filteredLogs?: SessionLogEntry[],
) {
  const usage = filteredUsage || session.usage;
  if (!usage) {
    return html` <div class="usage-empty-block">${t("usage.details.noUsageData")}</div> `;
  }

  const formatTs = (ts?: number): string => (ts ? formatMs(ts) : t("usage.common.emptyValue"));

  const badges = [
    session.channel && `channel:${session.channel}`,
    session.agentId && `agent:${session.agentId}`,
    (session.modelProvider || session.providerOverride) &&
      `provider:${session.modelProvider ?? session.providerOverride}`,
    session.model && `model:${session.model}`,
  ].filter(Boolean);

  // Always use the full tool list for stable layout; update counts when filtering
  const baseTools = usage.toolUsage?.tools.slice(0, 6) ?? [];
  let toolCounts: Map<string, number> | undefined;
  if (filteredLogs) {
    toolCounts = new Map();
    for (const log of filteredLogs) {
      const { tools } = parseToolSummary(log.content);
      for (const [name] of tools) {
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      }
    }
  }
  const toolItems = baseTools.map((tool) => ({
    label: tool.name,
    value: `${toolCounts ? (toolCounts.get(tool.name) ?? 0) : tool.count}`,
    sub: t("usage.overview.calls"),
  }));
  const toolCallCount = toolCounts
    ? [...toolCounts.values()].reduce((sum, count) => sum + count, 0)
    : (usage.toolUsage?.totalCalls ?? 0);
  const uniqueToolCount = toolCounts ? toolCounts.size : (usage.toolUsage?.uniqueTools ?? 0);
  const modelItems =
    usage.modelUsage?.slice(0, 6).map((entry) => ({
      label: entry.model ?? t("usage.common.unknown"),
      value: formatUsageCost(entry.totals.totalCost),
      sub: formatUsageTokens(entry.totals.totalTokens),
    })) ?? [];
  const cards = [
    {
      labelKey: "usage.overview.messages",
      value: usage.messageCounts?.total ?? 0,
      meta: html`${usage.messageCounts?.user ?? 0}
      ${normalizeLowercaseStringOrEmpty(t("usage.overview.user"))} ·
      ${usage.messageCounts?.assistant ?? 0}
      ${normalizeLowercaseStringOrEmpty(t("usage.overview.assistant"))}`,
    },
    {
      labelKey: "usage.overview.toolCalls",
      value: toolCallCount,
      meta: html`${uniqueToolCount} ${t("usage.overview.toolsUsed")}`,
    },
    {
      labelKey: "usage.overview.errors",
      value: usage.messageCounts?.errors ?? 0,
      meta: html`${usage.messageCounts?.toolResults ?? 0} ${t("usage.overview.toolResults")}`,
    },
    {
      labelKey: "usage.details.duration",
      value: formatDurationCompact(usage.durationMs) ?? t("usage.common.emptyValue"),
      meta: html`${formatTs(usage.firstActivity)} → ${formatTs(usage.lastActivity)}`,
    },
  ];

  return html`
    ${badges.length > 0
      ? html`<div class="usage-badges">
          ${badges.map((b) => html`<span class="settings-row__value">${b}</span>`)}
        </div>`
      : nothing}
    <div class="session-summary-grid">
      ${cards.map(
        ({ labelKey, value, meta }) => html`
          <div class="stat session-summary-card">
            <div class="session-summary-title">${t(labelKey)}</div>
            <div class="stat-value session-summary-value">${value}</div>
            <div class="session-summary-meta">${meta}</div>
          </div>
        `,
      )}
    </div>
    <div class="usage-insights-grid usage-insights-grid--tight">
      ${renderInsightList(t("usage.overview.topTools"), toolItems, t("usage.overview.noToolCalls"))}
      ${renderInsightList(t("usage.details.modelMix"), modelItems, t("usage.overview.noModelData"))}
    </div>
  `;
}

/** Aggregate usage stats from time series points within a timestamp range. */
function computeFilteredUsage(
  baseUsage: NonNullable<UsageSessionEntry["usage"]>,
  points: TimeSeriesPoint[],
  rangeStart: number,
  rangeEnd: number,
): UsageSessionEntry["usage"] | undefined {
  const lo = Math.min(rangeStart, rangeEnd);
  const hi = Math.max(rangeStart, rangeEnd);
  const filtered = points.filter((p) => p.timestamp >= lo && p.timestamp <= hi);
  if (filtered.length === 0) {
    return undefined;
  }

  let totalTokens = 0;
  let totalCost = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  const tokenTotals = { output: 0, input: 0, cacheWrite: 0, cacheRead: 0 };

  for (const p of filtered) {
    totalTokens += p.totalTokens || 0;
    totalCost += p.cost || 0;
    for (const { key } of USAGE_TOKEN_CATEGORIES) {
      tokenTotals[key] += p[key] || 0;
    }
    assistantMessages += p.output > 0 ? 1 : 0;
    userMessages += p.input > 0 ? 1 : 0;
  }
  const first = expectDefined(filtered[0], "filtered usage first point");
  const last = expectDefined(filtered.at(-1), "filtered usage last point");

  return {
    ...baseUsage,
    ...tokenTotals,
    totalTokens,
    totalCost,
    durationMs: last.timestamp - first.timestamp,
    firstActivity: first.timestamp,
    lastActivity: last.timestamp,
    messageCounts: {
      total: filtered.length,
      user: userMessages,
      assistant: assistantMessages,
      toolCalls: 0,
      toolResults: 0,
      errors: 0,
    },
  };
}

function renderSessionDetailPanel(
  session: UsageSessionEntry,
  timeSeries: { points: TimeSeriesPoint[] } | null,
  timeSeriesLoading: boolean,
  timeSeriesStatus: PanelRefreshStatus,
  onRetryTimeSeries: () => void,
  timeSeriesMode: "cumulative" | "per-turn",
  onTimeSeriesModeChange: (mode: "cumulative" | "per-turn") => void,
  timeSeriesBreakdownMode: "total" | "by-type",
  onTimeSeriesBreakdownChange: (mode: "total" | "by-type") => void,
  timeSeriesCursorStart: number | null,
  timeSeriesCursorEnd: number | null,
  onTimeSeriesCursorRangeChange: (start: number | null, end: number | null) => void,
  startDate: string,
  endDate: string,
  selectedDays: string[],
  timeZone: "local" | "utc",
  sessionLogs: SessionLogEntry[] | null,
  sessionLogsLoading: boolean,
  sessionLogsStatus: PanelRefreshStatus,
  onRetrySessionLogs: () => void,
  sessionLogsExpanded: boolean,
  onToggleSessionLogsExpanded: () => void,
  logFilters: {
    roles: SessionLogRole[];
    tools: string[];
    hasTools: boolean;
    query: string;
  },
  onLogFilterRolesChange: (next: SessionLogRole[]) => void,
  onLogFilterToolsChange: (next: string[]) => void,
  onLogFilterHasToolsChange: (next: boolean) => void,
  onLogFilterQueryChange: (next: string) => void,
  onLogFilterClear: () => void,
  contextExpanded: boolean,
  onToggleContextExpanded: () => void,
  onClose: () => void,
) {
  const label = session.label || session.key;
  const displayLabel = label.length > 50 ? truncateUtf16Safe(label, 50) + "…" : label;
  const usage = session.usage;

  const hasRange = timeSeriesCursorStart !== null && timeSeriesCursorEnd !== null;
  const filteredUsage =
    timeSeriesCursorStart !== null && timeSeriesCursorEnd !== null && timeSeries?.points && usage
      ? computeFilteredUsage(usage, timeSeries.points, timeSeriesCursorStart, timeSeriesCursorEnd)
      : undefined;
  const headerStats = filteredUsage
    ? { totalTokens: filteredUsage.totalTokens, totalCost: filteredUsage.totalCost }
    : { totalTokens: usage?.totalTokens ?? 0, totalCost: usage?.totalCost ?? 0 };
  const cursorIndicator = filteredUsage ? t("usage.details.filtered") : "";

  return html`
    <div class="settings-group usage-panel session-detail-panel">
      <div class="session-detail-header">
        <div class="session-detail-header-left">
          <div class="session-detail-title">
            ${displayLabel}
            ${cursorIndicator
              ? html`<span class="session-detail-indicator">${cursorIndicator}</span>`
              : nothing}
          </div>
        </div>
        <div class="session-detail-stats">
          ${usage
            ? html`
                <span
                  ><strong>${formatUsageTokens(headerStats.totalTokens)}</strong>
                  ${normalizeLowercaseStringOrEmpty(
                    t("usage.metrics.tokens"),
                  )}${cursorIndicator}</span
                >
                <span
                  ><strong>${formatUsageCost(headerStats.totalCost)}</strong
                  >${cursorIndicator}</span
                >
              `
            : nothing}
        </div>
        <openclaw-tooltip .content=${t("usage.details.close")}>
          <button
            class="btn btn--sm btn--ghost"
            @click=${onClose}
            aria-label=${t("usage.details.close")}
          >
            ×
          </button>
        </openclaw-tooltip>
      </div>
      ${session.scope === "family" && session.includedSessionIds?.length
        ? html`
            <div class="usage-lineage-note">
              ${t("usage.scope.familyIncluded", {
                count: String(session.includedSessionIds.length),
              })}
            </div>
          `
        : nothing}
      <div class="session-detail-content">
        ${renderSessionSummary(
          session,
          filteredUsage,
          timeSeriesCursorStart != null && timeSeriesCursorEnd != null && sessionLogs
            ? filterLogsByRange(sessionLogs, timeSeriesCursorStart, timeSeriesCursorEnd)
            : undefined,
        )}
        <div class="session-detail-row">
          ${renderTimeSeriesCompact(
            timeSeries,
            timeSeriesLoading,
            timeSeriesStatus,
            onRetryTimeSeries,
            timeSeriesMode,
            onTimeSeriesModeChange,
            timeSeriesBreakdownMode,
            onTimeSeriesBreakdownChange,
            startDate,
            endDate,
            selectedDays,
            timeZone,
            timeSeriesCursorStart,
            timeSeriesCursorEnd,
            onTimeSeriesCursorRangeChange,
          )}
        </div>
        <div class="session-detail-bottom">
          ${renderSessionLogsCompact(
            sessionLogs,
            sessionLogsLoading,
            sessionLogsStatus,
            onRetrySessionLogs,
            sessionLogsExpanded,
            onToggleSessionLogsExpanded,
            logFilters,
            onLogFilterRolesChange,
            onLogFilterToolsChange,
            onLogFilterHasToolsChange,
            onLogFilterQueryChange,
            onLogFilterClear,
            hasRange ? timeSeriesCursorStart : null,
            hasRange ? timeSeriesCursorEnd : null,
          )}
          ${renderContextPanel(
            session.contextWeight,
            usage,
            contextExpanded,
            onToggleContextExpanded,
          )}
        </div>
      </div>
    </div>
  `;
}

function renderTimeSeriesCompact(
  timeSeries: { points: TimeSeriesPoint[] } | null,
  loading: boolean,
  status: PanelRefreshStatus,
  onRetry: () => void,
  mode: "cumulative" | "per-turn",
  onModeChange: (mode: "cumulative" | "per-turn") => void,
  breakdownMode: "total" | "by-type",
  onBreakdownChange: (mode: "total" | "by-type") => void,
  startDate?: string,
  endDate?: string,
  selectedDays?: string[],
  timeZone: "local" | "utc" = "local",
  cursorStart?: number | null,
  cursorEnd?: number | null,
  onCursorRangeChange?: (start: number | null, end: number | null) => void,
) {
  if (loading && !status.hasLoaded) {
    return html`
      <div class="session-timeseries-compact">
        <div class="usage-empty-block">${t("usage.loading.badge")}</div>
      </div>
    `;
  }
  const refreshStatus = renderUsageRefreshStatus(
    status,
    onRetry,
    "usage.details.usageOverTime",
    "timeline",
  );
  if (status.error && !status.hasLoaded) {
    return html`
      <div class="session-timeseries-compact">
        <div class="card-title usage-section-title">${t("usage.details.usageOverTime")}</div>
        ${refreshStatus}
      </div>
    `;
  }
  if (!timeSeries || timeSeries.points.length < 2) {
    return html`
      <div class="session-timeseries-compact">
        ${refreshStatus}
        <div class="usage-empty-block">${t("usage.details.noTimeline")}</div>
      </div>
    `;
  }

  // Filter and recalculate (same logic as main function)
  let points = timeSeries.points;
  if (startDate || endDate || (selectedDays && selectedDays.length > 0)) {
    const startTs = startDate ? dateBoundaryMs(startDate, timeZone, 0) : 0;
    const endTs = endDate ? dateBoundaryMs(endDate, timeZone, 1) : Infinity;
    const selectedDaySet = selectedDays?.length ? new Set(selectedDays) : undefined;
    points = timeSeries.points.filter((p) => {
      if (p.timestamp < startTs || p.timestamp >= endTs) {
        return false;
      }
      if (selectedDaySet) {
        return selectedDaySet.has(usageDateKey(p.timestamp, timeZone));
      }
      return true;
    });
  }
  if (points.length < 2) {
    return html`
      <div class="session-timeseries-compact">
        ${refreshStatus}
        <div class="usage-empty-block">${t("usage.details.noDataInRange")}</div>
      </div>
    `;
  }
  let cumTokens = 0,
    cumCost = 0;
  points = points.map((p) => {
    cumTokens += p.totalTokens;
    cumCost += p.cost;
    return { ...p, cumulativeTokens: cumTokens, cumulativeCost: cumCost };
  });

  // Compute range-filtered sums for "Tokens by Type"
  const hasSelection = cursorStart != null && cursorEnd != null;
  const rangeStartTs = hasSelection ? Math.min(cursorStart, cursorEnd) : 0;
  const rangeEndTs = hasSelection ? Math.max(cursorStart, cursorEnd) : Infinity;

  // Find start/end indices for dimming
  let rangeStartIdx = 0;
  let rangeEndIdx = points.length;
  if (hasSelection) {
    rangeStartIdx = points.findIndex((p) => p.timestamp >= rangeStartTs);
    if (rangeStartIdx === -1) {
      rangeStartIdx = points.length;
    }
    const endIdx = points.findIndex((p) => p.timestamp > rangeEndTs);
    rangeEndIdx = endIdx === -1 ? points.length : endIdx;
  }

  const filteredPoints = hasSelection ? points.slice(rangeStartIdx, rangeEndIdx) : points;
  const filteredTokens = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
  for (const p of filteredPoints) {
    for (const { key } of USAGE_TOKEN_CATEGORIES) {
      filteredTokens[key] += p[key];
    }
  }

  const width = 400,
    height = 100;
  const padding = { top: 8, right: 4, bottom: 14, left: 30 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const isCumulative = mode === "cumulative";
  const breakdownByType = mode === "per-turn" && breakdownMode === "by-type";
  const timeZoneOptions: Intl.DateTimeFormatOptions = timeZone === "utc" ? { timeZone: "UTC" } : {};

  const totalTypeTokens = Object.values(filteredTokens).reduce(
    (total, tokens) => total + tokens,
    0,
  );
  const barTotals = points.map((p) =>
    isCumulative
      ? p.cumulativeTokens
      : breakdownByType
        ? p.input + p.output + p.cacheRead + p.cacheWrite
        : p.totalTokens,
  );
  const maxValue = Math.max(...barTotals, 1);
  // Ensure bars + gaps fit exactly within chartWidth
  const slotWidth = chartWidth / points.length; // space per bar including gap
  const barWidth = Math.min(CHART_MAX_BAR_WIDTH, Math.max(1, slotWidth * CHART_BAR_WIDTH_RATIO));
  const barGap = slotWidth - barWidth;

  // Pre-compute handle X positions in SVG viewBox coordinates
  const leftHandleX = padding.left + rangeStartIdx * (barWidth + barGap);
  const rightHandleX =
    rangeEndIdx >= points.length
      ? padding.left + (points.length - 1) * (barWidth + barGap) + barWidth // right edge of last bar
      : padding.left + (rangeEndIdx - 1) * (barWidth + barGap) + barWidth; // right edge of last selected bar

  return html`
    <div class="session-timeseries-compact">
      <div class="timeseries-header-row">
        <div class="card-title usage-section-title">${t("usage.details.usageOverTime")}</div>
        <div class="timeseries-controls">
          ${hasSelection
            ? html`
                <div class="chart-toggle small">
                  <button
                    class="btn btn--sm toggle-btn active"
                    @click=${() => onCursorRangeChange?.(null, null)}
                  >
                    ${t("usage.details.reset")}
                  </button>
                </div>
              `
            : nothing}
          ${renderUsageToggle(mode, onModeChange, [
            { value: "per-turn", labelKey: "usage.details.perTurn" },
            { value: "cumulative", labelKey: "usage.details.cumulative" },
          ])}
          ${!isCumulative
            ? renderUsageToggle(breakdownMode, onBreakdownChange, [
                { value: "total", labelKey: "usage.daily.total" },
                { value: "by-type", labelKey: "usage.daily.byType" },
              ])
            : nothing}
        </div>
      </div>
      ${refreshStatus}
      <div class="timeseries-chart-wrapper">
        <svg viewBox="0 0 ${width} ${height + 18}" class="timeseries-svg">
          ${[
            { x1: padding.left, y1: padding.top, x2: padding.left, y2: padding.top + chartHeight },
            {
              x1: padding.left,
              y1: padding.top + chartHeight,
              x2: width - padding.right,
              y2: padding.top + chartHeight,
            },
          ].map(
            ({ x1, y1, x2, y2 }) =>
              svg`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--border)" />`,
          )}
          ${[
            { y: padding.top + 5, text: formatUsageTokens(maxValue) },
            { y: padding.top + chartHeight, text: "0" },
          ].map(
            ({ y, text }) =>
              svg`<text x="${padding.left - 4}" y="${y}" text-anchor="end" class="ts-axis-label">${text}</text>`,
          )}
          <!-- X axis labels (first and last) -->
          ${points.length > 0
            ? svg`
            <text x="${padding.left}" y="${padding.top + chartHeight + 10}" text-anchor="start" class="ts-axis-label">${formatTimeMs(expectDefined(points[0], "time series first point").timestamp, { hour: "2-digit", minute: "2-digit", ...timeZoneOptions }, "")}</text>
            <text x="${width - padding.right}" y="${padding.top + chartHeight + 10}" text-anchor="end" class="ts-axis-label">${formatTimeMs(expectDefined(points.at(-1), "time series last point").timestamp, { hour: "2-digit", minute: "2-digit", ...timeZoneOptions }, "")}</text>
          `
            : nothing}
          <!-- Bars -->
          ${points.map((p, i) => {
            const val = expectDefined(barTotals[i], "time series bar total");
            const x = padding.left + i * (barWidth + barGap);
            const bh = (val / maxValue) * chartHeight;
            const y = padding.top + chartHeight - bh;
            const tooltipLines = [
              formatDateTimeMs(
                p.timestamp,
                {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  ...timeZoneOptions,
                },
                "",
              ),
              `${formatUsageTokens(val)} ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}`,
            ];
            if (breakdownByType) {
              tooltipLines.push(
                ...USAGE_TOKEN_CATEGORIES.map(
                  ({ key, short }) => `${short} ${formatUsageTokens(p[key])}`,
                ),
              );
            }
            const tooltip = tooltipLines.join(" · ");
            const isOutside = hasSelection && (i < rangeStartIdx || i >= rangeEndIdx);

            if (!breakdownByType) {
              return svg`<rect x="${x}" y="${y}" width="${barWidth}" height="${bh}" class="ts-bar${isOutside ? " dimmed" : ""}" rx="1" data-tooltip=${tooltip} aria-label=${tooltip}></rect>`;
            }
            let yC = padding.top + chartHeight;
            const dim = isOutside ? " dimmed" : "";
            return svg`
              ${USAGE_TOKEN_CATEGORIES.map(({ key, className }) => {
                const value = p[key];
                if (value <= 0 || val <= 0) {
                  return nothing;
                }
                const sh = bh * (value / val);
                yC -= sh;
                return svg`<rect x="${x}" y="${yC}" width="${barWidth}" height="${sh}" class="ts-bar ${className}${dim}" rx="1" data-tooltip=${tooltip} aria-label=${tooltip}></rect>`;
              })}
            `;
          })}
          <!-- Selection highlight overlay (always visible between handles) -->
          ${svg`
            <rect 
              x="${leftHandleX}" 
              y="${padding.top}" 
              width="${Math.max(1, rightHandleX - leftHandleX)}" 
              height="${chartHeight}" 
              fill="var(--accent)" 
              opacity="${CHART_SELECTION_OPACITY}" 
              pointer-events="none"
            />
          `}
          ${[leftHandleX, rightHandleX].map(
            (handleX) => svg`
              <line x1="${handleX}" y1="${padding.top}" x2="${handleX}" y2="${padding.top + chartHeight}" stroke="var(--accent)" stroke-width="0.8" opacity="0.7" />
              <rect x="${handleX - HANDLE_WIDTH / 2}" y="${padding.top + chartHeight / 2 - HANDLE_HEIGHT / 2}" width="${HANDLE_WIDTH}" height="${HANDLE_HEIGHT}" rx="1.5" fill="var(--accent)" class="cursor-handle" />
              ${[-HANDLE_GRIP_OFFSET, HANDLE_GRIP_OFFSET].map(
                (offset) =>
                  svg`<line x1="${handleX + offset}" y1="${padding.top + chartHeight / 2 - HANDLE_HEIGHT / 5}" x2="${handleX + offset}" y2="${padding.top + chartHeight / 2 + HANDLE_HEIGHT / 5}" stroke="var(--bg)" stroke-width="0.4" pointer-events="none" />`,
              )}
            `,
          )}
        </svg>
        <!-- Handle drag zones (only on handles, not full chart) -->
        ${(() => {
          const makeDragHandler = (side: "left" | "right") => (e: MouseEvent) => {
            if (!onCursorRangeChange) {
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            // Find the wrapper, then the SVG inside it
            const wrapper = (e.currentTarget as HTMLElement).closest(".timeseries-chart-wrapper");
            const svgEl = wrapper?.querySelector("svg") as SVGSVGElement;
            if (!svgEl) {
              return;
            }
            // Capture rect once at mousedown to avoid re-render offset shifts
            const rect = svgEl.getBoundingClientRect();
            const svgWidth = rect.width;
            const chartLeftPx = (padding.left / width) * svgWidth;
            const chartRightPx = ((width - padding.right) / width) * svgWidth;
            const chartW = chartRightPx - chartLeftPx;

            const posToIdx = (clientX: number) => {
              const x = Math.max(0, Math.min(1, (clientX - rect.left - chartLeftPx) / chartW));
              return Math.min(Math.floor(x * points.length), points.length - 1);
            };

            // Compute click offset: where on the handle the user grabbed
            const handleSvgX = side === "left" ? leftHandleX : rightHandleX;
            const handleClientX = rect.left + (handleSvgX / width) * svgWidth;
            const grabOffset = e.clientX - handleClientX;

            document.body.style.cursor = "col-resize";

            const handleMove = (me: MouseEvent) => {
              const adjustedX = me.clientX - grabOffset;
              const idx = posToIdx(adjustedX);
              const pt = points[idx];
              if (!pt) {
                return;
              }
              const left = side === "left";
              const boundary = left
                ? (cursorEnd ??
                  expectDefined(points.at(-1), "time series right cursor point").timestamp)
                : (cursorStart ??
                  expectDefined(points[0], "time series left cursor point").timestamp);
              // Clamp the dragged handle against its fixed sibling to preserve range ordering.
              onCursorRangeChange(
                left ? Math.min(pt.timestamp, boundary) : boundary,
                left ? boundary : Math.max(pt.timestamp, boundary),
              );
            };

            const handleUp = () => {
              document.body.style.cursor = "";
              document.removeEventListener("mousemove", handleMove);
              document.removeEventListener("mouseup", handleUp);
            };

            document.addEventListener("mousemove", handleMove);
            document.addEventListener("mouseup", handleUp);
          };

          return html`
            ${(["left", "right"] as const).map((side) => {
              const x = side === "left" ? leftHandleX : rightHandleX;
              return html`<div
                class="chart-handle-zone chart-handle-${side}"
                style="left: ${((x / width) * 100).toFixed(1)}%;"
                @mousedown=${makeDragHandler(side)}
              ></div>`;
            })}
          `;
        })()}
      </div>
      <div class="timeseries-summary">
        ${hasSelection
          ? html`
              <span class="timeseries-summary__range">
                ${t("usage.details.turnRange", {
                  start: String(rangeStartIdx + 1),
                  end: String(rangeEndIdx),
                  total: String(points.length),
                })}
              </span>
              ·
              ${formatTimeMs(
                rangeStartTs,
                { hour: "2-digit", minute: "2-digit", ...timeZoneOptions },
                "",
              )}–${formatTimeMs(
                rangeEndTs,
                { hour: "2-digit", minute: "2-digit", ...timeZoneOptions },
                "",
              )}
              · ${formatUsageTokens(totalTypeTokens)} ·
              ${formatUsageCost(filteredPoints.reduce((s, p) => s + (p.cost || 0), 0))}
            `
          : html`${points.length} ${t("usage.overview.messagesAbbrev")} ·
            ${formatUsageTokens(cumTokens)} · ${formatUsageCost(cumCost)}`}
      </div>
      ${breakdownByType
        ? html`
            <div class="timeseries-breakdown">
              <div class="card-title usage-section-title">${t("usage.breakdown.tokensByType")}</div>
              <div class="cost-breakdown-bar cost-breakdown-bar--compact">
                ${USAGE_TOKEN_CATEGORIES.map(
                  ({ key, className }) => html`
                    <div
                      class="cost-segment ${className}"
                      style="width: ${pct(filteredTokens[key], totalTypeTokens).toFixed(1)}%"
                    ></div>
                  `,
                )}
              </div>
              <div class="cost-breakdown-legend">
                ${USAGE_TOKEN_CATEGORIES.map(
                  ({ key, className, labelKey, hintKey }) => html`
                    <div class="legend-item" title=${t(hintKey)}>
                      <span class="legend-dot ${className}"></span>${t(labelKey)}
                      ${formatUsageTokens(filteredTokens[key])}
                    </div>
                  `,
                )}
              </div>
              <div class="cost-breakdown-total">
                ${t("usage.breakdown.total")}: ${formatUsageTokens(totalTypeTokens)}
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderContextPanel(
  contextWeight: UsageSessionEntry["contextWeight"],
  usage: UsageSessionEntry["usage"],
  expanded: boolean,
  onToggleExpanded: () => void,
) {
  if (!contextWeight) {
    return html`
      <div class="context-details-panel">
        <div class="usage-empty-block">${t("usage.details.noContextData")}</div>
      </div>
    `;
  }
  const groups = [
    {
      className: "skills",
      labelKey: "usage.details.skills",
      tokens: charsToTokens(contextWeight.skills.promptChars),
      entries: contextWeight.skills.entries.map(({ name, blockChars }) => ({
        name,
        chars: blockChars,
      })),
    },
    {
      className: "tools",
      labelKey: "usage.details.tools",
      tokens: charsToTokens(contextWeight.tools.listChars + contextWeight.tools.schemaChars),
      entries: contextWeight.tools.entries.map(({ name, summaryChars, schemaChars }) => ({
        name,
        chars: summaryChars + schemaChars,
      })),
    },
    {
      className: "files",
      labelKey: "usage.details.files",
      tokens: charsToTokens(
        contextWeight.injectedWorkspaceFiles.reduce(
          (sum, file) =>
            file.injectionStatus === "native_unverified" ? sum : sum + file.injectedChars,
          0,
        ),
      ),
      entries: contextWeight.injectedWorkspaceFiles.map(({ name, injectedChars }) => ({
        name,
        chars: injectedChars,
      })),
    },
  ].map(({ className, labelKey, tokens, entries }) => ({
    className,
    labelKey,
    tokens,
    entries: entries.toSorted((left, right) => {
      if (left.chars === null) {
        return right.chars === null ? 0 : 1;
      }
      return right.chars === null ? -1 : right.chars - left.chars;
    }),
  }));
  const categories = [
    {
      className: "system",
      labelKey: "usage.details.system",
      tokens: charsToTokens(contextWeight.systemPrompt.chars),
    },
    ...groups,
  ];
  const totalContextTokens = categories.reduce((sum, { tokens }) => sum + tokens, 0);
  const inputTokens = usage && usage.totalTokens > 0 ? usage.input + usage.cacheRead : 0;
  const contextDescription =
    inputTokens > 0
      ? `~${Math.min((totalContextTokens / inputTokens) * 100, 100).toFixed(0)}% ${t("usage.details.ofInput")}`
      : t("usage.details.baseContextPerMessage");
  const defaultLimit = 4;
  const hasMore = groups.some(({ entries }) => entries.length > defaultLimit);

  return html`
    <div class="context-details-panel">
      <div class="context-breakdown-header">
        <div class="card-title usage-section-title">
          ${t("usage.details.systemPromptBreakdown")}
        </div>
        ${hasMore
          ? html`<button class="btn btn--sm" @click=${onToggleExpanded}>
              ${expanded ? t("usage.details.collapse") : t("usage.details.expandAll")}
            </button>`
          : nothing}
      </div>
      <p class="context-weight-desc">${contextDescription}</p>
      <div class="context-stacked-bar">
        ${categories.map(
          ({ className, labelKey, tokens }) => html`
            <div
              class="context-segment ${className}"
              style="width: ${pct(tokens, totalContextTokens).toFixed(1)}%"
              title="${t(labelKey)}: ~${formatUsageTokens(tokens)}"
            ></div>
          `,
        )}
      </div>
      <div class="context-legend">
        ${categories.map(
          ({ className, labelKey, tokens }) => html`
            <span class="legend-item"
              ><span class="legend-dot ${className}"></span>${t(
                className === "system" ? "usage.details.systemShort" : labelKey,
              )}
              ~${formatUsageTokens(tokens)}</span
            >
          `,
        )}
      </div>
      <div class="context-total">
        ${t("usage.breakdown.total")}: ~${formatUsageTokens(totalContextTokens)}
      </div>
      <div class="context-breakdown-grid">
        ${groups
          .filter(({ entries }) => entries.length > 0)
          .map(({ labelKey, entries }) => {
            const visible = expanded ? entries : entries.slice(0, defaultLimit);
            const more = entries.length - visible.length;
            return html`
              <div class="context-breakdown-card">
                <div class="context-breakdown-title">${t(labelKey)} (${entries.length})</div>
                <div class="context-breakdown-list">
                  ${visible.map(
                    ({ name, chars }) => html`
                      <div class="context-breakdown-item">
                        <span class="mono" title=${name}>${name}</span>
                        <span class="muted"
                          >${chars === null
                            ? t("usage.common.unknown")
                            : `~${formatUsageTokens(charsToTokens(chars))}`}</span
                        >
                      </div>
                    `,
                  )}
                </div>
                ${more > 0
                  ? html`
                      <div class="context-breakdown-more">
                        ${t("usage.sessions.more", { count: String(more) })}
                      </div>
                    `
                  : nothing}
              </div>
            `;
          })}
      </div>
    </div>
  `;
}

function renderSessionLogsCompact(
  logs: SessionLogEntry[] | null,
  loading: boolean,
  status: PanelRefreshStatus,
  onRetry: () => void,
  expandedAll: boolean,
  onToggleExpandedAll: () => void,
  filters: {
    roles: SessionLogRole[];
    tools: string[];
    hasTools: boolean;
    query: string;
  },
  onFilterRolesChange: (next: SessionLogRole[]) => void,
  onFilterToolsChange: (next: string[]) => void,
  onFilterHasToolsChange: (next: boolean) => void,
  onFilterQueryChange: (next: string) => void,
  onFilterClear: () => void,
  cursorStart?: number | null,
  cursorEnd?: number | null,
) {
  if (loading && !status.hasLoaded) {
    return html`
      <div class="session-logs-compact">
        <div class="session-logs-header">${t("usage.details.conversation")}</div>
        <div class="usage-empty-block">${t("usage.loading.badge")}</div>
      </div>
    `;
  }
  const refreshStatus = renderUsageRefreshStatus(
    status,
    onRetry,
    "usage.details.conversation",
    "conversation",
  );
  if (status.error && !status.hasLoaded) {
    return html`
      <div class="session-logs-compact">
        <div class="session-logs-header">${t("usage.details.conversation")}</div>
        ${refreshStatus}
      </div>
    `;
  }
  if (!logs || logs.length === 0) {
    return html`
      <div class="session-logs-compact">
        <div class="session-logs-header">${t("usage.details.conversation")}</div>
        ${refreshStatus}
        <div class="usage-empty-block">${t("usage.details.noMessages")}</div>
      </div>
    `;
  }

  const normalizedQuery = normalizeLowercaseStringOrEmpty(filters.query);
  const entries = logs.map((log) => {
    const toolInfo = parseToolSummary(log.content);
    const cleanContent = toolInfo.cleanContent || log.content;
    return { log, toolInfo, cleanContent };
  });
  const toolOptions = Array.from(
    new Set(entries.flatMap((entry) => entry.toolInfo.tools.map(([name]) => name))),
  ).toSorted((a, b) => a.localeCompare(b));
  const hasCursorFilter = cursorStart != null && cursorEnd != null;
  const cursorMin = hasCursorFilter ? Math.min(cursorStart, cursorEnd) : 0;
  const cursorMax = hasCursorFilter ? Math.max(cursorStart, cursorEnd) : Infinity;
  const filteredEntries = entries.filter((entry) => {
    // Filter by cursor timeline range (only if logs cover the range)
    if (hasCursorFilter && entry.log.timestamp > 0) {
      const timestamp = normalizeLogTimestamp(entry.log.timestamp);
      if (timestamp < cursorMin || timestamp > cursorMax) {
        return false;
      }
    }
    return (
      (filters.roles.length === 0 || filters.roles.includes(entry.log.role)) &&
      (!filters.hasTools || entry.toolInfo.tools.length > 0) &&
      (filters.tools.length === 0 ||
        entry.toolInfo.tools.some(([name]) => filters.tools.includes(name))) &&
      (!normalizedQuery ||
        normalizeLowercaseStringOrEmpty(entry.cleanContent).includes(normalizedQuery))
    );
  });
  const hasActiveFilters =
    filters.roles.length > 0 || filters.tools.length > 0 || filters.hasTools || normalizedQuery;
  const displayedCount =
    hasActiveFilters || hasCursorFilter
      ? `${filteredEntries.length} ${t("usage.details.of")} ${logs.length}${hasCursorFilter ? ` (${t("usage.details.timelineFiltered")})` : ""}`
      : `${logs.length}`;

  const roleSelected = new Set(filters.roles);
  const toolSelected = new Set(filters.tools);

  return html`
    <div class="session-logs-compact">
      <div class="session-logs-header">
        <span>
          ${t("usage.details.conversation")}
          <span class="session-logs-header-count">
            (${displayedCount} ${normalizeLowercaseStringOrEmpty(t("usage.overview.messages"))})
          </span>
        </span>
        <button class="btn btn--sm" @click=${onToggleExpandedAll}>
          ${expandedAll ? t("usage.details.collapseAll") : t("usage.details.expandAll")}
        </button>
      </div>
      ${refreshStatus}
      <div class="usage-filters-inline session-log-filters">
        <select
          multiple
          size="4"
          aria-label=${t("usage.details.filterByRole")}
          @change=${(event: Event) =>
            onFilterRolesChange(
              Array.from((event.target as HTMLSelectElement).selectedOptions).map(
                (option) => option.value as SessionLogRole,
              ),
            )}
        >
          ${(
            [
              ["user", "usage.overview.user"],
              ["assistant", "usage.overview.assistant"],
              ["tool", "usage.details.tool"],
              ["toolResult", "usage.details.toolResult"],
            ] as const
          ).map(
            ([role, labelKey]) =>
              html`<option value=${role} ?selected=${roleSelected.has(role)}>
                ${t(labelKey)}
              </option>`,
          )}
        </select>
        <select
          multiple
          size="4"
          aria-label=${t("usage.details.filterByTool")}
          @change=${(event: Event) =>
            onFilterToolsChange(
              Array.from((event.target as HTMLSelectElement).selectedOptions).map(
                (option) => option.value,
              ),
            )}
        >
          ${toolOptions.map(
            (tool) =>
              html`<option value=${tool} ?selected=${toolSelected.has(tool)}>${tool}</option>`,
          )}
        </select>
        <label class="usage-filters-inline session-log-has-tools">
          <input
            type="checkbox"
            .checked=${filters.hasTools}
            @change=${(event: Event) =>
              onFilterHasToolsChange((event.target as HTMLInputElement).checked)}
          />
          ${t("usage.details.hasTools")}
        </label>
        <input
          type="text"
          placeholder=${t("usage.details.searchConversation")}
          aria-label=${t("usage.details.searchConversation")}
          .value=${filters.query}
          @input=${(event: Event) => onFilterQueryChange((event.target as HTMLInputElement).value)}
        />
        <button class="btn btn--sm" @click=${onFilterClear}>${t("usage.filters.clear")}</button>
      </div>
      <div class="session-logs-list">
        ${filteredEntries.map((entry) => {
          const { log, toolInfo, cleanContent } = entry;
          const roleClass = log.role === "user" ? "user" : "assistant";
          const roleLabel =
            log.role === "user"
              ? t("usage.details.you")
              : log.role === "assistant"
                ? t("usage.overview.assistant")
                : t("usage.details.tool");
          return html`
            <div class="session-log-entry ${roleClass}">
              <div class="session-log-meta">
                <span class="session-log-role">${roleLabel}</span>
                <span>${formatMs(log.timestamp)}</span>
                ${log.tokens ? html`<span>${formatUsageTokens(log.tokens)}</span>` : nothing}
              </div>
              <div class="session-log-content">${cleanContent}</div>
              ${toolInfo.tools.length > 0
                ? html`
                    <details class="session-log-tools" ?open=${expandedAll}>
                      <summary>${toolInfo.summary}</summary>
                      <div class="session-log-tools-list">
                        ${toolInfo.tools.map(
                          ([name, count]) => html`
                            <span class="session-log-tools-pill">${name} × ${count}</span>
                          `,
                        )}
                      </div>
                    </details>
                  `
                : nothing}
            </div>
          `;
        })}
        ${filteredEntries.length === 0
          ? html`
              <div class="usage-empty-block usage-empty-block--compact">
                ${t("usage.details.noMessagesMatch")}
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}

export { renderSessionDetailPanel };
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
