import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Control UI view renders usage render details screen content.
import { html, svg, nothing } from "lit";
import { formatDurationCompact } from "../../../../src/infra/format-time/format-duration.ts";
import {
  renderPanelRefreshStatus,
  type PanelRefreshStatus,
} from "../../components/panel-refresh-status.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import { formatDateTimeMs, formatMs, formatTimeMs } from "../../lib/format.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import { parseToolSummary } from "./helpers.ts";
import { charsToTokens, formatCost, formatTokens } from "./metrics.ts";
import type {
  SessionLogEntry,
  SessionLogRole,
  TimeSeriesPoint,
  UsageSessionEntry,
} from "./types.ts";
import { renderInsightList } from "./view-overview.ts";

// Chart constants
const CHART_BAR_WIDTH_RATIO = 0.75; // Fraction of slot used for bar (rest is gap)
const CHART_MAX_BAR_WIDTH = 8; // Max bar width in SVG viewBox units
const CHART_SELECTION_OPACITY = 0.06; // Opacity of range selection overlay
const HANDLE_WIDTH = 5; // Width of drag handle in SVG units
const HANDLE_HEIGHT = 12; // Height of drag handle
const HANDLE_GRIP_OFFSET = 0.7; // Offset of grip lines inside handle

function pct(part: number, total: number): number {
  if (!total || total <= 0) {
    return 0;
  }
  return (part / total) * 100;
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

function dateKey(timestamp: number, timeZone: "local" | "utc"): string {
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

  const badges: string[] = [];
  if (session.channel) {
    badges.push(`channel:${session.channel}`);
  }
  if (session.agentId) {
    badges.push(`agent:${session.agentId}`);
  }
  if (session.modelProvider || session.providerOverride) {
    badges.push(`provider:${session.modelProvider ?? session.providerOverride}`);
  }
  if (session.model) {
    badges.push(`model:${session.model}`);
  }

  // Always use the full tool list for stable layout; update counts when filtering
  const baseTools = usage.toolUsage?.tools.slice(0, 6) ?? [];
  let toolCallCount: number;
  let uniqueToolCount: number;
  let toolItems: Array<{ label: string; value: string; sub: string }>;

  if (filteredLogs) {
    const toolCounts = new Map<string, number>();
    for (const log of filteredLogs) {
      const { tools } = parseToolSummary(log.content);
      for (const [name] of tools) {
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      }
    }
    // Keep the same tool order as the full session, just update counts
    toolItems = baseTools.map((tool) => ({
      label: tool.name,
      value: `${toolCounts.get(tool.name) ?? 0}`,
      sub: t("usage.overview.calls"),
    }));
    toolCallCount = [...toolCounts.values()].reduce((sum, c) => sum + c, 0);
    uniqueToolCount = toolCounts.size;
  } else {
    toolItems = baseTools.map((tool) => ({
      label: tool.name,
      value: `${tool.count}`,
      sub: t("usage.overview.calls"),
    }));
    toolCallCount = usage.toolUsage?.totalCalls ?? 0;
    uniqueToolCount = usage.toolUsage?.uniqueTools ?? 0;
  }
  const modelItems =
    usage.modelUsage?.slice(0, 6).map((entry) => ({
      label: entry.model ?? t("usage.common.unknown"),
      value: formatCost(entry.totals.totalCost),
      sub: formatTokens(entry.totals.totalTokens),
    })) ?? [];

  return html`
    ${badges.length > 0
      ? html`<div class="usage-badges">
          ${badges.map((b) => html`<span class="settings-row__value">${b}</span>`)}
        </div>`
      : nothing}
    <div class="session-summary-grid">
      <div class="stat session-summary-card">
        <div class="session-summary-title">${t("usage.overview.messages")}</div>
        <div class="stat-value session-summary-value">${usage.messageCounts?.total ?? 0}</div>
        <div class="session-summary-meta">
          ${usage.messageCounts?.user ?? 0}
          ${normalizeLowercaseStringOrEmpty(t("usage.overview.user"))} ·
          ${usage.messageCounts?.assistant ?? 0}
          ${normalizeLowercaseStringOrEmpty(t("usage.overview.assistant"))}
        </div>
      </div>
      <div class="stat session-summary-card">
        <div class="session-summary-title">${t("usage.overview.toolCalls")}</div>
        <div class="stat-value session-summary-value">${toolCallCount}</div>
        <div class="session-summary-meta">${uniqueToolCount} ${t("usage.overview.toolsUsed")}</div>
      </div>
      <div class="stat session-summary-card">
        <div class="session-summary-title">${t("usage.overview.errors")}</div>
        <div class="stat-value session-summary-value">${usage.messageCounts?.errors ?? 0}</div>
        <div class="session-summary-meta">
          ${usage.messageCounts?.toolResults ?? 0} ${t("usage.overview.toolResults")}
        </div>
      </div>
      <div class="stat session-summary-card">
        <div class="session-summary-title">${t("usage.details.duration")}</div>
        <div class="stat-value session-summary-value">
          ${formatDurationCompact(usage.durationMs, { spaced: true }) ??
          t("usage.common.emptyValue")}
        </div>
        <div class="session-summary-meta">
          ${formatTs(usage.firstActivity)} → ${formatTs(usage.lastActivity)}
        </div>
      </div>
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
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  for (const p of filtered) {
    totalTokens += p.totalTokens || 0;
    totalCost += p.cost || 0;
    totalInput += p.input || 0;
    totalOutput += p.output || 0;
    totalCacheRead += p.cacheRead || 0;
    totalCacheWrite += p.cacheWrite || 0;
    if (p.output > 0) {
      assistantMessages++;
    }
    if (p.input > 0) {
      userMessages++;
    }
  }
  const first = expectDefined(filtered[0], "filtered usage first point");
  const last = expectDefined(filtered.at(-1), "filtered usage last point");

  return {
    ...baseUsage,
    totalTokens,
    totalCost,
    input: totalInput,
    output: totalOutput,
    cacheRead: totalCacheRead,
    cacheWrite: totalCacheWrite,
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
                  ><strong>${formatTokens(headerStats.totalTokens)}</strong>
                  ${normalizeLowercaseStringOrEmpty(
                    t("usage.metrics.tokens"),
                  )}${cursorIndicator}</span
                >
                <span><strong>${formatCost(headerStats.totalCost)}</strong>${cursorIndicator}</span>
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
  const refreshStatus = renderPanelRefreshStatus({
    status,
    errorMessage: status.error
      ? t("usage.details.loadFailed", {
          detail: normalizeLowercaseStringOrEmpty(t("usage.details.usageOverTime")),
          error: status.error,
        })
      : undefined,
    onRetry,
    className: "usage-callout usage-detail-error--timeline",
  });
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
        return selectedDaySet.has(dateKey(p.timestamp, timeZone));
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
  let sumOutput = 0;
  let sumInput = 0;
  let sumCacheRead = 0;
  let sumCacheWrite = 0;
  points = points.map((p) => {
    cumTokens += p.totalTokens;
    cumCost += p.cost;
    sumOutput += p.output;
    sumInput += p.input;
    sumCacheRead += p.cacheRead;
    sumCacheWrite += p.cacheWrite;
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
  let filteredOutput = 0,
    filteredInput = 0,
    filteredCacheRead = 0,
    filteredCacheWrite = 0;
  for (const p of filteredPoints) {
    filteredOutput += p.output;
    filteredInput += p.input;
    filteredCacheRead += p.cacheRead;
    filteredCacheWrite += p.cacheWrite;
  }

  const width = 400,
    height = 100;
  const padding = { top: 8, right: 4, bottom: 14, left: 30 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const isCumulative = mode === "cumulative";
  const breakdownByType = mode === "per-turn" && breakdownMode === "by-type";
  const timeZoneOptions: Intl.DateTimeFormatOptions = timeZone === "utc" ? { timeZone: "UTC" } : {};

  const totalTypeTokens = filteredOutput + filteredInput + filteredCacheRead + filteredCacheWrite;
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
          <div class="chart-toggle small">
            <button
              class="btn btn--sm toggle-btn ${!isCumulative ? "active" : ""}"
              @click=${() => onModeChange("per-turn")}
            >
              ${t("usage.details.perTurn")}
            </button>
            <button
              class="btn btn--sm toggle-btn ${isCumulative ? "active" : ""}"
              @click=${() => onModeChange("cumulative")}
            >
              ${t("usage.details.cumulative")}
            </button>
          </div>
          ${!isCumulative
            ? html`
                <div class="chart-toggle small">
                  <button
                    class="btn btn--sm toggle-btn ${breakdownMode === "total" ? "active" : ""}"
                    @click=${() => onBreakdownChange("total")}
                  >
                    ${t("usage.daily.total")}
                  </button>
                  <button
                    class="btn btn--sm toggle-btn ${breakdownMode === "by-type" ? "active" : ""}"
                    @click=${() => onBreakdownChange("by-type")}
                  >
                    ${t("usage.daily.byType")}
                  </button>
                </div>
              `
            : nothing}
        </div>
      </div>
      ${refreshStatus}
      <div class="timeseries-chart-wrapper">
        <svg viewBox="0 0 ${width} ${height + 18}" class="timeseries-svg">
          <!-- Y axis -->
          <line
            x1="${padding.left}"
            y1="${padding.top}"
            x2="${padding.left}"
            y2="${padding.top + chartHeight}"
            stroke="var(--border)"
          />
          <!-- X axis -->
          <line
            x1="${padding.left}"
            y1="${padding.top + chartHeight}"
            x2="${width - padding.right}"
            y2="${padding.top + chartHeight}"
            stroke="var(--border)"
          />
          <!-- Y axis labels -->
          <text
            x="${padding.left - 4}"
            y="${padding.top + 5}"
            text-anchor="end"
            class="ts-axis-label"
          >
            ${formatTokens(maxValue)}
          </text>
          <text
            x="${padding.left - 4}"
            y="${padding.top + chartHeight}"
            text-anchor="end"
            class="ts-axis-label"
          >
            0
          </text>
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
              `${formatTokens(val)} ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}`,
            ];
            if (breakdownByType) {
              tooltipLines.push(`Out ${formatTokens(p.output)}`);
              tooltipLines.push(`In ${formatTokens(p.input)}`);
              tooltipLines.push(`CW ${formatTokens(p.cacheWrite)}`);
              tooltipLines.push(`CR ${formatTokens(p.cacheRead)}`);
            }
            const tooltip = tooltipLines.join(" · ");
            const isOutside = hasSelection && (i < rangeStartIdx || i >= rangeEndIdx);

            if (!breakdownByType) {
              return svg`<rect x="${x}" y="${y}" width="${barWidth}" height="${bh}" class="ts-bar${isOutside ? " dimmed" : ""}" rx="1"><title>${tooltip}</title></rect>`;
            }
            const segments = [
              { value: p.output, cls: "output" },
              { value: p.input, cls: "input" },
              { value: p.cacheWrite, cls: "cache-write" },
              { value: p.cacheRead, cls: "cache-read" },
            ];
            let yC = padding.top + chartHeight;
            const dim = isOutside ? " dimmed" : "";
            return svg`
              ${segments.map((seg) => {
                if (seg.value <= 0 || val <= 0) {
                  return nothing;
                }
                const sh = bh * (seg.value / val);
                yC -= sh;
                return svg`<rect x="${x}" y="${yC}" width="${barWidth}" height="${sh}" class="ts-bar ${seg.cls}${dim}" rx="1"><title>${tooltip}</title></rect>`;
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
          <!-- Left cursor line + handle -->
          ${svg`
            <line x1="${leftHandleX}" y1="${padding.top}" x2="${leftHandleX}" y2="${padding.top + chartHeight}" stroke="var(--accent)" stroke-width="0.8" opacity="0.7" />
            <rect x="${leftHandleX - HANDLE_WIDTH / 2}" y="${padding.top + chartHeight / 2 - HANDLE_HEIGHT / 2}" width="${HANDLE_WIDTH}" height="${HANDLE_HEIGHT}" rx="1.5" fill="var(--accent)" class="cursor-handle" />
            <line x1="${leftHandleX - HANDLE_GRIP_OFFSET}" y1="${padding.top + chartHeight / 2 - HANDLE_HEIGHT / 5}" x2="${leftHandleX - HANDLE_GRIP_OFFSET}" y2="${padding.top + chartHeight / 2 + HANDLE_HEIGHT / 5}" stroke="var(--bg)" stroke-width="0.4" pointer-events="none" />
            <line x1="${leftHandleX + HANDLE_GRIP_OFFSET}" y1="${padding.top + chartHeight / 2 - HANDLE_HEIGHT / 5}" x2="${leftHandleX + HANDLE_GRIP_OFFSET}" y2="${padding.top + chartHeight / 2 + HANDLE_HEIGHT / 5}" stroke="var(--bg)" stroke-width="0.4" pointer-events="none" />
          `}
          <!-- Right cursor line + handle -->
          ${svg`
            <line x1="${rightHandleX}" y1="${padding.top}" x2="${rightHandleX}" y2="${padding.top + chartHeight}" stroke="var(--accent)" stroke-width="0.8" opacity="0.7" />
            <rect x="${rightHandleX - HANDLE_WIDTH / 2}" y="${padding.top + chartHeight / 2 - HANDLE_HEIGHT / 2}" width="${HANDLE_WIDTH}" height="${HANDLE_HEIGHT}" rx="1.5" fill="var(--accent)" class="cursor-handle" />
            <line x1="${rightHandleX - HANDLE_GRIP_OFFSET}" y1="${padding.top + chartHeight / 2 - HANDLE_HEIGHT / 5}" x2="${rightHandleX - HANDLE_GRIP_OFFSET}" y2="${padding.top + chartHeight / 2 + HANDLE_HEIGHT / 5}" stroke="var(--bg)" stroke-width="0.4" pointer-events="none" />
            <line x1="${rightHandleX + HANDLE_GRIP_OFFSET}" y1="${padding.top + chartHeight / 2 - HANDLE_HEIGHT / 5}" x2="${rightHandleX + HANDLE_GRIP_OFFSET}" y2="${padding.top + chartHeight / 2 + HANDLE_HEIGHT / 5}" stroke="var(--bg)" stroke-width="0.4" pointer-events="none" />
          `}
        </svg>
        <!-- Handle drag zones (only on handles, not full chart) -->
        ${(() => {
          const leftHandlePos = `${((leftHandleX / width) * 100).toFixed(1)}%`;
          const rightHandlePos = `${((rightHandleX / width) * 100).toFixed(1)}%`;

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
              if (side === "left") {
                const endTs =
                  cursorEnd ??
                  expectDefined(points.at(-1), "time series right cursor point").timestamp;
                // Don't let left go past right
                onCursorRangeChange(Math.min(pt.timestamp, endTs), endTs);
              } else {
                const startTs =
                  cursorStart ??
                  expectDefined(points[0], "time series left cursor point").timestamp;
                // Don't let right go past left
                onCursorRangeChange(startTs, Math.max(pt.timestamp, startTs));
              }
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
            <div
              class="chart-handle-zone chart-handle-left"
              style="left: ${leftHandlePos};"
              @mousedown=${makeDragHandler("left")}
            ></div>
            <div
              class="chart-handle-zone chart-handle-right"
              style="left: ${rightHandlePos};"
              @mousedown=${makeDragHandler("right")}
            ></div>
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
              ·
              ${formatTokens(
                filteredOutput + filteredInput + filteredCacheRead + filteredCacheWrite,
              )}
              · ${formatCost(filteredPoints.reduce((s, p) => s + (p.cost || 0), 0))}
            `
          : html`${points.length} ${t("usage.overview.messagesAbbrev")} · ${formatTokens(cumTokens)}
            · ${formatCost(cumCost)}`}
      </div>
      ${breakdownByType
        ? html`
            <div class="timeseries-breakdown">
              <div class="card-title usage-section-title">${t("usage.breakdown.tokensByType")}</div>
              <div class="cost-breakdown-bar cost-breakdown-bar--compact">
                <div
                  class="cost-segment output"
                  style="width: ${pct(filteredOutput, totalTypeTokens).toFixed(1)}%"
                ></div>
                <div
                  class="cost-segment input"
                  style="width: ${pct(filteredInput, totalTypeTokens).toFixed(1)}%"
                ></div>
                <div
                  class="cost-segment cache-write"
                  style="width: ${pct(filteredCacheWrite, totalTypeTokens).toFixed(1)}%"
                ></div>
                <div
                  class="cost-segment cache-read"
                  style="width: ${pct(filteredCacheRead, totalTypeTokens).toFixed(1)}%"
                ></div>
              </div>
              <div class="cost-breakdown-legend">
                <div class="legend-item" title=${t("usage.details.assistantOutputTokens")}>
                  <span class="legend-dot output"></span>${t("usage.breakdown.output")}
                  ${formatTokens(filteredOutput)}
                </div>
                <div class="legend-item" title=${t("usage.details.userToolInputTokens")}>
                  <span class="legend-dot input"></span>${t("usage.breakdown.input")}
                  ${formatTokens(filteredInput)}
                </div>
                <div class="legend-item" title=${t("usage.details.tokensWrittenToCache")}>
                  <span class="legend-dot cache-write"></span>${t("usage.breakdown.cacheWrite")}
                  ${formatTokens(filteredCacheWrite)}
                </div>
                <div class="legend-item" title=${t("usage.details.tokensReadFromCache")}>
                  <span class="legend-dot cache-read"></span>${t("usage.breakdown.cacheRead")}
                  ${formatTokens(filteredCacheRead)}
                </div>
              </div>
              <div class="cost-breakdown-total">
                ${t("usage.breakdown.total")}: ${formatTokens(totalTypeTokens)}
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
  const systemTokens = charsToTokens(contextWeight.systemPrompt.chars);
  const skillsTokens = charsToTokens(contextWeight.skills.promptChars);
  const toolsTokens = charsToTokens(
    contextWeight.tools.listChars + contextWeight.tools.schemaChars,
  );
  const filesTokens = charsToTokens(
    contextWeight.injectedWorkspaceFiles.reduce((sum, f) => sum + f.injectedChars, 0),
  );
  const totalContextTokens = systemTokens + skillsTokens + toolsTokens + filesTokens;

  let contextPct = "";
  if (usage && usage.totalTokens > 0) {
    const inputTokens = usage.input + usage.cacheRead;
    if (inputTokens > 0) {
      contextPct = `~${Math.min((totalContextTokens / inputTokens) * 100, 100).toFixed(0)}% ${t("usage.details.ofInput")}`;
    }
  }

  const skillsList = contextWeight.skills.entries.toSorted((a, b) => b.blockChars - a.blockChars);
  const toolsList = contextWeight.tools.entries.toSorted(
    (a, b) => b.summaryChars + b.schemaChars - (a.summaryChars + a.schemaChars),
  );
  const filesList = contextWeight.injectedWorkspaceFiles.toSorted(
    (a, b) => b.injectedChars - a.injectedChars,
  );
  const defaultLimit = 4;
  const showAll = expanded;
  const skillsTop = showAll ? skillsList : skillsList.slice(0, defaultLimit);
  const toolsTop = showAll ? toolsList : toolsList.slice(0, defaultLimit);
  const filesTop = showAll ? filesList : filesList.slice(0, defaultLimit);
  const hasMore =
    skillsList.length > defaultLimit ||
    toolsList.length > defaultLimit ||
    filesList.length > defaultLimit;

  return html`
    <div class="context-details-panel">
      <div class="context-breakdown-header">
        <div class="card-title usage-section-title">
          ${t("usage.details.systemPromptBreakdown")}
        </div>
        ${hasMore
          ? html`<button class="btn btn--sm" @click=${onToggleExpanded}>
              ${showAll ? t("usage.details.collapse") : t("usage.details.expandAll")}
            </button>`
          : nothing}
      </div>
      <p class="context-weight-desc">${contextPct || t("usage.details.baseContextPerMessage")}</p>
      <div class="context-stacked-bar">
        <div
          class="context-segment system"
          style="width: ${pct(systemTokens, totalContextTokens).toFixed(1)}%"
          title="${t("usage.details.system")}: ~${formatTokens(systemTokens)}"
        ></div>
        <div
          class="context-segment skills"
          style="width: ${pct(skillsTokens, totalContextTokens).toFixed(1)}%"
          title="${t("usage.details.skills")}: ~${formatTokens(skillsTokens)}"
        ></div>
        <div
          class="context-segment tools"
          style="width: ${pct(toolsTokens, totalContextTokens).toFixed(1)}%"
          title="${t("usage.details.tools")}: ~${formatTokens(toolsTokens)}"
        ></div>
        <div
          class="context-segment files"
          style="width: ${pct(filesTokens, totalContextTokens).toFixed(1)}%"
          title="${t("usage.details.files")}: ~${formatTokens(filesTokens)}"
        ></div>
      </div>
      <div class="context-legend">
        <span class="legend-item"
          ><span class="legend-dot system"></span>${t("usage.details.systemShort")}
          ~${formatTokens(systemTokens)}</span
        >
        <span class="legend-item"
          ><span class="legend-dot skills"></span>${t("usage.details.skills")}
          ~${formatTokens(skillsTokens)}</span
        >
        <span class="legend-item"
          ><span class="legend-dot tools"></span>${t("usage.details.tools")}
          ~${formatTokens(toolsTokens)}</span
        >
        <span class="legend-item"
          ><span class="legend-dot files"></span>${t("usage.details.files")}
          ~${formatTokens(filesTokens)}</span
        >
      </div>
      <div class="context-total">
        ${t("usage.breakdown.total")}: ~${formatTokens(totalContextTokens)}
      </div>
      <div class="context-breakdown-grid">
        ${skillsList.length > 0
          ? (() => {
              const more = skillsList.length - skillsTop.length;
              return html`
                <div class="context-breakdown-card">
                  <div class="context-breakdown-title">
                    ${t("usage.details.skills")} (${skillsList.length})
                  </div>
                  <div class="context-breakdown-list">
                    ${skillsTop.map(
                      (s) => html`
                        <div class="context-breakdown-item">
                          <span class="mono" title=${s.name}>${s.name}</span>
                          <span class="muted">~${formatTokens(charsToTokens(s.blockChars))}</span>
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
            })()
          : nothing}
        ${toolsList.length > 0
          ? (() => {
              const more = toolsList.length - toolsTop.length;
              return html`
                <div class="context-breakdown-card">
                  <div class="context-breakdown-title">
                    ${t("usage.details.tools")} (${toolsList.length})
                  </div>
                  <div class="context-breakdown-list">
                    ${toolsTop.map(
                      (tLocal) => html`
                        <div class="context-breakdown-item">
                          <span class="mono" title=${tLocal.name}>${tLocal.name}</span>
                          <span class="muted"
                            >~${formatTokens(
                              charsToTokens(tLocal.summaryChars + tLocal.schemaChars),
                            )}</span
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
            })()
          : nothing}
        ${filesList.length > 0
          ? (() => {
              const more = filesList.length - filesTop.length;
              return html`
                <div class="context-breakdown-card">
                  <div class="context-breakdown-title">
                    ${t("usage.details.files")} (${filesList.length})
                  </div>
                  <div class="context-breakdown-list">
                    ${filesTop.map(
                      (f) => html`
                        <div class="context-breakdown-item">
                          <span class="mono" title=${f.name}>${f.name}</span>
                          <span class="muted"
                            >~${formatTokens(charsToTokens(f.injectedChars))}</span
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
            })()
          : nothing}
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
  const refreshStatus = renderPanelRefreshStatus({
    status,
    errorMessage: status.error
      ? t("usage.details.loadFailed", {
          detail: normalizeLowercaseStringOrEmpty(t("usage.details.conversation")),
          error: status.error,
        })
      : undefined,
    onRetry,
    className: "usage-callout usage-detail-error--conversation",
  });
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
  const filteredEntries = entries.filter((entry) => {
    // Filter by cursor timeline range (only if logs cover the range)
    if (cursorStart != null && cursorEnd != null) {
      const ts = entry.log.timestamp;
      if (ts > 0) {
        const lo = Math.min(cursorStart, cursorEnd);
        const hi = Math.max(cursorStart, cursorEnd);
        const normalizedTs = normalizeLogTimestamp(ts);
        if (normalizedTs < lo || normalizedTs > hi) {
          return false;
        }
      }
    }
    if (filters.roles.length > 0 && !filters.roles.includes(entry.log.role)) {
      return false;
    }
    if (filters.hasTools && entry.toolInfo.tools.length === 0) {
      return false;
    }
    if (filters.tools.length > 0) {
      const matchesTool = entry.toolInfo.tools.some(([name]) => filters.tools.includes(name));
      if (!matchesTool) {
        return false;
      }
    }
    if (normalizedQuery) {
      const haystack = normalizeLowercaseStringOrEmpty(entry.cleanContent);
      if (!haystack.includes(normalizedQuery)) {
        return false;
      }
    }
    return true;
  });
  const hasActiveFilters =
    filters.roles.length > 0 || filters.tools.length > 0 || filters.hasTools || normalizedQuery;
  const hasCursorFilter = cursorStart != null && cursorEnd != null;
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
          <option value="user" ?selected=${roleSelected.has("user")}>
            ${t("usage.overview.user")}
          </option>
          <option value="assistant" ?selected=${roleSelected.has("assistant")}>
            ${t("usage.overview.assistant")}
          </option>
          <option value="tool" ?selected=${roleSelected.has("tool")}>
            ${t("usage.details.tool")}
          </option>
          <option value="toolResult" ?selected=${roleSelected.has("toolResult")}>
            ${t("usage.details.toolResult")}
          </option>
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
                ${log.tokens ? html`<span>${formatTokens(log.tokens)}</span>` : nothing}
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
