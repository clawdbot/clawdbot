import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { icons } from "../../components/icons.ts";
import { renderPanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import "../../styles/dashboards.css";

export type DashboardsRouteData = {
  result: SessionsListResult | null;
  error: string | null;
  basePath: string;
  fallbackAgentId: string;
  mainKey: string;
};

export type DashboardGalleryFilters = {
  query: string;
  ownerId: string;
  sort: "updated" | "title";
};

export type DashboardGalleryHandlers = {
  onQueryChange: (value: string) => void;
  onOwnerChange: (value: string) => void;
  onSortChange: (value: DashboardGalleryFilters["sort"]) => void;
};

type DashboardRow = SessionsListResult["sessions"][number];

const DEFAULT_FILTERS: DashboardGalleryFilters = { query: "", ownerId: "", sort: "updated" };
const NOOP_HANDLERS: DashboardGalleryHandlers = {
  onQueryChange: () => undefined,
  onOwnerChange: () => undefined,
  onSortChange: () => undefined,
};

function dashboardAuthor(row: DashboardRow, fallbackAgentId: string) {
  const actor = row.createdActor ?? row.owner?.actor;
  const id = actor?.id?.trim() || row.agentId?.trim() || fallbackAgentId;
  return { id, label: actor?.label?.trim() || id };
}

function dashboardPreviewVariant(key: string): number {
  let hash = 0;
  for (const character of key) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % 3;
}

function renderDashboardPreview(row: DashboardRow) {
  return html`<div
    class="dashboard-preview dashboard-preview--${dashboardPreviewVariant(row.key)}"
    aria-hidden="true"
  >
    <div class="dashboard-preview__topbar"><span></span><span></span><span></span><i></i></div>
    <div class="dashboard-preview__canvas">
      <div class="dashboard-preview__metric"><span></span><strong></strong><i></i></div>
      <div class="dashboard-preview__chart">
        <span></span><span></span><span></span><span></span><span></span><span></span>
      </div>
      <div class="dashboard-preview__feed"><span></span><span></span><span></span></div>
    </div>
  </div>`;
}

function visibleDashboardRows(data: DashboardsRouteData, filters: DashboardGalleryFilters) {
  const query = filters.query.trim().toLocaleLowerCase();
  return (data.result?.sessions ?? [])
    .filter((row) => {
      const author = dashboardAuthor(row, data.fallbackAgentId);
      if (filters.ownerId && author.id !== filters.ownerId) {
        return false;
      }
      return (
        !query ||
        [resolveSessionDisplayName(row.key, row), author.label, row.lastMessagePreview, row.key]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLocaleLowerCase().includes(query))
      );
    })
    .toSorted((left, right) =>
      filters.sort === "title"
        ? resolveSessionDisplayName(left.key, left).localeCompare(
            resolveSessionDisplayName(right.key, right),
          )
        : (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
}

function renderDashboardCard(data: DashboardsRouteData, row: DashboardRow) {
  const target = sessionNavigationTarget({
    face: "chat",
    sessionKey: row.key,
    fallbackAgentId: data.fallbackAgentId,
    basePath: data.basePath,
    row,
    mainKey: data.mainKey,
    dashboardExpanded: true,
  });
  const author = dashboardAuthor(row, data.fallbackAgentId);
  const title = resolveSessionDisplayName(row.key, row);
  const initial = author.label.trim().charAt(0).toLocaleUpperCase() || "?";
  return html`<article class="dashboard-card" data-dashboard-session=${row.key}>
    <a class="dashboard-card__main" href=${target.href} aria-label=${title}>
      ${renderDashboardPreview(row)}
      <div class="dashboard-card__body">
        <div class="dashboard-card__heading">
          <h2>${title}</h2>
          ${
            row.status === "running"
              ? html`<span class="dashboard-card__live"><i></i>${t("dashboardsPage.live")}</span>`
              : nothing
          }
        </div>
        <div class="dashboard-card__author">
          <span class="dashboard-card__avatar" aria-hidden="true">${initial}</span>
          <span>${t("dashboardsPage.byAuthor", { author: author.label })}</span>
        </div>
      </div>
      <footer class="dashboard-card__footer">
        <span>
          ${
            row.updatedAt
              ? t("dashboardsPage.updated", { time: formatRelativeTimestamp(row.updatedAt) })
              : t("dashboardsPage.updatedUnknown")
          }
        </span>
        <span class="dashboard-card__open" aria-hidden="true">${icons.arrowUpRight}</span>
      </footer>
    </a>
  </article>`;
}

function renderDashboardList(
  data: DashboardsRouteData,
  filters: DashboardGalleryFilters,
  handlers: DashboardGalleryHandlers,
) {
  const rows = data.result?.sessions ?? [];
  if (data.error && !data.result) {
    return nothing;
  }
  if (rows.length === 0) {
    return html`<section class="card stack" data-dashboards-empty role="status">
      <div class="list-title">${t("dashboardsPage.emptyTitle")}</div>
      <div class="card-sub">${t("dashboardsPage.emptyDescription")}</div>
    </section>`;
  }
  const owners = Array.from(
    new Map(
      rows.map((row) => {
        const author = dashboardAuthor(row, data.fallbackAgentId);
        return [author.id, author] as const;
      }),
    ).values(),
  ).toSorted((left, right) => left.label.localeCompare(right.label));
  const visibleRows = visibleDashboardRows(data, filters);
  return html`<section class="dashboards-gallery" aria-label=${titleForRoute("dashboards")}>
    <div class="dashboards-toolbar">
      <label class="dashboards-search">
        <span aria-hidden="true">${icons.search}</span>
        <span class="sr-only">${t("dashboardsPage.searchLabel")}</span>
        <input
          type="search"
          .value=${filters.query}
          placeholder=${t("dashboardsPage.searchPlaceholder")}
          @input=${(event: Event) => {
            if (event.currentTarget instanceof HTMLInputElement) {
              handlers.onQueryChange(event.currentTarget.value);
            }
          }}
        />
      </label>
      <label class="dashboards-select">
        <span>${t("dashboardsPage.authorFilter")}</span>
        <select
          .value=${filters.ownerId}
          @change=${(event: Event) => {
            if (event.currentTarget instanceof HTMLSelectElement) {
              handlers.onOwnerChange(event.currentTarget.value);
            }
          }}
        >
          <option value="">${t("dashboardsPage.allAuthors")}</option>
          ${owners.map((owner) => html`<option value=${owner.id}>${owner.label}</option>`)}
        </select>
      </label>
      <label class="dashboards-select">
        <span>${t("dashboardsPage.sortLabel")}</span>
        <select
          .value=${filters.sort}
          @change=${(event: Event) => {
            if (
              event.currentTarget instanceof HTMLSelectElement &&
              (event.currentTarget.value === "updated" || event.currentTarget.value === "title")
            ) {
              handlers.onSortChange(event.currentTarget.value);
            }
          }}
        >
          <option value="updated">${t("dashboardsPage.sortUpdated")}</option>
          <option value="title">${t("dashboardsPage.sortTitle")}</option>
        </select>
      </label>
    </div>
    <div class="dashboards-results" role="status">
      ${t("dashboardsPage.resultCount", { count: String(visibleRows.length) })}
    </div>
    ${
      visibleRows.length === 0
        ? html`<div class="dashboards-no-results" data-dashboards-no-results>
            <span aria-hidden="true">${icons.search}</span>
            <strong>${t("dashboardsPage.noResultsTitle")}</strong>
            <span>${t("dashboardsPage.noResultsDescription")}</span>
          </div>`
        : html`<div class="dashboards-grid">
            ${repeat(
              visibleRows,
              (row) => row.key,
              (row) => renderDashboardCard(data, row),
            )}
          </div>`
    }
  </section>`;
}

export function renderDashboards(
  data: DashboardsRouteData | undefined,
  onRetry: () => void,
  filters: DashboardGalleryFilters = DEFAULT_FILTERS,
  handlers: DashboardGalleryHandlers = NOOP_HANDLERS,
) {
  const body = data
    ? html`
        ${renderPanelRefreshStatus({
          status: {
            error: data.error,
            hasLoaded: data.result !== null,
            stale: data.result !== null && data.error !== null,
          },
          errorMessage: data.error
            ? t("dashboardsPage.loadError", { error: data.error })
            : undefined,
          onRetry,
        })}
        ${renderDashboardList(data, filters, handlers)}
      `
    : html`<section class="card" aria-busy="true">${t("common.loading")}</section>`;
  return html`
    <section class="content-header dashboards-header">
      <div>
        <div class="page-title">${titleForRoute("dashboards")}</div>
        <div class="page-subtitle">${t("subtitles.dashboards")}</div>
      </div>
      ${
        data?.result
          ? html`<div class="dashboards-header__count">
              <strong>${data.result.sessions.length}</strong>
              <span>${t("dashboardsPage.totalLabel")}</span>
            </div>`
          : nothing
      }
    </section>
    ${renderSettingsWorkspace(body)}
  `;
}
