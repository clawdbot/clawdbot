import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import { normalizeSessionColorValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { withSidebarNavCollapseIntent } from "../app-session-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  restartHoverMarqueeIfHovered,
  startHoverMarqueeFromEvent,
  stopHoverMarqueeFromEvent,
} from "../lib/hover-marquee.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { isSessionRunActive } from "../lib/session-run-state.ts";
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
  normalizeCatalogTimestamp,
  type CatalogBackingSessionDisplay,
  type CatalogSessionMenuRequest,
  visibleCatalogHosts,
} from "./app-sidebar-session-catalogs.ts";
import { renderSidebarSessionSectionHeader } from "./app-sidebar-session-section-header.ts";
import { sidebarSessionStateId } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { renderNewSessionLink } from "./new-session-link.ts";
import { hasProviderBrandIcon, renderProviderBrandIcon } from "./provider-icon.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";

type SessionCatalogGroupsParams = {
  catalogs: readonly SessionCatalog[];
  connected: boolean;
  basePath: string;
  routeSessionKey: string;
  newSessionAgentId: string;
  mainKey: string;
  collapsedSections: ReadonlySet<string>;
  loadingMoreCatalogIds: ReadonlySet<string>;
  visibleSessionLimits: ReadonlyMap<string, number>;
  projectGrouping: CatalogProjectGrouping;
  liveRows: readonly GatewaySessionRow[];
  ownerId?: string | null;
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
  ownerFilterActive: boolean;
  onOpenViewMenu: (
    catalogId: string,
    trigger: HTMLElement,
    position?: { x: number; y: number },
  ) => void;
  onLoadMore: (catalogId: string) => void;
  onSetVisibleSessionLimit: (sectionId: string, limit: number) => void;
  onOpenNewSession?: (agentId: string, target?: NewSessionTarget) => void;
  newSessionDisabledReason?: string;
  sectionDragDisabledReason?: string;
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  catalogOpenTarget: "viewer" | "terminal";
  terminalAvailable: boolean;
  onOpenTerminal: (key: CatalogSessionKey, agentId: string) => void;
  onOpenMenu: (
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger?: HTMLElement,
  ) => void;
  onCatalogMenuTriggerRendered: (key: CatalogSessionKey, element: Element | undefined) => void;
  isMenuOpen: (key: CatalogSessionKey) => boolean;
};

const CATALOG_SESSION_GROUP_LIMIT = 5;

const CATALOG_CONTROL_SELECTORS = [
  ".sidebar-recent-session__link",
  "[data-child-session-toggle]",
  "[data-sidebar-session-pin]",
  "[data-catalog-session-menu], [data-session-menu]",
] as const;

function catalogRowRef(
  identityKey: string,
  sessionKey: string,
  catalogKey: CatalogSessionKey,
  menuOpen: boolean,
  params: SessionCatalogGroupsParams,
): ((element: Element | undefined) => void) | undefined {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activeRow = active?.closest<HTMLElement>("[data-session-key]");
  const selector = CATALOG_CONTROL_SELECTORS.find((candidate) => active?.matches(candidate));
  const restoreFocus =
    selector !== undefined &&
    (activeRow?.dataset.catalogSessionKey === identityKey ||
      activeRow?.dataset.sessionKey === identityKey ||
      activeRow?.dataset.sessionKey === sessionKey);
  if (!menuOpen && !restoreFocus) {
    return undefined;
  }
  return (element) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    if (menuOpen) {
      params.onCatalogMenuTriggerRendered(
        catalogKey,
        element.querySelector(CATALOG_CONTROL_SELECTORS[3]) ?? undefined,
      );
    }
    if (restoreFocus) {
      queueMicrotask(() => {
        if (element.isConnected && document.activeElement === document.body) {
          element.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
        }
      });
    }
  };
}

function renderSessionRunSpinner(showTitle = true) {
  return html`<span
    class="session-run-spinner"
    role="img"
    aria-label=${t("sessionsView.activeRun")}
    title=${showTitle ? t("sessionsView.activeRun") : nothing}
  ></span>`;
}

function renderCatalogHeaderStatus(hasActiveRun: boolean, hasUnread: boolean) {
  if (hasActiveRun) {
    return renderSessionRunSpinner();
  }
  return hasUnread
    ? html`<span
        class="session-unread-dot"
        role="img"
        aria-label=${t("sessionsView.unread")}
      ></span>`
    : nothing;
}

function catalogErrorMessages(catalog: SessionCatalog): string[] {
  const messages = new Set<string>();
  const add = (error: SessionCatalog["error"]) => {
    if (error) {
      messages.add(formatUiError(`[${error.code}] ${error.message}`));
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
  // Adopted rows use canonical local labels and title snapshots; native catalog
  // refreshes must not rename them or replace the regular session presentation.
  const liveRowsByKey = new Map<string, GatewaySessionRow>();
  const liveOwnerIdBySessionKey = new Map<string, string | undefined>();
  for (const row of params.liveRows) {
    if (!liveRowsByKey.has(row.key)) {
      liveRowsByKey.set(row.key, row);
      liveOwnerIdBySessionKey.set(row.key, row.owner?.actor.id);
    }
  }
  return params.catalogs.map((catalog) => {
    const sectionId = `catalog:${catalog.id}`;
    const collapsed = params.collapsedSections.has(sectionId);
    const hosts = catalog.hosts;
    // Catalog providers own host identity; the sidebar only removes hosts with no visible rows.
    const visibleHosts = visibleCatalogHosts(hosts, params.ownerId, liveOwnerIdBySessionKey);
    const rows = visibleHosts.flatMap((host) =>
      host.sessions.map((session) => ({ host, session })),
    );
    const liveRows = rows.flatMap(({ session }) => {
      const row = session.sessionKey ? liveRowsByKey.get(session.sessionKey) : undefined;
      return row ? [row] : [];
    });
    const hasActiveRun = liveRows.some(isSessionRunActive);
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
          disabledReason: params.sectionDragDisabledReason,
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
            <button
              type="button"
              class="sidebar-session-group-toggle"
              aria-expanded=${String(!collapsed)}
              aria-label=${hasError ? `${catalog.label}: ${errorHelp}` : catalog.label}
              title=${hasError ? errorHelp : nothing}
              @click=${() => params.onToggleSection(sectionId)}
            >
              <span
                class="sidebar-session-group-toggle__lead ${hasBrandIcon
                  ? "sidebar-session-group-toggle__lead--branded"
                  : ""}"
                aria-hidden="true"
              >
                ${hasBrandIcon
                  ? renderProviderBrandIcon(catalog.id, {
                      className: "sidebar-session-catalog-provider-icon",
                    })
                  : nothing}
                <span class="sidebar-session-group-toggle__icon"
                  >${collapsed ? icons.chevronRight : icons.chevronDown}</span
                >
              </span>
              <span class="sidebar-recent-sessions__label-text hover-marquee"
                >${catalog.label}</span
              >
              ${renderCatalogHeaderStatus(hasActiveRun, hasUnread)}
              ${hasError || (collapsed && rows.length > 0)
                ? html`<span
                    class="sidebar-session-group-count ${hasError
                      ? "sidebar-session-group-count--error"
                      : ""}"
                    data-session-catalog-error=${hasError ? catalog.id : nothing}
                    aria-hidden="true"
                    >${hasError ? icons.alertTriangle : rows.length}</span
                  >`
                : nothing}
            </button>
            <button
              type="button"
              class="sidebar-session-group-actions sidebar-session-sort sidebar-session-catalog-grouping ${params.ownerFilterActive
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
              ? renderNewSessionLink({
                  basePath: params.basePath,
                  agentId: params.newSessionAgentId,
                  target: { catalogId: catalog.id },
                  className:
                    "sidebar-session-group-actions sidebar-session-new sidebar-session-catalog-new",
                  label: `${t("chat.runControls.newSession")} — ${catalog.label}`,
                  disabledReason: params.newSessionDisabledReason,
                  onOpen: params.onOpenNewSession,
                })
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
  const errorHelp = host.error
    ? formatUiError(`[${host.error.code}] ${host.error.message}`)
    : undefined;
  const projectGroups =
    params.projectGrouping === "project"
      ? groupCatalogSessionsByProject(host.sessions)
      : params.projectGrouping === "person"
        ? groupCatalogSessionsByPerson(host.sessions)
        : null;
  const renderRows = (sessions: readonly SessionCatalogSession[], projectChild = false) =>
    repeat(
      sessions,
      (session) =>
        buildCatalogSessionKey({
          catalogId: catalog.id,
          hostId: host.hostId,
          threadId: session.threadId,
        }),
      (session) =>
        renderCatalogSessionRow(catalog, host, session, liveRowsByKey, params, projectChild),
    );
  const renderVisibleRows = (
    sessions: readonly SessionCatalogSession[],
    sectionId: string,
    projectChild = false,
  ) => {
    const expanded =
      (params.visibleSessionLimits.get(sectionId) ?? CATALOG_SESSION_GROUP_LIMIT) >
      CATALOG_SESSION_GROUP_LIMIT;
    return renderRows(
      expanded ? sessions : sessions.slice(0, CATALOG_SESSION_GROUP_LIMIT),
      projectChild,
    );
  };
  const renderPagination = (sessions: readonly SessionCatalogSession[], sectionId: string) => {
    if (sessions.length <= CATALOG_SESSION_GROUP_LIMIT) {
      return nothing;
    }
    const visibleLimit = params.visibleSessionLimits.get(sectionId) ?? CATALOG_SESSION_GROUP_LIMIT;
    const expanded = visibleLimit > CATALOG_SESSION_GROUP_LIMIT;
    const label = expanded ? t("chat.messages.showLess") : t("chat.messages.showMore");
    return html`<div class="sidebar-session-pagination sidebar-session-pagination--catalog">
      <button
        type="button"
        class="sidebar-session-pagination__button"
        aria-label=${label}
        @click=${() =>
          params.onSetVisibleSessionLimit(
            sectionId,
            expanded ? CATALOG_SESSION_GROUP_LIMIT : sessions.length,
          )}
      >
        ${label}
      </button>
    </div>`;
  };
  const flatSessions = projectGroups?.ungrouped ?? host.sessions;
  const flatSectionId = projectGroups
    ? `catalog-${params.projectGrouping}-ungrouped:${catalog.id}:${host.hostId}`
    : `catalog-host:${catalog.id}:${host.hostId}`;
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
            <span class="sidebar-session-group-toggle__lead" aria-hidden="true">
              <span class="sidebar-session-group-toggle__icon">${icons.monitor}</span>
            </span>
            <span class="sidebar-session-catalog-host__label">${host.label}</span>
            <span
              class="sidebar-session-catalog-host__count ${host.error
                ? "sidebar-session-catalog-host__count--error"
                : ""}"
              aria-hidden="true"
              >${host.error ? icons.alertTriangle : host.sessions.length}</span
            >
          </div>`
        : nothing}
      <div class="sidebar-session-catalog-host__sessions" role="list" aria-label=${host.label}>
        ${projectGroups
          ? html`${repeat(
              projectGroups.groups,
              (group) => group.key,
              (group) => {
                const sectionId = `catalog-${group.kind}:${catalog.id}:${host.hostId}:${group.key}`;
                const legacySectionId = group.legacySectionKey
                  ? `catalog-project:${catalog.id}:${host.hostId}:${group.legacySectionKey}`
                  : null;
                const collapsedSectionId = params.collapsedSections.has(sectionId)
                  ? sectionId
                  : legacySectionId && params.collapsedSections.has(legacySectionId)
                    ? legacySectionId
                    : null;
                const collapsed = collapsedSectionId !== null;
                return html`
                  <div class="sidebar-session-catalog-project" role="listitem">
                    <button
                      type="button"
                      class="sidebar-session-catalog-project__head"
                      data-session-catalog-project=${group.key}
                      aria-expanded=${String(!collapsed)}
                      title=${group.title}
                      @click=${() => params.onToggleSection(collapsedSectionId ?? sectionId)}
                    >
                      <span class="sidebar-session-catalog-project__icon" aria-hidden="true"
                        >${collapsed ? icons.chevronRight : icons.chevronDown}</span
                      >
                      <span class="sidebar-session-catalog-project__label">${group.label}</span>
                      <span class="sidebar-session-catalog-project__count" aria-hidden="true"
                        >${group.sessions.length}</span
                      >
                    </button>
                    ${collapsed
                      ? nothing
                      : html`<div
                            class="sidebar-session-catalog-project__sessions"
                            role="list"
                            aria-label=${`${host.label}: ${group.label}`}
                          >
                            ${renderVisibleRows(group.sessions, sectionId, true)}
                          </div>
                          ${renderPagination(group.sessions, sectionId)}`}
                  </div>
                `;
              },
            )}
            ${renderVisibleRows(flatSessions, flatSectionId)}`
          : renderVisibleRows(flatSessions, flatSectionId)}
      </div>
      ${renderPagination(flatSessions, flatSectionId)}
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
  const timestamp = normalizeCatalogTimestamp(
    session.recencyAt ?? session.updatedAt ?? session.createdAt,
  );
  const catalogKey = {
    catalogId: catalog.id,
    hostId: host.hostId,
    threadId: session.threadId,
  } satisfies CatalogSessionKey;
  const identityKey = buildCatalogSessionKey(catalogKey);
  const key = session.sessionKey ?? buildCatalogSessionKey(catalogKey, params.newSessionAgentId);
  const menuOpen = params.isMenuOpen(catalogKey);
  const rowRef = catalogRowRef(identityKey, key, catalogKey, menuOpen, params);
  const adoptedRow = session.sessionKey ? liveRowsByKey.get(session.sessionKey) : undefined;
  if (adoptedRow) {
    return params.renderLiveRow(adoptedRow, {
      catalogIdentityKey: identityKey,
      catalogMenuOpen: menuOpen,
      ...(rowRef ? { rowRef } : {}),
      ...(session.pullRequest ? { pullRequest: session.pullRequest } : {}),
    });
  }
  const label = session.name || session.threadId;
  const meta = formatSidebarTimestamp(timestamp);
  const color = normalizeSessionColorValue(session.color ?? "");
  const routeId = "chat";
  const target = sessionNavigationTarget({
    face: routeId,
    sessionKey: key,
    fallbackAgentId: params.newSessionAgentId,
    basePath: params.basePath,
    mainKey: params.mainKey,
  });
  const { href, options: navigation } = target;
  const active = key === params.routeSessionKey;
  const running = session.status === "active" || session.status === "running";
  const stateDescription = running ? t("sessionsView.activeRun") : "";
  const stateId = running ? sidebarSessionStateId(key) : undefined;
  const canOpenTerminal = session.canOpenTerminal === true && params.terminalAvailable;
  const openTerminal = () => params.onOpenTerminal(catalogKey, params.newSessionAgentId);
  const openMenu = (x: number, y: number, trigger?: HTMLElement) =>
    params.onOpenMenu(
      {
        key: catalogKey,
        agentId: params.newSessionAgentId,
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
  const marqueeLabel = keyed(
    JSON.stringify([label, session.status, session.pullRequest]),
    html`<span
      ${ref(restartHoverMarqueeIfHovered)}
      class="sidebar-recent-session__name hover-marquee"
      >${label}</span
    >`,
  );
  return html`
    <div
      ${rowRef ? ref(rowRef) : nothing}
      class="sidebar-recent-session session-row-host sidebar-recent-session--single-line ${color
        ? "sidebar-recent-session--colored"
        : ""} ${active ? "sidebar-recent-session--active" : ""} ${projectChild
        ? "sidebar-recent-session--catalog-project-child"
        : ""} ${running ? "session-row-host--running" : ""}"
      style=${color ? `--session-color: var(--session-color-${color})` : nothing}
      data-session-key=${key}
      data-catalog-session-key=${identityKey}
      data-session-row-action-count="1"
      role="listitem"
      @contextmenu=${openMenuFromEvent}
      @keydown=${openMenuFromEvent}
      @mouseenter=${startHoverMarqueeFromEvent}
      @mouseleave=${stopHoverMarqueeFromEvent}
    >
      <a
        href=${withSidebarNavCollapseIntent(href)}
        class="sidebar-recent-session__link"
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
        <span class="sidebar-session-indicator"></span>
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__title-row"> ${marqueeLabel} </span>
          <span class="sidebar-recent-session__details">
            <span class="sidebar-recent-session__details-endcap">
              ${renderSessionRowBadges({
                pullRequest: session.pullRequest,
              })}
              ${running
                ? html`<span class="session-row-aside">
                    <span
                      class="session-row-state"
                      id=${stateId}
                      role="img"
                      aria-label=${stateDescription}
                      >${renderSessionRunSpinner(false)}</span
                    >
                  </span>`
                : nothing}
            </span>
          </span>
        </span>
      </a>
      <span class="sidebar-recent-session__aside session-row-aside">
        <span class="session-row-actions">
          <button
            class="session-action"
            data-catalog-session-menu="true"
            type="button"
            title=${t("chat.sidebar.openSessionMenu")}
            aria-label=${t("chat.sidebar.openSessionMenu")}
            aria-haspopup="menu"
            aria-expanded=${String(menuOpen)}
            @click=${(event: MouseEvent) => {
              event.stopPropagation();
              const trigger = event.currentTarget as HTMLElement;
              const rect = trigger.getBoundingClientRect();
              openMenu(rect.right, rect.bottom + 4, trigger);
            }}
          >
            ${icons.moreHorizontal}
          </button>
        </span>
      </span>
    </div>
  `;
}
