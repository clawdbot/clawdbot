import { html, nothing, svg } from "lit";
import type { CostUsageSummary } from "../../api/types.ts";
import {
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatCost } from "../../lib/format.ts";
import {
  buildHeatmap,
  computeStreaks,
  formatLongDuration,
  formatTokenScale,
  localDateString,
  peakDay,
  type ProfileHeatmap,
  type ProfileInsights,
} from "./stats.ts";

const HEATMAP_CELL = 11;
const HEATMAP_GAP = 3;
const HEATMAP_PITCH = HEATMAP_CELL + HEATMAP_GAP;
const HEATMAP_LEFT = 30;
const HEATMAP_TOP = 18;

// Fixed reference week (2024-01-01 is a Monday) for localized weekday labels.
const WEEKDAY_LABEL_ROWS = [
  { row: 1, utcDay: Date.UTC(2024, 0, 1) },
  { row: 3, utcDay: Date.UTC(2024, 0, 3) },
  { row: 5, utcDay: Date.UTC(2024, 0, 5) },
];

function integerFormat(): Intl.NumberFormat {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
}

function formatFullDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function streakLabel(days: number): string {
  return t(days === 1 ? "profilePage.streakDay" : "profilePage.streakDays", {
    count: integerFormat().format(days),
  });
}

export function renderProfileStats(
  summary: CostUsageSummary | null,
  insights: ProfileInsights | null,
) {
  if (!summary) {
    return nothing;
  }
  const streaks = computeStreaks(summary.daily, localDateString());
  const peak = peakDay(summary.daily);
  const cells: Array<{ label: string; value: string; sub?: string }> = [
    {
      label: t("profilePage.statLifetimeTokens"),
      value: formatTokenScale(summary.totals.totalTokens),
      sub: summary.totals.totalCost > 0 ? `≈ ${formatCost(summary.totals.totalCost)}` : undefined,
    },
    {
      label: t("profilePage.statPeakDay"),
      value: formatTokenScale(peak?.totalTokens ?? 0),
      sub: peak ? formatFullDate(peak.date) : undefined,
    },
    {
      label: t("profilePage.statLongestSession"),
      value:
        insights?.longestSessionMs != null ? formatLongDuration(insights.longestSessionMs) : "—",
    },
    { label: t("profilePage.statCurrentStreak"), value: streakLabel(streaks.current) },
    { label: t("profilePage.statLongestStreak"), value: streakLabel(streaks.longest) },
  ];
  return renderSettingsGroup(html`
    <section class="profile-stats">
      ${cells.map(
        (cell) => html`
          <div class="profile-stats__cell">
            <div class="profile-stats__value">${cell.value}</div>
            <div class="profile-stats__label">${cell.label}</div>
            ${cell.sub ? html`<div class="profile-stats__sub">${cell.sub}</div>` : nothing}
          </div>
        `,
      )}
    </section>
  `);
}

function renderHeatmapSvg(heatmap: ProfileHeatmap) {
  const weekCount = heatmap.weeks.length;
  const width = HEATMAP_LEFT + weekCount * HEATMAP_PITCH;
  const height = HEATMAP_TOP + 7 * HEATMAP_PITCH;
  const numberFormat = integerFormat();
  const weekdayFormat = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
  return html`
    <svg
      class="profile-heatmap__svg"
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label=${t("profilePage.heatmapTitle")}
    >
      ${heatmap.monthLabels.map((label, index) =>
        label
          ? svg`<text class="profile-heatmap__month" x=${HEATMAP_LEFT + index * HEATMAP_PITCH} y="10">${label}</text>`
          : nothing,
      )}
      ${WEEKDAY_LABEL_ROWS.map(
        ({ row, utcDay }) =>
          svg`<text class="profile-heatmap__weekday" x=${HEATMAP_LEFT - 6} y=${HEATMAP_TOP + row * HEATMAP_PITCH + HEATMAP_CELL - 2}>${weekdayFormat.format(new Date(utcDay))}</text>`,
      )}
      ${heatmap.weeks.map((week, weekIndex) =>
        week.days.map((day, dayIndex) => {
          if (!day) {
            return nothing;
          }
          const tooltip = `${formatFullDate(day.date)} · ${t("profilePage.heatmapCellTokens", {
            tokens: numberFormat.format(day.tokens),
          })}`;
          return svg`
            <rect
              class="profile-heatmap__cell profile-heatmap__cell--l${day.level}"
              x=${HEATMAP_LEFT + weekIndex * HEATMAP_PITCH}
              y=${HEATMAP_TOP + dayIndex * HEATMAP_PITCH}
              width=${HEATMAP_CELL}
              height=${HEATMAP_CELL}
              rx="2.5"
            ><title>${tooltip}</title></rect>
          `;
        }),
      )}
    </svg>
  `;
}

export function renderProfileHeatmap(summary: CostUsageSummary | null) {
  if (!summary) {
    return nothing;
  }
  const heatmap = buildHeatmap(summary.daily, localDateString());
  const legend = html`
    <div class="profile-heatmap__legend" aria-hidden="true">
      <span>${t("profilePage.legendLess")}</span>
      ${[0, 1, 2, 3, 4].map(
        (level) =>
          html`<span class="profile-heatmap__swatch profile-heatmap__cell--l${level}"></span>`,
      )}
      <span>${t("profilePage.legendMore")}</span>
    </div>
  `;
  return renderSettingsSection(
    {
      title: t("profilePage.heatmapTitle"),
      description: t("profilePage.heatmapSub"),
      actions: legend,
    },
    html`<div class="profile-heatmap">${renderHeatmapSvg(heatmap)}</div>`,
  );
}

export function renderProfileInsights(insights: ProfileInsights | null) {
  if (!insights) {
    return nothing;
  }
  const numberFormat = integerFormat();
  const rows: Array<{ label: string; value: string }> = [
    { label: t("profilePage.insightModel"), value: insights.topModel ?? "—" },
    { label: t("profilePage.insightMessages"), value: numberFormat.format(insights.messages) },
    { label: t("profilePage.insightToolCalls"), value: numberFormat.format(insights.toolCalls) },
    {
      label: t("profilePage.insightUniqueTools"),
      value: numberFormat.format(insights.uniqueTools),
    },
    { label: t("profilePage.insightAgents"), value: numberFormat.format(insights.agents) },
    {
      label: t("profilePage.insightSessions"),
      value: insights.sessionsCapped
        ? t("profilePage.sessionsCapped", { count: numberFormat.format(insights.sessions) })
        : numberFormat.format(insights.sessions),
    },
  ];
  const maxToolCount = insights.topTools[0]?.count ?? 0;
  const insightsSection = renderSettingsSection(
    { title: t("profilePage.insightsTitle") },
    html`
      <dl class="settings-kv">
        ${rows.map(
          (row) => html`
            <dt>${row.label}</dt>
            <dd>${row.value}</dd>
          `,
        )}
      </dl>
    `,
  );
  const toolsSection = renderSettingsSection(
    { title: t("profilePage.toolsTitle") },
    insights.topTools.length === 0
      ? renderSettingsEmpty(t("profilePage.toolsEmpty"))
      : html`
          <div class="profile-tools">
            ${insights.topTools.map(
              (tool) => html`
                <div class="profile-tools__row">
                  <span class="profile-tools__name">${tool.name}</span>
                  <span class="profile-tools__bar" aria-hidden="true">
                    <span
                      class="profile-tools__bar-fill"
                      style="width: ${maxToolCount > 0
                        ? Math.max(4, Math.round((tool.count / maxToolCount) * 100))
                        : 0}%"
                    ></span>
                  </span>
                  <span class="profile-tools__count">
                    ${t(tool.count === 1 ? "profilePage.toolRun" : "profilePage.toolRuns", {
                      count: integerFormat().format(tool.count),
                    })}
                  </span>
                </div>
              `,
            )}
          </div>
        `,
  );
  return html`${insightsSection} ${toolsSection}`;
}
