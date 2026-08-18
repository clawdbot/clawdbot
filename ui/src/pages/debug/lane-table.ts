import { html } from "lit";
import type { CommandLaneSnapshot } from "../../lib/gateway-diagnostics.ts";

export function renderCommandLaneRows(
  lanes: readonly CommandLaneSnapshot[],
  options: { compact?: boolean } = {},
) {
  return lanes.map((lane) => {
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
        <td class="mono command-lane-row__name">${lane.lane}</td>
        <td class="mono">${lane.activeCount}/${lane.maxConcurrent}</td>
        <td class="mono">${lane.queuedCount}</td>
        ${options.compact ? "" : html`<td>${group}</td>`}
        <td class="mono">${lane.blockedBy ?? "—"}</td>
      </tr>
    `;
  });
}
