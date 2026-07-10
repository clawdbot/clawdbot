// Dedicated sidebar for the full-page settings takeover (see app-host.ts).
import { html, nothing } from "lit";
import {
  cancelRoutePreload,
  navigationIconForRoute,
  scheduleRoutePreload,
  SETTINGS_NAVIGATION_GROUPS,
  settingsNavigationLabelForRoute,
  subtitleForRoute,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../lib/string-coerce.ts";
import { icons } from "./icons.ts";

type SettingsSidebarProps = {
  basePath: string;
  activeRouteId: RouteId;
  connected: boolean;
  version: string;
  searchQuery: string;
  onExit: () => void;
  onNavigate: (routeId: RouteId) => void;
  onPreload?: (routeId: RouteId) => Promise<void> | void;
  onSearchQueryChange: (query: string) => void;
  preloadTimers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>;
};

type SettingsNavigationGroupView = {
  labelKey: string | null;
  routes: readonly RouteId[];
};

function filterSettingsNavigationGroups(
  searchQuery: string,
): readonly SettingsNavigationGroupView[] {
  const query = normalizeLowercaseStringOrEmpty(searchQuery);
  if (!query) {
    return SETTINGS_NAVIGATION_GROUPS;
  }
  return SETTINGS_NAVIGATION_GROUPS.map((group) => {
    const groupMatches = group.labelKey
      ? normalizeLowercaseStringOrEmpty(t(group.labelKey)).includes(query)
      : false;
    const routes = groupMatches
      ? group.routes
      : group.routes.filter((routeId) =>
          [
            settingsNavigationLabelForRoute(routeId),
            titleForRoute(routeId),
            subtitleForRoute(routeId),
          ].some((value) => normalizeLowercaseStringOrEmpty(value).includes(query)),
        );
    return { labelKey: group.labelKey, routes };
  }).filter((group) => group.routes.length > 0);
}

function renderItem(props: SettingsSidebarProps, routeId: RouteId) {
  const active = props.activeRouteId === routeId;
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
      <span class="settings-sidebar__item-label">${settingsNavigationLabelForRoute(routeId)}</span>
    </a>
  `;
}

export function renderSettingsSidebar(props: SettingsSidebarProps) {
  const gatewayStatus = t("chat.gatewayStatus", {
    status: props.connected ? t("common.online") : t("common.offline"),
  });
  const navigationGroups = filterSettingsNavigationGroups(props.searchQuery);
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
                  ${group.routes.map((routeId) => renderItem(props, routeId))}
                </div>
              `,
            )}
      </nav>
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
