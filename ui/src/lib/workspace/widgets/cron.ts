// builtin:cron — next runs + last status per job over `cron.list`. Binding value
// shape: `{ jobs: CronJob[] }` where each job carries `state.nextRunAtMs` and
// `state.lastRunStatus` (see ui/src/api/types.ts CronJob / CronJobState).

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { formatDateTimeMs } from "../../format.ts";
import type { WorkspaceWidget } from "../types.ts";
import { isRecord, toFiniteNumber, widgetProps } from "./types.ts";

const DEFAULT_LIMIT = 8;

export type CronJobModel = {
  id: string;
  name: string;
  enabled: boolean;
  nextRunAtMs: number | null;
  lastStatus: string | null;
};

export type CronModel = {
  jobs: CronJobModel[];
  total: number;
};

function jobStatus(state: Record<string, unknown> | undefined): string | null {
  if (!state) {
    return null;
  }
  const status = state.lastRunStatus ?? state.lastStatus;
  return typeof status === "string" ? status : null;
}

export function mapCron(widget: WorkspaceWidget, value: unknown): CronModel {
  const raw = isRecord(value) && Array.isArray(value.jobs) ? value.jobs : [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  const records = raw.filter(isRecord);
  const jobs = records
    .map((job) => {
      const state = isRecord(job.state) ? job.state : undefined;
      return {
        id: typeof job.id === "string" ? job.id : "",
        name: typeof job.name === "string" && job.name.trim() ? job.name : (job.id as string) || "",
        enabled: job.enabled !== false,
        nextRunAtMs: state ? (toFiniteNumber(state.nextRunAtMs) ?? null) : null,
        lastStatus: jobStatus(state),
      };
    })
    .filter((job) => job.id)
    .slice(0, limit);
  return { jobs, total: records.length };
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

export function renderCron(widget: WorkspaceWidget, value: unknown): TemplateResult {
  const model = mapCron(widget, value);
  if (model.jobs.length === 0) {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.cron.empty")}
    </div>`;
  }
  return html`
    <ul class="workspace-list workspace-cron" data-test-id="workspace-cron">
      ${model.jobs.map(
        (job) => html`
          <li class="workspace-list__row ${job.enabled ? "" : "workspace-list__row--disabled"}">
            <span class="workspace-list__label">${job.name}</span>
            <span class="workspace-list__meta">
              ${job.nextRunAtMs !== null
                ? t("workspaces.widget.cron.next", { time: formatDateTimeMs(job.nextRunAtMs) })
                : t("workspaces.widget.cron.noNext")}
            </span>
            ${job.lastStatus
              ? html`<span class="workspace-badge ${statusClass(job.lastStatus)}"
                  >${job.lastStatus}</span
                >`
              : nothing}
          </li>
        `,
      )}
    </ul>
  `;
}
