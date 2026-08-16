import { html, nothing, svg } from "lit";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { buildUsageHeatmap, type UsageHeatmap } from "./heatmap.ts";
import { formatFullDate } from "./metrics.ts";
import type { CostDailyEntry } from "./types.ts";

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

function renderHeatmapSvg(heatmap: UsageHeatmap) {
  const width = HEATMAP_LEFT + heatmap.weeks.length * HEATMAP_PITCH;
  const height = HEATMAP_TOP + 7 * HEATMAP_PITCH;
  const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const weekdayFormat = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
  return html`
    <svg
      class="usage-heatmap__svg"
      viewBox="0 0 ${width} ${height}"
      style="--usage-heatmap-width: ${width}px"
      role="img"
      aria-label=${t("usage.heatmap.title")}
    >
      ${heatmap.monthLabels.map((label, index) =>
        label
          ? svg`<text class="usage-heatmap__month" x=${HEATMAP_LEFT + index * HEATMAP_PITCH} y="10">${label}</text>`
          : nothing,
      )}
      ${WEEKDAY_LABEL_ROWS.map(
        ({ row, utcDay }) =>
          svg`<text class="usage-heatmap__weekday" x=${HEATMAP_LEFT - 6} y=${HEATMAP_TOP + row * HEATMAP_PITCH + HEATMAP_CELL - 2}>${weekdayFormat.format(new Date(utcDay))}</text>`,
      )}
      ${heatmap.weeks.map((week, weekIndex) =>
        week.days.map((day, dayIndex) => {
          if (!day) {
            return nothing;
          }
          const tooltip = `${formatFullDate(day.date)} · ${t("usage.heatmap.cellTokens", {
            tokens: numberFormat.format(day.tokens),
          })}`;
          return svg`
            <rect
              class="usage-heatmap__cell usage-heatmap__cell--l${day.level}"
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

export function renderUsageHeatmap(
  daily: readonly CostDailyEntry[],
  rangeStartDate: string,
  rangeEndDate: string,
) {
  if (daily.length === 0) {
    return nothing;
  }
  const heatmap = buildUsageHeatmap(daily, rangeStartDate, rangeEndDate);
  const legend = html`
    <div class="usage-heatmap__legend" aria-hidden="true">
      <span>${t("usage.heatmap.less")}</span>
      ${[0, 1, 2, 3, 4].map(
        (level) => html`<span class="usage-heatmap__swatch usage-heatmap__cell--l${level}"></span>`,
      )}
      <span>${t("usage.heatmap.more")}</span>
    </div>
  `;
  return renderSettingsSection(
    {
      title: t("usage.heatmap.title"),
      description: t("usage.heatmap.subtitle"),
      actions: legend,
    },
    html`<div class="usage-panel usage-heatmap">${renderHeatmapSvg(heatmap)}</div>`,
  );
}
