import { html, nothing } from "lit";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { restSessionRow, revealSessionRow } from "../lib/session-row-reveal.ts";
import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import {
  groupCatalogSessionsByPerson,
  groupCatalogSessionsByProject,
  type CatalogProjectGrouping,
} from "../lib/sessions/catalog-project-grouping.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import {
  formatSidebarTimestamp,
  type CatalogBackingSessionDisplay,
  type CatalogSessionMenuRequest,
  visibleCatalogHosts,
} from "./app-sidebar-session-catalogs.ts";
import {
  renderSidebarSessionSectionHeader,
  renderSidebarSessionSectionToggle,
  SIDEBAR_SECTION_NO_STATUS,
  type SidebarSectionStatus,
} from "./app-sidebar-session-section-header.ts";
import { sidebarSessionStateId } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { hasProviderBrandIcon, renderProviderBrandIcon } from "./provider-icon.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";
import { renderSessionRowEndcap } from "./session-row-endcap.ts";

type SessionCatalogGroupsParams = {
  catalogs: readonly SessionCatalog[];
  connected: boolean;
  basePath: string;
  routeSessionKey: string;
  newSessionAgentId: string;
  mainKey: string;
  collapsedSections: ReadonlySet<string>;
  loadingMoreCatalogIds: ReadonlySet<string>;
  projectGrouping: CatalogProjectGrouping;
  liveRows: readonly GatewaySessionRow[];
  creatorId?: string | null;
  renderLiveRow: (row: GatewaySessionRow, display: CatalogBackingSessionDisplay) => unknown;
  onToggleSection: (sectionId: string) => void;
  draggingSectionId: string | null;
  sectionDropTarget: { sectionId: string; position: "before" | "after" } | null;
  onSectionDragOver: (event: DragEvent, sectionId: string) => void;
  onSectionDragLeave: (event: DragEvent, sectionId: string) => void;
  onSectionDrop: (event: DragEvent, sectionId: string) => void;
  onStartSectionDrag: (sectionId: string) => void;
  onFinishSectionDrag: () => void;
  viewMenuOpenCatalogId: string | null;
  creatorFilterActive: boolean;
  onOpenViewMenu: (
    catalogId: string,
    trigger: HTMLElement,
    position?: { x: number; y: number },
  ) => void;
  onLoadMore: (catalogId: string) => void;
  onOpenNewSession?: (agentId: string, target?: NewSessionTarget) => void;
  newSessionDisabledReason?: string;
  sectionDragDisabledReason?: string;
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  catalogOpenTarget: "viewer" | "terminal";
  terminalAvailable: boolean;
  onOpenTerminal: (key: CatalogSessionKey) => void;
  onOpenMenu: (
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger?: HTMLElement,
  ) => void;
};

function catalogHeaderStatus(params: {
  errorHelp: string | undefined;
  hasActiveRun: boolean;
  hasUnread: boolean;
}): SidebarSectionStatus {
  if (params.errorHelp) {
    return { kind: "error", label: params.errorHelp };
  }
  if (params.hasActiveRun) {
    return { kind: "running", label: t("sessionsView.activeRun") };
  }
  return params.hasUnread
    ? { kind: "unread", label: t("sessionsView.unread") }
    : SIDEBAR_SECTION_NO_STATUS;
}

function catalogErrorMessages(catalog: SessionCatalog): string[] {
  const messages = new Set<string>();
  const add = (error: SessionCatalog["error"]) => {
    if (error) {
      messages.add(`[${error.code}] ${error.message}`);
    }
  };
  add(catalog.error);
  for (const host of catalog.hosts) {
    // A disconnected empty host is normal fleet state, not a provider failure.
    // Cached rows still expose the host-level offline badge when the host is visible.
    if (host.error?.code !== "NODE_OFFLINE") {
      add(host.error);
    }
  }
  return [...messages];
}

export function renderSessionCatalogGroups(params: SessionCatalogGroupsParams) {
  // Adopted rows reuse the live session row so activity, unread state, and
  // the session menu behave exactly like the regular list.
  const liveRowsByKey = new Map<string, GatewaySessionRow>();
  for (const row of params.liveRows) {
    if (!liveRowsByKey.has(row.key)) {
      liveRowsByKey.set(row.key, row);
    }
  }
  return params.catalogs.map((catalog) => {
    const sectionId = `catalog:${catalog.id}`;
    const collapsed = params.collapsedSections.has(sectionId);
    const hosts = catalog.hosts;
    // Catalog providers own host identity; the sidebar only removes hosts with no visible rows.
    const visibleHosts = visibleCatalogHosts(hosts, params.creatorId);
    const rows = visibleHosts.flatMap((host) =>
      host.sessions.map((session) => ({ host, session })),
    );
    const liveRows = rows.flatMap(({ session }) => {
      const row = session.sessionKey ? liveRowsByKey.get(session.sessionKey) : undefined;
      return row ? [row] : [];
    });
    const hasActiveRun = liveRows.some((row) => row.hasActiveRun === true);
    const hasUnread = liveRows.some((row) => row.unread === true);
    const hasBrandIcon = hasProviderBrandIcon(catalog.id);
    const loadingMore = params.loadingMoreCatalogIds.has(catalog.id);
    const hasMore = hosts.some((host) => Boolean(host.nextCursor));
    const canCreateSession = catalog.capabilities.createSession !== undefined;
    const errorMessages = catalogErrorMessages(catalog);
    const hasError = errorMessages.length > 0;
    // Keep provider failures distinguishable from successful empty results.
    // Hiding both states would silently mask unavailable session sources.
    if (rows.length === 0 && !hasMore && !hasError && !catalog.capabilities.createSession) {
      return nothing;
    }
    const errorMessage = errorMessages.join("; ");
    const errorHelp = t("chat.sidebar.catalogDiscoveryHelp", { error: errorMessage });
    const headerStatus = catalogHeaderStatus({
      errorHelp: hasError ? errorHelp : undefined,
      hasActiveRun,
      hasUnread,
    });
    const sectionClass = [
      "sidebar-recent-sessions__group",
      "sidebar-recent-sessions__group--zone-coding",
      collapsed ? "sidebar-recent-sessions__group--collapsed" : "",
      params.draggingSectionId === sectionId ? "sidebar-recent-sessions__group--dragging" : "",
      params.sectionDropTarget?.sectionId === sectionId
        ? `sidebar-recent-sessions__group--section-drop-${params.sectionDropTarget.position}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`
      <div
        class=${sectionClass}
        data-session-section=${sectionId}
        @dragover=${params.sectionDragDisabledReason
          ? nothing
          : (event: DragEvent) => params.onSectionDragOver(event, sectionId)}
        @dragleave=${params.sectionDragDisabledReason
          ? nothing
          : (event: DragEvent) => params.onSectionDragLeave(event, sectionId)}
        @drop=${params.sectionDragDisabledReason
          ? nothing
          : (event: DragEvent) => params.onSectionDrop(event, sectionId)}
      >
        ${renderSidebarSessionSectionHeader({
          sectionId,
          status: headerStatus,
          disabledReason: params.sectionDragDisabledReason,
          onToggle: () => params.onToggleSection(sectionId),
          onStartDrag: params.onStartSectionDrag,
          onFinishDrag: params.onFinishSectionDrag,
          onContextMenu: (event) => {
            event.preventDefault();
            const header = event.currentTarget as HTMLElement;
            const trigger =
              header.querySelector<HTMLElement>("[data-session-catalog-view-menu]") ?? header;
            params.onOpenViewMenu(catalog.id, trigger, {
              x: event.clientX,
              y: event.clientY,
            });
          },
          content: html`
            ${renderSidebarSessionSectionToggle({
              label: catalog.label,
              collapsed,
              status: headerStatus,
              // The status dot beside this toggle already carries the failure as
              // its accessible name; repeating it here makes a screen reader
              // announce the whole catalog error twice for one heading.
              ariaLabel: catalog.label,
              title: hasError ? errorHelp : undefined,
              count: collapsed ? rows.length : undefined,
              lead: hasBrandIcon
                ? html`<span class="sidebar-session-group-toggle__lead" aria-hidden="true"
                    >${renderProviderBrandIcon(catalog.id, {
                      className: "sidebar-session-catalog-provider-icon",
                    })}</span
                  >`
                : undefined,
              onToggle: () => params.onToggleSection(sectionId),
            })}
            <button
              type="button"
              class="sidebar-session-group-actions sidebar-session-sort sidebar-session-catalog-grouping ${params.creatorFilterActive
                ? "sidebar-session-sort--filtered"
                : ""}"
              data-session-catalog-view-menu=${catalog.id}
              title=${t("chat.sidebar.catalogViewOptions")}
              aria-label=${t("chat.sidebar.catalogViewOptions")}
              aria-haspopup="menu"
              aria-expanded=${String(params.viewMenuOpenCatalogId === catalog.id)}
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                params.onOpenViewMenu(catalog.id, event.currentTarget as HTMLElement);
              }}
            >
              ${icons.listFilter}
            </button>
            ${canCreateSession
              ? html`<button
                  type="button"
                  class="sidebar-session-group-actions sidebar-session-new sidebar-session-catalog-new"
                  title=${params.newSessionDisabledReason ??
                  `${t("chat.runControls.newSession")} — ${catalog.label}`}
                  aria-label=${`${t("chat.runControls.newSession")} — ${catalog.label}`}
                  ?disabled=${Boolean(params.newSessionDisabledReason)}
                  @click=${() =>
                    params.onOpenNewSession?.(params.newSessionAgentId, {
                      catalogId: catalog.id,
                    })}
                >
                  ${icons.plus}
                </button>`
              : nothing}
          `,
        })}
        ${collapsed
          ? nothing
          : html`<div class="sidebar-recent-sessions__list">
                ${visibleHosts.map((host) =>
                  renderCatalogHostGroup(catalog, host, liveRowsByKey, params),
                )}
              </div>
              ${hasMore
                ? html`<button
                    type="button"
                    class="sidebar-session-catalog-load-more"
                    data-session-catalog-load-more=${catalog.id}
                    ?disabled=${loadingMore}
                    aria-busy=${String(loadingMore)}
                    @click=${() => params.onLoadMore(catalog.id)}
                  >
                    ${t("chat.selectors.loadMoreSessions")}
                  </button>`
                : nothing}`}
      </div>
    `;
  });
}

export type SessionCatalogGroupsRenderer = typeof renderSessionCatalogGroups;

function renderCatalogHostGroup(
  catalog: SessionCatalog,
  host: SessionCatalogHost,
  liveRowsByKey: ReadonlyMap<string, GatewaySessionRow>,
  params: SessionCatalogGroupsParams,
) {
  const errorHelp = host.error ? `[${host.error.code}] ${host.error.message}` : undefined;
  const projectGroups =
    params.projectGrouping === "project"
      ? groupCatalogSessionsByProject(host.sessions)
      : params.projectGrouping === "person"
        ? groupCatalogSessionsByPerson(host.sessions)
        : null;
  // Gateway errors stay on the catalog header; node headings remain so remote rows keep their owner.
  const showHostHeading = host.kind !== "gateway";
  return html`
    <section class="sidebar-session-catalog-host" data-session-catalog-host=${host.hostId}>
      ${showHostHeading
        ? html`<div
            class="sidebar-session-catalog-host__head"
            aria-label=${errorHelp ? `${host.label}: ${errorHelp}` : host.label}
            title=${errorHelp ?? host.label}
          >
            <span class="sidebar-session-catalog-host__label">${host.label}</span>
            ${host.error
              ? html`<span
                  class="sidebar-session-group-status sidebar-session-group-status--error"
                  data-section-status="error"
                  role="img"
                  aria-label=${errorHelp!}
                ></span>`
              : html`<span class="sidebar-session-catalog-host__count" aria-hidden="true"
                  >${host.sessions.length}</span
                >`}
          </div>`
        : nothing}
      <div class="sidebar-session-catalog-host__sessions" role="list" aria-label=${host.label}>
        ${projectGroups
          ? html`${projectGroups.groups.map((group) => {
              const sectionId = `catalog-project:${catalog.id}:${host.hostId}:${group.key}`;
              const collapsed = params.collapsedSections.has(sectionId);
              return html`
                <div
                  class="sidebar-session-catalog-project"
                  data-session-catalog-project=${group.key}
                  role="listitem"
                >
                  ${renderSidebarSessionSectionToggle({
                    label: group.label,
                    collapsed,
                    status: SIDEBAR_SECTION_NO_STATUS,
                    className: "sidebar-session-catalog-project__head",
                    labelClassName: "sidebar-session-catalog-project__label",
                    title: group.title,
                    count: group.sessions.length,
                    onToggle: () => params.onToggleSection(sectionId),
                  })}
                  ${collapsed
                    ? nothing
                    : html`<div
                        class="sidebar-session-catalog-project__sessions"
                        role="list"
                        aria-label=${`${host.label}: ${group.label}`}
                      >
                        ${group.sessions.map((session) =>
                          renderCatalogSessionRow(
                            catalog,
                            host,
                            session,
                            liveRowsByKey,
                            params,
                            true,
                          ),
                        )}
                      </div>`}
                </div>
              `;
            })}
            ${projectGroups.ungrouped.map((session) =>
              renderCatalogSessionRow(catalog, host, session, liveRowsByKey, params),
            )}`
          : host.sessions.map((session) =>
              renderCatalogSessionRow(catalog, host, session, liveRowsByKey, params),
            )}
      </div>
    </section>
  `;
}

function renderCatalogSessionRow(
  catalog: SessionCatalog,
  host: SessionCatalogHost,
  session: SessionCatalogSession,
  liveRowsByKey: ReadonlyMap<string, GatewaySessionRow>,
  params: SessionCatalogGroupsParams,
  projectChild = false,
) {
  const rawTimestamp = session.recencyAt ?? session.updatedAt ?? session.createdAt;
  const timestamp =
    typeof rawTimestamp === "number" && rawTimestamp < 1_000_000_000_000
      ? rawTimestamp * 1000
      : rawTimestamp;
  const adoptedRow = session.sessionKey ? liveRowsByKey.get(session.sessionKey) : undefined;
  if (adoptedRow) {
    const label = session.name || session.threadId;
    return params.renderLiveRow(adoptedRow, {
      label,
      meta: formatSidebarTimestamp(timestamp),
      title: `${label} · ${host.label}`,
      ...(session.pullRequest ? { pullRequest: session.pullRequest } : {}),
    });
  }
  const catalogKey = {
    catalogId: catalog.id,
    hostId: host.hostId,
    threadId: session.threadId,
  } satisfies CatalogSessionKey;
  const key = session.sessionKey ?? buildCatalogSessionKey(catalogKey);
  const label = session.name || session.threadId;
  const meta = formatSidebarTimestamp(timestamp);
  const routeId = "chat";
  const target = sessionNavigationTarget({
    face: routeId,
    sessionKey: key,
    fallbackAgentId: params.newSessionAgentId,
    basePath: params.basePath,
    mainKey: params.mainKey,
  });
  const { href, options: navigation } = target;
  const active = params.routeSessionKey !== "" && key === params.routeSessionKey;
  const running = session.status === "active" || session.status === "running";
  const stateDescription = running ? t("sessionsView.activeRun") : "";
  const stateId = running ? sidebarSessionStateId(key) : undefined;
  const canOpenTerminal = session.canOpenTerminal === true && params.terminalAvailable;
  const openTerminal = () => params.onOpenTerminal(catalogKey);
  const openMenu = (x: number, y: number, trigger?: HTMLElement) =>
    params.onOpenMenu(
      {
        key: catalogKey,
        routeId,
        navigation,
        canOpenTerminal: session.canOpenTerminal === true,
        meta,
      },
      x,
      y,
      trigger,
    );
  const openMenuFromEvent = (event: MouseEvent | KeyboardEvent) =>
    handleContextMenuEvent(
      event,
      event instanceof KeyboardEvent
        ? (event.currentTarget as HTMLElement).querySelector("[data-catalog-session-menu]")
        : null,
      (trigger, x, y) => openMenu(x, y, trigger ?? undefined),
    );
  return html`
    <div
      class="sidebar-recent-session session-row-host ${active
        ? "sidebar-recent-session--active"
        : ""} ${projectChild ? "sidebar-recent-session--catalog-project-child" : ""} ${running
        ? "session-row-host--running"
        : ""}"
      data-session-key=${key}
      role="listitem"
      @contextmenu=${openMenuFromEvent}
      @keydown=${openMenuFromEvent}
      @mouseenter=${(event: MouseEvent) => revealSessionRow(event.currentTarget as HTMLElement)}
      @mouseleave=${(event: MouseEvent) =>
        restSessionRow(event.currentTarget as HTMLElement, event.relatedTarget as Node | null)}
      @focusin=${(event: FocusEvent) => revealSessionRow(event.currentTarget as HTMLElement)}
      @focusout=${(event: FocusEvent) =>
        restSessionRow(event.currentTarget as HTMLElement, event.relatedTarget as Node | null)}
    >
      <a
        href=${href}
        class="sidebar-recent-session__link"
        title=${[`${label} · ${host.label}`, stateDescription].filter(Boolean).join(" · ")}
        aria-current=${active ? "page" : nothing}
        aria-describedby=${stateId ?? nothing}
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          if (params.catalogOpenTarget === "terminal" && canOpenTerminal) {
            openTerminal();
          } else {
            params.onNavigate?.(routeId, navigation);
          }
        }}
      >
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__title">
            <span class="sidebar-recent-session__name hover-marquee">${label}</span>
          </span>
        </span>
        ${renderSessionRowBadges({
          hasAutomation: false,
          pullRequest: session.pullRequest,
        })}
      </a>
      ${renderSessionRowEndcap({
        state: running ? { kind: "running" } : { kind: "none" },
        stateId,
        actions: html`<span class="session-row-actions">
          <button
            class="session-action"
            data-catalog-session-menu="true"
            type="button"
            title=${t("chat.sidebar.openSessionMenu")}
            aria-label=${t("chat.sidebar.openSessionMenu")}
            aria-haspopup="menu"
            @click=${(event: MouseEvent) => {
              event.stopPropagation();
              const trigger = event.currentTarget as HTMLElement;
              const rect = trigger.getBoundingClientRect();
              openMenu(rect.right, rect.bottom + 4, trigger);
            }}
          >
            ${icons.ellipsis}
          </button>
        </span>`,
      })}
    </div>
  `;
}
