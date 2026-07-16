import { html, nothing } from "lit";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import type {
  CatalogSessionContinuedDetail,
  CatalogSessionKey,
} from "../lib/sessions/catalog-key.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import { shouldHandleNavigationClick } from "./app-sidebar-nav-menus.ts";
import { sidebarSessionMetaId } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";

export function formatSidebarTimestamp(timestampMs: number | null | undefined): string {
  const value = formatRelativeTimestamp(timestampMs, { fallback: "" });
  if (value === "just now") {
    return "now";
  }
  return value.endsWith(" ago") ? value.slice(0, -" ago".length) : value;
}

/** Session keys already adopted into OpenClaw sessions; the regular list hides
    these so each adopted session stays a single selectable catalog row. */
export function adoptedCatalogSessionKeys(catalogs: readonly SessionCatalog[]): Set<string> {
  const keys = new Set<string>();
  for (const catalog of catalogs) {
    for (const host of catalog.hosts) {
      for (const session of host.sessions) {
        if (session.openClawSessionKey) {
          keys.add(session.openClawSessionKey);
        }
      }
    }
  }
  return keys;
}

export type CatalogBackingSessionDisplay = {
  label: string;
  subtitle?: string;
  meta: string;
  title: string;
};

export type CatalogSessionMenuRequest = {
  key: CatalogSessionKey;
  search: string;
  canOpenTerminal: boolean;
};

/** Stamps a freshly adopted session key onto its catalog row so the sidebar
    binds it before the next catalog poll confirms the adoption. */
export function bindAdoptedCatalogSession(
  catalogs: readonly SessionCatalog[],
  detail: CatalogSessionContinuedDetail,
): SessionCatalog[] {
  return catalogs.map((catalog) =>
    catalog.id === detail.catalogId
      ? {
          ...catalog,
          hosts: catalog.hosts.map((host) =>
            host.hostId === detail.hostId
              ? {
                  ...host,
                  sessions: host.sessions.map((session) =>
                    session.threadId === detail.threadId
                      ? { ...session, openClawSessionKey: detail.sessionKey }
                      : session,
                  ),
                }
              : host,
          ),
        }
      : catalog,
  );
}

type SessionCatalogGroupsParams = {
  catalogs: readonly SessionCatalog[];
  connected: boolean;
  basePath: string;
  routeSessionKey: string;
  newSessionAgentId: string;
  collapsedSections: ReadonlySet<string>;
  loadingMoreCatalogIds: ReadonlySet<string>;
  liveRows: readonly GatewaySessionRow[];
  renderLiveRow: (row: GatewaySessionRow, display: CatalogBackingSessionDisplay) => unknown;
  onToggleSection: (sectionId: string) => void;
  onLoadMore: (catalogId: string) => void;
  onOpenNewSession?: (agentId: string, target?: NewSessionTarget) => void;
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

function renderCatalogHeaderStatus(hasActiveRun: boolean, hasUnread: boolean) {
  if (hasActiveRun) {
    return html`<span
      class="session-run-spinner"
      role="img"
      aria-label=${t("sessionsView.activeRun")}
      title=${t("sessionsView.activeRun")}
    ></span>`;
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
    const visibleHosts = hosts.filter((host) => host.sessions.length > 0);
    const rows = visibleHosts.flatMap((host) =>
      host.sessions.map((session) => ({ host, session })),
    );
    const liveRows = rows.flatMap(({ session }) => {
      const row = session.openClawSessionKey
        ? liveRowsByKey.get(session.openClawSessionKey)
        : undefined;
      return row ? [row] : [];
    });
    const hasActiveRun = liveRows.some((row) => row.hasActiveRun === true);
    const hasUnread = liveRows.some((row) => row.unread === true);
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
    const errorHelp = `${errorMessage}. Configure native session discovery in Settings > Automation > Plugins.`;
    return html`
      <div class="sidebar-recent-sessions__group" data-session-section=${sectionId}>
        <div class="sidebar-recent-sessions__head">
          <button
            type="button"
            class="sidebar-session-group-toggle"
            aria-expanded=${String(!collapsed)}
            aria-label=${hasError ? `${catalog.label}: ${errorHelp}` : catalog.label}
            title=${hasError ? errorHelp : nothing}
            @click=${() => params.onToggleSection(sectionId)}
          >
            <span class="sidebar-session-group-toggle__icon" aria-hidden="true"
              >${collapsed ? icons.chevronRight : icons.chevronDown}</span
            >
            <span class="sidebar-recent-sessions__label-text">${catalog.label}</span>
            ${renderCatalogHeaderStatus(hasActiveRun, hasUnread)}
            <span
              class="sidebar-session-group-count ${hasError
                ? "sidebar-session-group-count--error"
                : ""}"
              data-session-catalog-error=${hasError ? catalog.id : nothing}
              aria-hidden="true"
              >${hasError ? icons.alertTriangle : rows.length}</span
            >
          </button>
          ${canCreateSession
            ? html`<button
                type="button"
                class="sidebar-session-sort sidebar-session-new sidebar-session-catalog-new"
                title=${`${t("chat.runControls.newSession")} — ${catalog.label}`}
                aria-label=${`${t("chat.runControls.newSession")} — ${catalog.label}`}
                ?disabled=${!params.connected}
                @click=${() =>
                  params.onOpenNewSession?.(params.newSessionAgentId, {
                    catalogId: catalog.id,
                  })}
              >
                ${icons.plus}
              </button>`
            : nothing}
        </div>
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

function renderCatalogHostGroup(
  catalog: SessionCatalog,
  host: SessionCatalogHost,
  liveRowsByKey: ReadonlyMap<string, GatewaySessionRow>,
  params: SessionCatalogGroupsParams,
) {
  const errorHelp = host.error ? `[${host.error.code}] ${host.error.message}` : undefined;
  return html`
    <section class="sidebar-session-catalog-host" data-session-catalog-host=${host.hostId}>
      <div
        class="sidebar-session-catalog-host__head"
        aria-label=${errorHelp ? `${host.label}: ${errorHelp}` : host.label}
        title=${errorHelp ?? host.label}
      >
        <span class="sidebar-session-catalog-host__label">${host.label}</span>
        <span
          class="sidebar-session-catalog-host__count ${host.error
            ? "sidebar-session-catalog-host__count--error"
            : ""}"
          aria-hidden="true"
          >${host.error ? icons.alertTriangle : host.sessions.length}</span
        >
      </div>
      <div class="sidebar-session-catalog-host__sessions" role="list" aria-label=${host.label}>
        ${host.sessions.map((session) =>
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
) {
  const rawTimestamp = session.recencyAt ?? session.updatedAt ?? session.createdAt;
  const timestamp =
    typeof rawTimestamp === "number" && rawTimestamp < 1_000_000_000_000
      ? rawTimestamp * 1000
      : rawTimestamp;
  const adoptedRow = session.openClawSessionKey
    ? liveRowsByKey.get(session.openClawSessionKey)
    : undefined;
  if (adoptedRow) {
    const label = session.name || session.threadId;
    return params.renderLiveRow(adoptedRow, {
      label,
      meta: formatSidebarTimestamp(timestamp),
      title: `${label} · ${host.label}`,
    });
  }
  const catalogKey = {
    catalogId: catalog.id,
    hostId: host.hostId,
    threadId: session.threadId,
  } satisfies CatalogSessionKey;
  const key = session.openClawSessionKey ?? buildCatalogSessionKey(catalogKey);
  const label = session.name || session.threadId;
  const meta = formatSidebarTimestamp(timestamp);
  const metaId = meta ? sidebarSessionMetaId(key) : undefined;
  const search = searchForSession(key);
  const href = `${pathForRoute("chat", params.basePath)}${search}`;
  const active = params.routeSessionKey !== "" && key === params.routeSessionKey;
  const canOpenTerminal = session.canOpenTerminal === true && params.terminalAvailable;
  const openTerminal = () => params.onOpenTerminal(catalogKey);
  const openMenu = (x: number, y: number, trigger?: HTMLElement) =>
    params.onOpenMenu(
      { key: catalogKey, search, canOpenTerminal: session.canOpenTerminal === true },
      x,
      y,
      trigger,
    );
  return html`
    <div
      class="sidebar-recent-session session-row-host ${active
        ? "sidebar-recent-session--active"
        : ""}"
      data-session-key=${key}
      role="listitem"
      @contextmenu=${(event: MouseEvent) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY);
      }}
    >
      <a
        href=${href}
        class="sidebar-recent-session__link"
        title=${`${label} · ${host.label}`}
        aria-current=${active ? "page" : nothing}
        aria-describedby=${metaId ?? nothing}
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          if (params.catalogOpenTarget === "terminal" && canOpenTerminal) {
            openTerminal();
          } else {
            params.onNavigate?.("chat", { search });
          }
        }}
      >
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__name hover-marquee">${label}</span>
        </span>
      </a>
      <span class="sidebar-recent-session__aside session-row-aside">
        <span class="session-row-trail" id=${metaId ?? nothing}>${meta}</span>
        <span class="session-row-actions">
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
            ${icons.moreHorizontal}
          </button>
        </span>
      </span>
    </div>
  `;
}
