// builtin:stat-card — big number + label. One binding (`value`). `props.format`
// controls presentation (usd | int | percent | raw). When the binding resolves a
// structured payload (e.g. `usage.cost`), `props.metric` selects a field from it
// so a stat-card can front a rich RPC without a binding pointer (rpc bindings
// carry no pointer — see extensions/workspace schema).

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import type { WorkspaceWidget } from "../types.ts";
import { isRecord, toFiniteNumber, widgetProps } from "./types.ts";

type StatCardModel = {
  /** The display string for the primary value, or null when unavailable. */
  display: string | null;
  /** Inner label; null when it would merely repeat the widget title. */
  label: string | null;
};

/** Named metrics selectable from a structured binding payload via `props.metric`. */
function selectMetric(value: unknown, metric: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  const totals = isRecord(value.totals) ? value.totals : undefined;
  switch (metric) {
    case "todayCost":
      return totals?.totalCost ?? value.totalCost;
    case "todayTokens":
      return totals?.totalTokens ?? value.totalTokens;
    default:
      return value[metric];
  }
}

function formatStatValue(value: unknown, format: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const numeric = toFiniteNumber(value);
  if (format === "usd" && numeric !== undefined) {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(numeric);
  }
  if (format === "percent" && numeric !== undefined) {
    return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(
      numeric,
    );
  }
  if ((format === "int" || format === "integer") && numeric !== undefined) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(numeric);
  }
  if (typeof value === "string") {
    return value;
  }
  if (numeric !== undefined) {
    return new Intl.NumberFormat(undefined).format(numeric);
  }
  return JSON.stringify(value);
}

function mapStatCard(widget: WorkspaceWidget, value: unknown): StatCardModel {
  const props = widgetProps(widget);
  const metric = typeof props.metric === "string" ? props.metric : null;
  const selected = metric ? selectMetric(value, metric) : value;
  const resolved = selected !== undefined ? selected : props.value;
  const label = typeof props.label === "string" ? props.label : widget.title;
  // #6 nit: drop the inner label when it merely repeats the widget title —
  // the cell already renders `widget.title` in the bar.
  const dedupedLabel = label && label !== widget.title ? label : null;
  return { display: formatStatValue(resolved, props.format), label: dedupedLabel };
}

export function renderStatCard(widget: WorkspaceWidget, value: unknown): TemplateResult {
  const model = mapStatCard(widget, value);
  return html`
    <div class="workspace-stat">
      <div class="workspace-stat__value">${model.display ?? t("workspaces.widget.stat.empty")}</div>
      ${model.label ? html`<div class="workspace-stat__label">${model.label}</div>` : nothing}
    </div>
  `;
}
