// builtin:activity — a compact recent-activity feed over `cron.runs` (scope
// "all"). Binding value shape: `{ entries: CronRunLogEntry[] }` (see
// ui/src/api/types.ts CronRunLogEntry). Each entry is a completed run with a ts,
// job name, status, and optional summary.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { clampText, formatDateTimeMs } from "../../format.ts";
import type { WorkspaceWidget } from "../types.ts";
import { isRecord, toFiniteNumber, widgetProps } from "./types.ts";

const DEFAULT_LIMIT = 20;

type ActivityEntryModel = {
  ts: number | null;
  title: string;
  detail: string | null;
  status: string | null;
};

type ActivityModel = {
  entries: ActivityEntryModel[];
  total: number;
};

function entryTitle(entry: Record<string, unknown>): string {
  const name = entry.jobName ?? entry.jobId ?? entry.action;
  return typeof name === "string" && name.trim() ? name : "run";
}

function mapActivity(widget: WorkspaceWidget, value: unknown): ActivityModel {
  const raw = isRecord(value) && Array.isArray(value.entries) ? value.entries : [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  const records = raw.filter(isRecord);
  const entries = records
    .map((entry) => ({
      ts: toFiniteNumber(entry.ts) ?? null,
      title: entryTitle(entry),
      detail:
        typeof entry.summary === "string" && entry.summary.trim()
          ? clampText(entry.summary, 120)
          : typeof entry.error === "string" && entry.error.trim()
            ? clampText(entry.error, 120)
            : null,
      status: typeof entry.status === "string" ? entry.status : null,
    }))
    .slice(0, limit);
  return { entries, total: records.length };
}

function statusClass(status: string | null): string {
  if (status === "ok") {
    return "workspace-badge--ok";
  }
  if (status === "error") {
    return "workspace-badge--error";
  }
  return "workspace-badge--muted";
}

export function renderActivity(widget: WorkspaceWidget, value: unknown): TemplateResult {
  const model = mapActivity(widget, value);
  if (model.entries.length === 0) {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.activity.empty")}
    </div>`;
  }
  return html`
    <ul class="workspace-feed" data-test-id="workspace-activity">
      ${model.entries.map(
        (entry) => html`
          <li class="workspace-feed__row">
            <div class="workspace-feed__head">
              <span class="workspace-feed__title">${entry.title}</span>
              ${entry.status
                ? html`<span class="workspace-badge ${statusClass(entry.status)}"
                    >${entry.status}</span
                  >`
                : nothing}
              ${entry.ts !== null
                ? html`<span class="workspace-feed__time">${formatDateTimeMs(entry.ts)}</span>`
                : nothing}
            </div>
            ${entry.detail
              ? html`<div class="workspace-feed__detail">${entry.detail}</div>`
              : nothing}
          </li>
        `,
      )}
    </ul>
  `;
}
