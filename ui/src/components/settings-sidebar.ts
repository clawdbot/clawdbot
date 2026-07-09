// Dedicated sidebar for the full-page settings takeover (see app-host.ts).
import { html, nothing } from "lit";
import {
  cancelRoutePreload,
  navigationIconForRoute,
  scheduleRoutePreload,
  SETTINGS_NAVIGATION_GROUPS,
  settingsNavigationLabelForRoute,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

type SettingsSidebarProps = {
  basePath: string;
  activeRouteId: RouteId;
  connected: boolean;
  version: string;
  onExit: () => void;
  onNavigate: (routeId: RouteId) => void;
  onPreload?: (routeId: RouteId) => Promise<void> | void;
  preloadTimers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>;
};

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
      <nav class="settings-sidebar__nav" aria-label=${t("common.settingsSections")}>
        ${SETTINGS_NAVIGATION_GROUPS.map(
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
