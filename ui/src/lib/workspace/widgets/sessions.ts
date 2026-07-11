// builtin:sessions — latest-N sessions with a live-run dot; each row links to the
// chat route for that session. Thin re-implementation over `sessions.list`
// (NOT the sessions page's welded view fns). Binding value shape:
// `{ sessions: GatewaySessionRow[] }` or a bare row array.

import { html, nothing, type TemplateResult } from "lit";
import type { SessionRunStatus } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import { t } from "../../../i18n/index.ts";
import { formatDateTimeMs } from "../../format.ts";
import { isSessionRunActive } from "../../session-run-state.ts";
import { searchForSession } from "../../sessions/navigation.ts";
import type { WorkspaceWidget } from "../types.ts";
import { isRecord, toFiniteNumber, widgetProps } from "./types.ts";

const DEFAULT_LIMIT = 6;

export type SessionsRowModel = {
  key: string;
  label: string;
  active: boolean;
  updatedAt: number | null;
};

export type SessionsModel = {
  rows: SessionsRowModel[];
  total: number;
};

function rowLabel(row: Record<string, unknown>, key: string): string {
  const display = row.displayName ?? row.label ?? row.subject ?? row.channel;
  return typeof display === "string" && display.trim() ? display : key;
}

export function mapSessions(widget: WorkspaceWidget, value: unknown): SessionsModel {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sessions)
      ? value.sessions
      : [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  const records = raw.filter(isRecord);
  const rows = records
    .map((row) => {
      const key = typeof row.key === "string" ? row.key : "";
      return {
        key,
        label: rowLabel(row, key),
        active: isSessionRunActive({
          hasActiveRun: typeof row.hasActiveRun === "boolean" ? row.hasActiveRun : undefined,
          status: typeof row.status === "string" ? (row.status as SessionRunStatus) : undefined,
        }),
        updatedAt: toFiniteNumber(row.updatedAt) ?? null,
      };
    })
    .filter((row) => row.key)
    .slice(0, limit);
  return { rows, total: records.length };
}

export function renderSessions(
  widget: WorkspaceWidget,
  value: unknown,
  basePath = "",
): TemplateResult {
  const model = mapSessions(widget, value);
  if (model.rows.length === 0) {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.sessions.empty")}
    </div>`;
  }
  const chatPath = pathForRoute("chat", basePath);
  return html`
    <ul class="workspace-list workspace-sessions" data-test-id="workspace-sessions">
      ${model.rows.map(
        (row) => html`
          <li class="workspace-list__row">
            <a class="workspace-list__link" href=${`${chatPath}${searchForSession(row.key)}`}>
              <span
                class="workspace-dot ${row.active ? "workspace-dot--live" : ""}"
                aria-hidden="true"
              ></span>
              <span class="workspace-list__label">${row.label}</span>
              ${row.updatedAt !== null
                ? html`<span class="workspace-list__meta">${formatDateTimeMs(row.updatedAt)}</span>`
                : nothing}
            </a>
          </li>
        `,
      )}
    </ul>
  `;
}
