// Pending custom-widget decisions only. The source is derived from the trusted
// workspace registry; controls appear only with operator.approvals access.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { workspaceAgentProvenance } from "../types.ts";
import type { WorkspaceDocument, WorkspaceWidget } from "../types.ts";
import {
  toFiniteNumber,
  widgetProps,
  type BuiltinWidgetContext,
  type CustomWidgetApprovalDecision,
  type CustomWidgetApprovalsSource,
  type PendingCustomWidgetApproval,
} from "./types.ts";

const DEFAULT_LIMIT = 8;

type CustomWidgetApprovalsModel = { items: PendingCustomWidgetApproval[]; total: number };

function toRegistryDecision(decision: CustomWidgetApprovalDecision): "approved" | "rejected" {
  return decision === "approve" ? "approved" : "rejected";
}

export function buildCustomWidgetApprovalsSource(
  workspace: WorkspaceDocument,
  deciding: ReadonlySet<string>,
  resolve?: (name: string, decision: "approved" | "rejected") => void,
): CustomWidgetApprovalsSource {
  const pending = Object.entries(workspace.widgetsRegistry)
    .filter(([, entry]) => entry.status === "pending")
    .map(([name, entry]) => ({
      id: name,
      title: name,
      requestedBy: workspaceAgentProvenance(entry.createdBy),
      deciding: deciding.has(name),
    }));
  return {
    pending,
    ...(resolve
      ? { onDecide: (item, decision) => resolve(item.id, toRegistryDecision(decision)) }
      : {}),
  };
}

function mapCustomWidgetApprovals(
  widget: WorkspaceWidget,
  source: CustomWidgetApprovalsSource | undefined,
): CustomWidgetApprovalsModel {
  const pending = source?.pending.filter((item) => item.id) ?? [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  return { items: pending.slice(0, limit), total: pending.length };
}

export function renderCustomWidgetApprovals(
  widget: WorkspaceWidget,
  _value: unknown,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  const source = ctx.customWidgetApprovals;
  const model = mapCustomWidgetApprovals(widget, source);
  if (model.items.length === 0) {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.customWidgetApprovals.empty")}
    </div>`;
  }
  return html`
    <ul
      class="workspace-list workspace-custom-widget-approvals"
      data-test-id="workspace-custom-widget-approvals"
    >
      ${model.items.map(
        (item) => html`
          <li class="workspace-list__row workspace-custom-widget-approvals__row">
            <span class="workspace-badge workspace-badge--muted"
              >${t("workspaces.widget.customWidgetApprovals.kind")}</span
            >
            <span class="workspace-list__label">${item.title}</span>
            ${item.requestedBy
              ? html`<span
                  class="workspace-list__meta workspace-custom-widget-approvals__requested-by"
                  >${t("workspaces.widget.customWidgetApprovals.requestedBy", {
                    agent: item.requestedBy,
                  })}</span
                >`
              : nothing}
            <span class="workspace-custom-widget-approvals__actions">
              <button
                class="btn btn--small btn--primary"
                type="button"
                data-test-id="workspace-custom-widget-approve"
                ?disabled=${!source?.onDecide || item.deciding}
                @click=${() => source?.onDecide?.(item, "approve")}
              >
                ${t("workspaces.widget.customWidgetApprovals.approve")}
              </button>
              <button
                class="btn btn--small"
                type="button"
                data-test-id="workspace-custom-widget-reject"
                ?disabled=${!source?.onDecide || item.deciding}
                @click=${() => source?.onDecide?.(item, "reject")}
              >
                ${t("workspaces.widget.customWidgetApprovals.reject")}
              </button>
            </span>
            ${source?.onDecide
              ? nothing
              : html`<span
                  class="workspace-list__meta workspace-custom-widget-approvals__permission"
                  role="note"
                  >${t("workspaces.widget.customWidgetApprovals.permissionRequired")}</span
                >`}
          </li>
        `,
      )}
    </ul>
  `;
}
