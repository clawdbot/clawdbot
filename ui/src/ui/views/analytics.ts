import { html, nothing } from "lit";

export type CostUsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  missingCostEntries: number;
};

export type CostUsageDailyEntry = CostUsageTotals & {
  date: string;
};

export type CostUsageSummary = {
  updatedAt: number;
  days: number;
  daily: CostUsageDailyEntry[];
  totals: CostUsageTotals;
};

export type AnalyticsProps = {
  loading: boolean;
  error: string | null;
  data: CostUsageSummary | null;
  days: number;
  onDaysChange: (days: number) => void;
  onRefresh: () => void;
};

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function renderBarChart(daily: CostUsageDailyEntry[], metric: "totalTokens" | "totalCost") {
  if (!daily.length) {
    return html`<div class="chart-empty">No data for this period</div>`;
  }

  const values = daily.map((d) => d[metric]);
  const max = Math.max(...values, 1);
  const barWidth = Math.max(8, Math.min(40, Math.floor(600 / daily.length) - 4));

  return html`
    <div class="chart-container">
      <div class="chart-bars">
        ${daily.map((entry, i) => {
          const value = entry[metric];
          const height = Math.max(2, (value / max) * 150);
          const label = metric === "totalCost" ? formatCost(value) : formatNumber(value);
          const dateLabel = entry.date.slice(5); // MM-DD
          return html`
            <div class="chart-bar-wrapper" style="width: ${barWidth}px">
              <div class="chart-bar-tooltip">${label}</div>
              <div
                class="chart-bar"
                style="height: ${height}px; width: ${barWidth - 2}px"
                title="${entry.date}: ${label}"
              ></div>
              <div class="chart-bar-label">${dateLabel}</div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

export function renderAnalytics(props: AnalyticsProps) {
  const { loading, error, data, days } = props;
  const totals = data?.totals;

  return html`
    <style>
      .analytics-controls {
        display: flex;
        gap: 12px;
        align-items: center;
        margin-bottom: 20px;
      }
      .analytics-controls select {
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--bg-elevated);
        color: var(--fg);
        font-size: 14px;
      }
      .chart-container {
        overflow-x: auto;
        padding: 20px 0;
      }
      .chart-bars {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        min-height: 180px;
        padding-bottom: 24px;
      }
      .chart-bar-wrapper {
        display: flex;
        flex-direction: column;
        align-items: center;
        position: relative;
      }
      .chart-bar {
        background: var(--accent, #6366f1);
        border-radius: 3px 3px 0 0;
        transition: opacity 0.15s;
      }
      .chart-bar:hover {
        opacity: 0.8;
      }
      .chart-bar-label {
        font-size: 10px;
        color: var(--fg-muted);
        margin-top: 4px;
        white-space: nowrap;
      }
      .chart-bar-tooltip {
        font-size: 11px;
        color: var(--fg-muted);
        margin-bottom: 4px;
        opacity: 0;
        transition: opacity 0.15s;
      }
      .chart-bar-wrapper:hover .chart-bar-tooltip {
        opacity: 1;
      }
      .chart-empty {
        color: var(--fg-muted);
        padding: 40px;
        text-align: center;
      }
      .analytics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 16px;
        margin-bottom: 24px;
      }
      .analytics-stat {
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
      }
      .analytics-stat-label {
        font-size: 12px;
        color: var(--fg-muted);
        margin-bottom: 4px;
      }
      .analytics-stat-value {
        font-size: 24px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
    </style>

    <section class="card">
      <div class="card-title">Usage Summary</div>
      <div class="card-sub">Token consumption and estimated costs.</div>

      <div class="analytics-controls" style="margin-top: 16px;">
        <label>
          Period:
          <select
            .value=${String(days)}
            @change=${(e: Event) => {
              const value = parseInt((e.target as HTMLSelectElement).value, 10);
              props.onDaysChange(value);
            }}
          >
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
        <button class="btn" @click=${() => props.onRefresh()} ?disabled=${loading}>
          ${loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      ${error ? html`<div class="callout danger">${error}</div>` : nothing}

      ${totals
        ? html`
            <div class="analytics-grid">
              <div class="analytics-stat">
                <div class="analytics-stat-label">Total Tokens</div>
                <div class="analytics-stat-value">${formatNumber(totals.totalTokens)}</div>
              </div>
              <div class="analytics-stat">
                <div class="analytics-stat-label">Input Tokens</div>
                <div class="analytics-stat-value">${formatNumber(totals.input)}</div>
              </div>
              <div class="analytics-stat">
                <div class="analytics-stat-label">Output Tokens</div>
                <div class="analytics-stat-value">${formatNumber(totals.output)}</div>
              </div>
              <div class="analytics-stat">
                <div class="analytics-stat-label">Cache Read</div>
                <div class="analytics-stat-value">${formatNumber(totals.cacheRead)}</div>
              </div>
              <div class="analytics-stat">
                <div class="analytics-stat-label">Cache Write</div>
                <div class="analytics-stat-value">${formatNumber(totals.cacheWrite)}</div>
              </div>
              <div class="analytics-stat">
                <div class="analytics-stat-label">Est. Cost</div>
                <div class="analytics-stat-value">${formatCost(totals.totalCost)}</div>
              </div>
            </div>
          `
        : nothing}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Daily Tokens</div>
      <div class="card-sub">Token usage per day.</div>
      ${data?.daily ? renderBarChart(data.daily, "totalTokens") : html`<div class="chart-empty">${loading ? "Loading..." : "No data"}</div>`}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Daily Cost</div>
      <div class="card-sub">Estimated cost per day.</div>
      ${data?.daily ? renderBarChart(data.daily, "totalCost") : html`<div class="chart-empty">${loading ? "Loading..." : "No data"}</div>`}
    </section>
  `;
}
