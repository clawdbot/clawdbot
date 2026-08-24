import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
// Dedicated sidebar for the full-page settings takeover (see app-host.ts).
import { html, nothing } from "lit";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import {
  cancelRoutePreload,
  isSettingsNavigationRouteVisible,
  navigationIconForRoute,
  scheduleRoutePreload,
  SETTINGS_SEARCHABLE_SUBPAGE_ROUTES,
  settingsNavigationLabelForRoute,
  settingsNavigationOwnerRoute,
  settingsSearchTextMatches,
  subtitleForRoute,
  titleForRoute,
  visibleSettingsNavigationGroups,
  type SettingsSearchBlock,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import type { ApplicationStatusBanner } from "../app/update-overlay-helpers.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { findSettingsSearchBlocks } from "../pages/config/settings-search.ts";
import { icons } from "./icons.ts";
import { redactLoginFailureError } from "./login-gate.ts";
import { renderOfflineSidebarStatus } from "./session-row-badges.ts";
import type { SettingsSaveIndicatorProps } from "./settings-save-indicator.ts";
import "./settings-save-indicator.ts";
import "./sidebar-build-chip.ts";

type SettingsSidebarProps = {
  basePath: string;
  activeRouteId: RouteId;
  activePathname?: string;
  activeSearch?: string;
  activeHash?: string;
  offline: boolean;
  queuedOutboxCount?: number;
  lastError: string | null;
  gatewayVersion: string;
  updateAvailable: UpdateAvailable | null;
  updateSchedule?: UpdateScheduleState | null;
  heldUpdateCampaignId?: string | null;
  updateBusy: boolean;
  updateStatusBanner?: ApplicationStatusBanner | null;
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
  canUpdate?: boolean;
  canHoldUpdate?: boolean;
  onUpdate: () => void;
  refreshRequired: boolean;
  onRefresh: () => void;
  onHoldUpdate?: () => Promise<boolean>;
  onReviewUpdate?: () => void;
  searchQuery: string;
  searchBlockMatches?: readonly SettingsSearchBlock[];
  searchParams?: Parameters<typeof findSettingsSearchBlocks>[0];
  onExit: () => void;
  onRetryConnect: () => void;
  onNavigate: (routeId: RouteId, options?: ApplicationNavigationOptions) => void;
  onOpenApprovals?: () => void;
  onPreload?: (routeId: RouteId) => Promise<void> | void;
  onSearchQueryChange: (query: string) => void;
  preloadTimers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>;
  saveIndicator: SettingsSaveIndicatorProps;
  canAdmin?: boolean;
};

type SettingsNavigationGroupView = {
  labelKey: string | null;
  items: readonly SettingsNavigationItemView[];
};

type SettingsNavigationItemView = {
  routeId: RouteId;
  blocks: readonly SettingsSearchBlock[];
};

function isRedundantRouteBlock(routeId: RouteId, block: SettingsSearchBlock): boolean {
  if (block.pathname) {
    return false;
  }
  const blockLabel = normalizeLowercaseStringOrEmpty(block.label);
  return [settingsNavigationLabelForRoute(routeId), titleForRoute(routeId)].some(
    (label) => normalizeLowercaseStringOrEmpty(label) === blockLabel,
  );
}

function filterSettingsNavigationGroups(
  searchQuery: string,
  blockMatches: readonly SettingsSearchBlock[],
  canAdmin: boolean,
): readonly SettingsNavigationGroupView[] {
  const navigationGroups = visibleSettingsNavigationGroups(canAdmin);
  const visibleBlockMatches = blockMatches.filter((block) =>
    isSettingsNavigationRouteVisible(block.routeId, canAdmin),
  );
  const query = normalizeLowercaseStringOrEmpty(searchQuery);
  if (!query) {
    return navigationGroups.map((group) => ({
      labelKey: group.labelKey,
      items: group.routes.map((routeId) => ({ routeId, blocks: [] })),
    }));
  }
  const sidebarRoutes = navigationGroups.flatMap((group) => group.routes);
  const searchableRoutes = [
    ...new Set([
      ...sidebarRoutes,
      ...SETTINGS_SEARCHABLE_SUBPAGE_ROUTES.filter((routeId) =>
        isSettingsNavigationRouteVisible(routeId, canAdmin),
      ),
      ...visibleBlockMatches.map((block) => block.routeId),
    ]),
  ];
  const directRoutes = searchableRoutes.filter((routeId) =>
    [
      settingsNavigationLabelForRoute(routeId),
      titleForRoute(routeId),
      subtitleForRoute(routeId),
    ].some((value) => settingsSearchTextMatches(value, query)),
  );
  const includedRoutes = new Set<RouteId>(directRoutes);
  const groupRoutes = navigationGroups.flatMap((group) => {
    const groupMatches = group.labelKey && settingsSearchTextMatches(t(group.labelKey), query);
    if (!groupMatches) {
      return [];
    }
    return group.routes.filter((routeId) => {
      if (includedRoutes.has(routeId)) {
        return false;
      }
      includedRoutes.add(routeId);
      return true;
    });
  });
  const blocksByRoute = new Map<RouteId, SettingsSearchBlock[]>();
  const seenBlocks = new Set<string>();
  for (const block of visibleBlockMatches) {
    const blockKey = `${block.routeId}\u0000${block.pathname ?? ""}\u0000${block.search ?? ""}\u0000${block.hash}`;
    if (seenBlocks.has(blockKey)) {
      continue;
    }
    seenBlocks.add(blockKey);
    const routeBlocks = blocksByRoute.get(block.routeId) ?? [];
    routeBlocks.push(block);
    blocksByRoute.set(block.routeId, routeBlocks);
  }
  const pageRoutes = [...directRoutes, ...groupRoutes];
  return [
    ...(pageRoutes.length > 0
      ? [
          {
            labelKey: null,
            items: pageRoutes.map((routeId) => ({
              routeId,
              blocks: (blocksByRoute.get(routeId) ?? []).filter(
                (block) => !isRedundantRouteBlock(routeId, block),
              ),
            })),
          },
        ]
      : []),
    ...searchableRoutes
      .filter((routeId) => !includedRoutes.has(routeId) && blocksByRoute.has(routeId))
      .map((routeId) => ({
        labelKey: null,
        items: [{ routeId, blocks: blocksByRoute.get(routeId) ?? [] }],
      })),
  ];
}

function renderItem(props: SettingsSidebarProps, routeId: RouteId, label?: string) {
  const active =
    !props.searchQuery && settingsNavigationOwnerRoute(props.activeRouteId) === routeId;
  return html`
    <a
      href=${pathForRoute(routeId, props.basePath)}
      class="settings-sidebar__item ${active ? "settings-sidebar__item--active" : ""}"
      aria-current=${active ? "page" : nothing}
      @focus=${(event: Event) =>
        scheduleRoutePreload(props.preloadTimers, routeId, event, props.onPreload, active)}
      @blur=${(event: Event) => cancelRoutePreload(props.preloadTimers, event)}
      @pointerenter=${(event: Event) =>
        scheduleRoutePreload(props.preloadTimers, routeId, event, props.onPreload, active)}
      @pointerleave=${(event: Event) => cancelRoutePreload(props.preloadTimers, event)}
      @touchstart=${(event: TouchEvent) =>
        scheduleRoutePreload(props.preloadTimers, routeId, event, props.onPreload, active, true)}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.onNavigate(routeId);
      }}
    >
      <span class="settings-sidebar__item-icon" aria-hidden="true"
        >${icons[navigationIconForRoute(routeId)]}</span
      >
      <span class="settings-sidebar__item-label"
        >${label ?? settingsNavigationLabelForRoute(routeId)}</span
      >
    </a>
  `;
}

function renderBlockItem(props: SettingsSidebarProps, block: SettingsSearchBlock) {
  const pathname = block.pathname ?? pathForRoute(block.routeId, props.basePath);
  const href = pathname + (block.search ?? "") + block.hash;
  const active =
    props.activeRouteId === block.routeId &&
    (block.pathname === undefined || props.activePathname === block.pathname) &&
    props.activeHash === block.hash &&
    (block.search === undefined || props.activeSearch === block.search);
  return html`
    <a
      href=${href}
      class="settings-sidebar__subitem ${active ? "settings-sidebar__subitem--active" : ""}"
      aria-current=${active ? "location" : nothing}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.onNavigate(block.routeId, {
          ...(block.pathname ? { pathname: block.pathname } : {}),
          ...(block.search ? { search: block.search } : {}),
          hash: block.hash,
        });
      }}
    >
      <span class="settings-sidebar__subitem-label">${block.label}</span>
    </a>
  `;
}

function syncSettingsSearchScrollShadow(nav: HTMLElement) {
  // The nav's top padding scrolls away with its rows. Keep the fixed search
  // region visually separated once content reaches that boundary.
  nav
    .closest(".settings-sidebar")
    ?.querySelector(".settings-sidebar__search")
    ?.classList.toggle("settings-sidebar__search--scrolled", nav.scrollTop > 0);
}

export function renderSettingsSidebar(props: SettingsSidebarProps) {
  const reconnecting = t("connection.reconnecting");
  const searchBlockMatches =
    props.searchBlockMatches ??
    (props.searchParams ? findSettingsSearchBlocks(props.searchParams) : []);
  const navigationGroups = filterSettingsNavigationGroups(
    props.searchQuery,
    searchBlockMatches,
    props.canAdmin !== false,
  );
  return html`
    <aside class="settings-sidebar">
      <header class="settings-sidebar__header">
        <button type="button" class="settings-sidebar__back" @click=${() => props.onExit()}>
          <span class="settings-sidebar__back-icon" aria-hidden="true">${icons.arrowLeft}</span>
          ${t("nav.exitSettings")}
          <kbd class="settings-sidebar__esc" aria-hidden="true">esc</kbd>
        </button>
        <h1 class="settings-sidebar__title">${t("nav.settings")}</h1>
      </header>
      <div class="settings-sidebar__search" role="search">
        <span class="settings-sidebar__search-icon" aria-hidden="true">${icons.search}</span>
        <input
          class="settings-sidebar__search-input"
          type="search"
          autocomplete="off"
          spellcheck="false"
          aria-label=${t("nav.settingsSearchLabel")}
          placeholder=${t("nav.settingsSearchPlaceholder")}
          .value=${props.searchQuery}
          @input=${(event: Event) =>
            props.onSearchQueryChange((event.currentTarget as HTMLInputElement).value)}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key !== "Escape") {
              return;
            }
            event.preventDefault();
            if (props.searchQuery) {
              props.onSearchQueryChange("");
              return;
            }
            props.onExit();
          }}
        />
        ${props.searchQuery
          ? html`
              <button
                type="button"
                class="settings-sidebar__search-clear"
                aria-label=${t("nav.settingsSearchClear")}
                @click=${(event: MouseEvent) => {
                  const searchInput = (
                    event.currentTarget as HTMLElement
                  ).parentElement?.querySelector<HTMLInputElement>("input");
                  props.onSearchQueryChange("");
                  searchInput?.focus();
                }}
              >
                ${icons.x}
              </button>
            `
          : nothing}
      </div>
      <nav
        class="settings-sidebar__nav"
        aria-label=${t("common.settingsSections")}
        @scroll=${(event: Event) =>
          syncSettingsSearchScrollShadow(event.currentTarget as HTMLElement)}
      >
        ${navigationGroups.length === 0
          ? html`<p class="settings-sidebar__empty" role="status">
              ${t("nav.settingsSearchNoResults")}
            </p>`
          : navigationGroups.map(
              (group) => html`
                <div class="settings-sidebar__group">
                  ${group.labelKey
                    ? html`<div class="settings-sidebar__group-label">${t(group.labelKey)}</div>`
                    : nothing}
                  ${group.items.map(
                    (item) => html`
                      ${renderItem(props, item.routeId)}
                      ${item.blocks.map((block) => renderBlockItem(props, block))}
                    `,
                  )}
                </div>
              `,
            )}
      </nav>
      <footer class="settings-sidebar__footer">
        ${props.offline
          ? renderOfflineSidebarStatus({
              queuedOutboxCount: props.queuedOutboxCount ?? 0,
              reconnecting,
              title: props.lastError ? redactLoginFailureError(props.lastError) : reconnecting,
              onRetry: props.onRetryConnect,
            })
          : html`<openclaw-settings-save-indicator
              .props=${props.saveIndicator}
            ></openclaw-settings-save-indicator>`}
        <openclaw-sidebar-build-chip
          .basePath=${props.basePath}
          .gatewayVersion=${props.gatewayVersion || null}
          .variant=${"settings"}
          .onNavigate=${() => props.onNavigate("about")}
        ></openclaw-sidebar-build-chip>
      </footer>
    </aside>
  `;
}
