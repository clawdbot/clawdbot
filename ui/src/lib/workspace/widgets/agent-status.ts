// Trusted status view over the same read-only sessions.list payload used by the
// sessions builtin. It never performs RPCs or exposes session write actions.

import { html, nothing, type TemplateResult } from "lit";
import type { SessionRunStatus } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { clampText } from "../../format.ts";
import { isSessionRunActive } from "../../session-run-state.ts";
import type { WorkspaceWidget } from "../types.ts";
import { isRecord, toFiniteNumber, widgetProps } from "./types.ts";

const DEFAULT_LIMIT = 8;

type AgentStatusRowModel = {
  key: string;
  label: string;
  active: boolean;
  task: string | null;
  progress: number | null;
};

type AgentStatusModel = {
  rows: AgentStatusRowModel[];
  activeCount: number;
  total: number;
};

function rowLabel(row: Record<string, unknown>, key: string): string {
  const display = row.displayName ?? row.label ?? row.subject ?? row.channel;
  return typeof display === "string" && display.trim() ? display : key;
}

function rowTask(row: Record<string, unknown>): string | null {
  const goal = isRecord(row.goal) ? row.goal : undefined;
  const objective = goal && typeof goal.objective === "string" ? goal.objective.trim() : "";
  return objective ? clampText(objective, 100) : null;
}

function rowProgress(row: Record<string, unknown>): number | null {
  const goal = isRecord(row.goal) ? row.goal : undefined;
  if (!goal) {
    return null;
  }
  const used = toFiniteNumber(goal.tokensUsed);
  const budget = toFiniteNumber(goal.tokenBudget);
  if (used === undefined || budget === undefined || budget <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, used / budget));
}

function mapAgentStatus(widget: WorkspaceWidget, value: unknown): AgentStatusModel {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sessions)
      ? value.sessions
      : [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  const rows = raw
    .filter(isRecord)
    .map((row) => {
      const key = typeof row.key === "string" ? row.key : "";
      return {
        key,
        label: rowLabel(row, key),
        active: isSessionRunActive({
          hasActiveRun: typeof row.hasActiveRun === "boolean" ? row.hasActiveRun : undefined,
          status: typeof row.status === "string" ? (row.status as SessionRunStatus) : undefined,
        }),
        task: rowTask(row),
        progress: rowProgress(row),
      };
    })
    .filter((row) => row.key);
  return {
    rows: rows.slice(0, limit),
    activeCount: rows.filter((row) => row.active).length,
    total: rows.length,
  };
}

export function renderAgentStatus(widget: WorkspaceWidget, value: unknown): TemplateResult {
  const model = mapAgentStatus(widget, value);
  if (model.rows.length === 0) {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.agentStatus.empty")}
    </div>`;
  }
  return html`
    <ul class="workspace-list workspace-agent-status" data-test-id="workspace-agent-status">
      ${model.rows.map(
        (row) => html`
          <li class="workspace-list__row">
            <span
              class="workspace-dot ${row.active ? "workspace-dot--live" : ""}"
              aria-hidden="true"
            ></span>
            <span class="workspace-list__label">${row.label}</span>
            <span
              class="workspace-badge ${row.active
                ? "workspace-badge--ok"
                : "workspace-badge--muted"}"
            >
              ${row.active
                ? t("workspaces.widget.agentStatus.busy")
                : t("workspaces.widget.agentStatus.idle")}
            </span>
            ${row.task ? html`<span class="workspace-list__meta">${row.task}</span>` : nothing}
            ${row.progress !== null
              ? html`<span class="workspace-list__meta"
                  >${t("workspaces.widget.agentStatus.progress", {
                    percent: String(Math.round(row.progress * 100)),
                  })}</span
                >`
              : nothing}
          </li>
        `,
      )}
    </ul>
  `;
}
