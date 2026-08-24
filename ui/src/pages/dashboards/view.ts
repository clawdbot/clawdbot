import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";

export type DashboardsRouteData = {
  result: SessionsListResult | null;
  error: string | null;
  basePath: string;
  fallbackAgentId: string;
  mainKey: string;
};

function renderDashboardList(data: DashboardsRouteData) {
  const rows = data.result?.sessions ?? [];
  if (data.error) {
    return html`<section class="card" role="alert">
      ${t("dashboardsPage.loadError", { error: data.error })}
    </section>`;
  }
  if (rows.length === 0) {
    return html`<section class="card stack" data-dashboards-empty role="status">
      <div class="list-title">${t("dashboardsPage.emptyTitle")}</div>
      <div class="card-sub">${t("dashboardsPage.emptyDescription")}</div>
    </section>`;
  }
  return html`<section class="card stack">
    <div class="list" aria-label=${titleForRoute("dashboards")}>
      ${repeat(
        rows,
        (row) => row.key,
        (row) => {
          const target = sessionNavigationTarget({
            face: "dashboard",
            sessionKey: row.key,
            fallbackAgentId: data.fallbackAgentId,
            basePath: data.basePath,
            row,
            mainKey: data.mainKey,
          });
          const focusHref =
            buildControlUiFocusPath({ kind: "dashboard", path: target.href }, data.basePath) ??
            target.href;
          return html`<div class="list-item" data-dashboard-session=${row.key}>
            <a class="list-main list-item-clickable" href=${target.href}>
              <span class="list-title">${resolveSessionDisplayName(row.key, row)}</span>
              <span class="list-sub">${row.key}</span>
            </a>
            <span class="list-meta">
              ${row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : nothing}
              <a
                class="btn btn--ghost"
                data-dashboard-fullscreen=${row.key}
                href=${focusHref}
                aria-label=${t("dashboardsPage.openFocusMode")}
              >
                ${icons.maximize} ${t("dashboardsPage.openFocusMode")}
              </a>
            </span>
          </div>`;
        },
      )}
    </div>
  </section>`;
}

export function renderDashboards(data: DashboardsRouteData | undefined) {
  const body = data
    ? renderDashboardList(data)
    : html`<section class="card" aria-busy="true">${t("common.loading")}</section>`;
  return html`
    <section class="content-header">
      <div>
        <div class="page-title">${titleForRoute("dashboards")}</div>
        <div class="page-sub">${t("subtitles.dashboards")}</div>
      </div>
    </section>
    ${renderSettingsWorkspace(body)}
  `;
}
