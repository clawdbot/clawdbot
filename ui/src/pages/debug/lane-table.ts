import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { registerDebugEnglish } from "../../i18n/locales/en-debug.ts";
import type { CommandLaneDiagnostics } from "../../lib/gateway-diagnostics.ts";

registerDebugEnglish();

export function renderCommandLaneRows(
  diagnostics: CommandLaneDiagnostics,
  options: { compact?: boolean } = {},
) {
  const rows = diagnostics.lanes.map((lane) => {
    const saturated = lane.activeCount >= lane.maxConcurrent;
    const queued = lane.queuedCount > 0;
    const classes = [
      "command-lane-row",
      saturated ? "command-lane-row--saturated" : "",
      queued ? "command-lane-row--queued" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const group = lane.group
      ? `${lane.group} · ${lane.groupActive ?? 0}/${lane.groupBudget ?? 0}`
      : "";
    return html`
      <tr class=${classes}>
        <td class="mono command-lane-row__name" data-label=${t("debug.lanes.lane")}>
          ${lane.lane}
        </td>
        <td class="mono" data-label=${t("debug.lanes.active")}>
          ${lane.activeCount}/${lane.maxConcurrent}
        </td>
        <td class="mono" data-label=${t("debug.lanes.queued")}>${lane.queuedCount}</td>
        ${options.compact ? "" : html`<td data-label=${t("debug.lanes.group")}>${group}</td>`}
        <td class="mono" data-label=${t("debug.lanes.blocked")}>${lane.blockedBy ?? "—"}</td>
      </tr>
    `;
  });
  const dynamic = diagnostics.dynamic;
  if (dynamic) {
    const classes = [
      "command-lane-row",
      "command-lane-row--dynamic",
      dynamic.queuedCount > 0 ? "command-lane-row--queued" : "",
    ]
      .filter(Boolean)
      .join(" ");
    rows.push(html`
      <tr class=${classes}>
        <td class="mono command-lane-row__name" data-label=${t("debug.lanes.lane")}>
          ${t("debug.lanes.sessionLanes", { count: String(dynamic.laneCount) })}
        </td>
        <td class="mono" data-label=${t("debug.lanes.active")}>${dynamic.activeCount}</td>
        <td class="mono" data-label=${t("debug.lanes.queued")}>${dynamic.queuedCount}</td>
        ${options.compact ? "" : html`<td data-label=${t("debug.lanes.group")}></td>`}
        <td class="mono" data-label=${t("debug.lanes.blocked")}>—</td>
      </tr>
    `);
  }
  return rows;
}
