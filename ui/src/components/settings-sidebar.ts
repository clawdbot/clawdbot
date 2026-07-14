// Dedicated sidebar for the full-page settings takeover (see app-host.ts).
import { html, nothing } from "lit";
import type { UpdateAvailable } from "../api/types.ts";
import {
  cancelRoutePreload,
  navigationIconForRoute,
  scheduleRoutePreload,
  SETTINGS_NAVIGATION_GROUPS,
  settingsNavigationLabelForRoute,
  settingsSearchTextMatches,
  subtitleForRoute,
  titleForRoute,
  type SettingsSearchBlock,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../lib/string-coerce.ts";
import { icons } from "./icons.ts";
import "./sidebar-update-card.ts";

type SettingsSidebarProps = {
  basePath: string;
  activeRouteId: RouteId;
  activeSearch?: string;
  activeHash?: string;
  connected: boolean;
  version: string;
  updateAvailable: UpdateAvailable | null;
  updateRunning: boolean;
  onUpdate: () => void;
  searchQuery: string;
  searchBlockMatches?: readonly SettingsSearchBlock[];
  onExit: () => void;
  onNavigate: (routeId: RouteId, options?: ApplicationNavigationOptions) => void;
  onPreload?: (routeId: RouteId) => Promise<void> | void;
  onSearchQueryChange: (query: string) => void;
  preloadTimers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>;
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
  const blockLabel = normalizeLowercaseStringOrEmpty(block.label);
  return [settingsNavigationLabelForRoute(routeId), titleForRoute(routeId)].some(
    (label) => normalizeLowercaseStringOrEmpty(label) === blockLabel,
  );
}

function filterSettingsNavigationGroups(
  searchQuery: string,
  blockMatches: readonly SettingsSearchBlock[],
): readonly SettingsNavigationGroupView[] {
  const query = normalizeLowercaseStringOrEmpty(searchQuery);
  if (!query) {
    return SETTINGS_NAVIGATION_GROUPS.map((group) => ({
      labelKey: group.labelKey,
      items: group.routes.map((routeId) => ({ routeId, blocks: [] })),
    }));
  }
  const allRoutes = SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes);
  const directRoutes = allRoutes.filter((routeId) =>
    [
      settingsNavigationLabelForRoute(routeId),
      titleForRoute(routeId),
      subtitleForRoute(routeId),
    ].some((value) => settingsSearchTextMatches(value, query)),
  );
  const includedRoutes = new Set<RouteId>(directRoutes);
  const groupRoutes = SETTINGS_NAVIGATION_GROUPS.flatMap((group) => {
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
  for (const block of blockMatches) {
    const blockKey = `${block.routeId}\u0000${block.search ?? ""}\u0000${block.hash}`;
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
    ...allRoutes
      .filter((routeId) => !includedRoutes.has(routeId) && blocksByRoute.has(routeId))
      .map((routeId) => ({
        labelKey: null,
        items: [{ routeId, blocks: blocksByRoute.get(routeId) ?? [] }],
      })),
  ];
}

function renderItem(props: SettingsSidebarProps, routeId: RouteId, label?: string) {
  const active = !props.searchQuery && props.activeRouteId === routeId;
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
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
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
  const href = pathForRoute(block.routeId, props.basePath) + (block.search ?? "") + block.hash;
  const active =
    props.activeRouteId === block.routeId &&
    props.activeHash === block.hash &&
    (block.search === undefined || props.activeSearch === block.search);
  return html`
    <a
      href=${href}
      class="settings-sidebar__subitem ${active ? "settings-sidebar__subitem--active" : ""}"
      aria-current=${active ? "location" : nothing}
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        props.onNavigate(block.routeId, {
          ...(block.search ? { search: block.search } : {}),
          hash: block.hash,
        });
      }}
    >
      <span class="settings-sidebar__subitem-label">${block.label}</span>
    </a>
  `;
}

export function renderSettingsSidebar(props: SettingsSidebarProps) {
  const gatewayStatus = t("chat.gatewayStatus", {
    status: props.connected ? t("common.online") : t("common.offline"),
  });
  const navigationGroups = filterSettingsNavigationGroups(
    props.searchQuery,
    props.searchBlockMatches ?? [],
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
            if (event.key !== "Escape" || !props.searchQuery) {
              return;
            }
            event.preventDefault();
            props.onSearchQueryChange("");
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
      <nav class="settings-sidebar__nav" aria-label=${t("common.settingsSections")}>
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
      <openclaw-sidebar-update-card
        .updateAvailable=${props.updateAvailable}
        .updateRunning=${props.updateRunning}
        .onUpdate=${props.onUpdate}
      ></openclaw-sidebar-update-card>
      <footer class="settings-sidebar__footer">
        <span
          class="sidebar-status__dot ${props.connected
            ? "sidebar-connection-status--online"
            : "sidebar-connection-status--offline"}"
          role="img"
          aria-label=${gatewayStatus}
        ></span>
        <span class="settings-sidebar__footer-status">${gatewayStatus}</span>
        ${props.version
          ? html`<span class="settings-sidebar__footer-version">${props.version}</span>`
          : nothing}
      </footer>
    </aside>
  `;
}
