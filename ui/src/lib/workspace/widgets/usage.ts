// builtin:usage — a today/window cost + tokens mini-summary over `usage.cost`.
// Binding value shape: `{ totals: CostUsageTotals }` (see
// src/infra/session-cost-usage.types.ts). Thin re-implementation — the usage
// page's own view fns are welded to its filter state.

import { html, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { formatCost, formatTokens } from "../../format.ts";
import type { WorkspaceWidget } from "../types.ts";
import { isRecord, toFiniteNumber } from "./types.ts";

type UsageModel = {
  cost: number;
  tokens: number;
};

function mapUsage(_widget: WorkspaceWidget, value: unknown): UsageModel {
  const totals = isRecord(value) && isRecord(value.totals) ? value.totals : {};
  const cost = toFiniteNumber(totals.totalCost) ?? 0;
  const tokens = toFiniteNumber(totals.totalTokens) ?? 0;
  return { cost, tokens };
}

export function renderUsage(widget: WorkspaceWidget, value: unknown): TemplateResult {
  const model = mapUsage(widget, value);
  return html`
    <div class="workspace-usage" data-test-id="workspace-usage">
      <div class="workspace-usage__metric">
        <div class="workspace-usage__value">${formatCost(model.cost)}</div>
        <div class="workspace-usage__label">${t("workspaces.widget.usage.cost")}</div>
      </div>
      <div class="workspace-usage__metric">
        <div class="workspace-usage__value">${formatTokens(model.tokens)}</div>
        <div class="workspace-usage__label">${t("workspaces.widget.usage.tokens")}</div>
      </div>
    </div>
  `;
}
