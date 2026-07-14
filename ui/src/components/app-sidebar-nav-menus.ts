// Sidebar nav rows plus the More and pin-editor menus, split out of
// app-sidebar.ts to keep that hot component inside the TS LOC ratchet.
import { html, nothing } from "lit";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  isPluginsHubRoute,
  isSettingsNavigationRoute,
  navigationIconForRoute,
  type NavigationRouteId,
  SIDEBAR_NAV_ROUTES,
  type SidebarNavRoute,
  sidebarMoreRoutes,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { pluginTabKey, pluginTabSearch } from "../pages/plugin/route.ts";
import { icons, type IconName } from "./icons.ts";
import { consumeDropdownKeyboardDismissal, trackDropdownKeyboardDismissal } from "./web-awesome.ts";

type SidebarMenuPosition = { x: number; y: number };

/** Ordinary primary click without modifiers; anything else keeps native link behavior. */
export function shouldHandleNavigationClick(event: MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** Settings routes highlight Settings; Plugins hub tabs highlight Plugins. */
export function isSidebarRouteActive(
  activeRouteId: NavigationRouteId | undefined,
  routeId: NavigationRouteId,
): boolean {
  if (activeRouteId === undefined) {
    return false;
  }
  if (routeId === "config") {
    return isSettingsNavigationRoute(activeRouteId);
  }
  if (routeId === "plugins") {
    return isPluginsHubRoute(activeRouteId);
  }
  return activeRouteId === routeId;
}

/** Dynamic plugin tabs stay in the More menu; only stable static route ids can be persisted as pins. */
export function sidebarPluginTabs(
  tabs: readonly GatewayControlUiPluginTab[] | undefined,
): GatewayControlUiPluginTab[] {
  const known = tabs ?? [];
  return ["chat", "control", "agent", "settings"].flatMap((group) =>
    known.filter((tab) => (tab.group ?? "control") === group),
  );
}

type SidebarNavRouteParams = {
  routeId: NavigationRouteId;
  href: string;
  active: boolean;
  onNavigate: () => void;
  onPreload: (event: Event, immediate?: boolean) => void;
  onCancelPreload: (event: Event) => void;
};

export function renderSidebarNavRoute(params: SidebarNavRouteParams) {
  return html`
    <a
      href=${params.href}
      class="nav-item ${params.active ? "nav-item--active" : ""}"
      @focus=${(event: Event) => params.onPreload(event)}
      @blur=${params.onCancelPreload}
      @pointerenter=${(event: Event) => params.onPreload(event)}
      @pointerleave=${params.onCancelPreload}
      @touchstart=${(event: TouchEvent) => params.onPreload(event, true)}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        params.onNavigate();
      }}
    >
      <span class="nav-item__icon" aria-hidden="true"
        >${icons[navigationIconForRoute(params.routeId)]}</span
      >
      <span class="nav-item__text">${titleForRoute(params.routeId)}</span>
    </a>
  `;
}

/** Unpinned routes, plugin tabs, and the pin editor live in a popup behind this row. */
export function renderSidebarMoreRow(params: {
  open: boolean;
  active: boolean;
  onToggle: (trigger: HTMLElement) => void;
}) {
  return html`
    <button
      type="button"
      class="nav-item nav-item--action ${params.active ? "nav-item--active" : ""}"
      aria-haspopup="menu"
      aria-expanded=${String(params.open)}
      @click=${(event: MouseEvent) => params.onToggle(event.currentTarget as HTMLElement)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons.moreHorizontal}</span>
      <span class="nav-item__text">${t("nav.more")}</span>
    </button>
  `;
}

type SidebarMenuNavigationHandlers = {
  onNavigateRoute: (routeId: SidebarNavRoute) => void;
  onNavigatePluginTab: (search: string) => void;
  onPreloadRoute: (routeId: SidebarNavRoute, event: Event) => void;
  onCancelPreload: (event: Event) => void;
};

type SidebarMoreMenuParams = SidebarMenuNavigationHandlers & {
  position: SidebarMenuPosition | null;
  basePath: string;
  activeRouteId: NavigationRouteId | undefined;
  activePluginTabId: string;
  pinnedRoutes: readonly SidebarNavRoute[];
  pluginTabs: readonly GatewayControlUiPluginTab[];
  isRouteEnabled: (routeId: NavigationRouteId) => boolean;
  onEditPinnedItems: () => void;
  onTabAway: () => void;
  onClose: (restoreFocus: boolean) => void;
};

function renderMoreMenuRoute(params: SidebarMoreMenuParams, routeId: SidebarNavRoute) {
  const active = isSidebarRouteActive(params.activeRouteId, routeId);
  return html`
    <wa-dropdown-item
      value=${routeId}
      class="sidebar-customize-menu__item ${active ? "sidebar-customize-menu__item--active" : ""}"
      aria-current=${active ? "page" : nothing}
      @pointerenter=${(event: Event) => params.onPreloadRoute(routeId, event)}
      @pointerleave=${params.onCancelPreload}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          (event.currentTarget as HTMLElement).dataset.nativeNavigation = "true";
          return;
        }
        event.preventDefault();
      }}
    >
      <a href=${pathForRoute(routeId, params.basePath)} tabindex="-1">
        <span class="nav-item__icon" aria-hidden="true"
          >${icons[navigationIconForRoute(routeId)]}</span
        >
        <span class="sidebar-customize-menu__text">${titleForRoute(routeId)}</span>
      </a>
    </wa-dropdown-item>
  `;
}

function renderMoreMenuPluginTab(params: SidebarMoreMenuParams, tab: GatewayControlUiPluginTab) {
  const ref = { pluginId: tab.pluginId, id: tab.id };
  const search = pluginTabSearch(ref);
  const active =
    params.activeRouteId === "plugin" && params.activePluginTabId === pluginTabKey(ref);
  const iconName = tab.icon && Object.hasOwn(icons, tab.icon) ? (tab.icon as IconName) : "puzzle";
  return html`
    <wa-dropdown-item
      value=${`plugin:${pluginTabKey(ref)}`}
      class="sidebar-customize-menu__item ${active ? "sidebar-customize-menu__item--active" : ""}"
      aria-current=${active ? "page" : nothing}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          (event.currentTarget as HTMLElement).dataset.nativeNavigation = "true";
          return;
        }
        event.preventDefault();
      }}
    >
      <a href=${`${pathForRoute("plugin", params.basePath)}${search}`} tabindex="-1">
        <span class="nav-item__icon" aria-hidden="true">${icons[iconName]}</span>
        <span class="sidebar-customize-menu__text">${tab.label}</span>
      </a>
    </wa-dropdown-item>
  `;
}

export function renderSidebarMoreMenu(params: SidebarMoreMenuParams) {
  const position = params.position;
  if (!position) {
    return nothing;
  }
  const moreRoutes = sidebarMoreRoutes(params.pinnedRoutes).filter((routeId) =>
    params.isRouteEnabled(routeId),
  );
  return html`
    <openclaw-menu-surface>
      <wa-dropdown
        class="sidebar-customize-menu sidebar-more-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${t("nav.more")}
        @wa-select=${(event: CustomEvent<{ item: HTMLElement & { value?: string } }>) => {
          event.preventDefault();
          const item = event.detail.item;
          if (item.dataset.nativeNavigation) {
            delete item.dataset.nativeNavigation;
            return;
          }
          const value = item.value;
          if (value === "customize") {
            params.onEditPinnedItems();
            return;
          }
          if (value?.startsWith("plugin:")) {
            const tab = params.pluginTabs.find((candidate) => {
              const ref = { pluginId: candidate.pluginId, id: candidate.id };
              return `plugin:${pluginTabKey(ref)}` === value;
            });
            if (tab) {
              params.onNavigatePluginTab(pluginTabSearch({ pluginId: tab.pluginId, id: tab.id }));
            }
            return;
          }
          if (value && moreRoutes.includes(value as SidebarNavRoute)) {
            params.onNavigateRoute(value as SidebarNavRoute);
          }
        }}
        @keydown=${(event: KeyboardEvent) =>
          trackDropdownKeyboardDismissal(event, params.onTabAway)}
        @wa-after-hide=${(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${t("nav.more")}
          style="position: fixed; left: ${position.x}px; top: ${position.y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        ${moreRoutes.map((routeId) => renderMoreMenuRoute(params, routeId))}
        ${params.pluginTabs.map((tab) => renderMoreMenuPluginTab(params, tab))}
        <div class="sidebar-customize-menu__separator" role="separator"></div>
        <wa-dropdown-item class="sidebar-customize-menu__item" value="customize">
          <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.penLine}</span>
          <span class="sidebar-customize-menu__text">${t("nav.customize")}</span>
        </wa-dropdown-item>
      </wa-dropdown>
    </openclaw-menu-surface>
  `;
}

type SidebarCustomizeMenuParams = {
  position: SidebarMenuPosition | null;
  pinnedRoutes: readonly SidebarNavRoute[];
  isRouteEnabled: (routeId: NavigationRouteId) => boolean;
  onToggleRoute: (routeId: SidebarNavRoute) => void;
  onReset: () => void;
  onTabAway: () => void;
  onClose: (restoreFocus: boolean) => void;
};

export function renderSidebarCustomizeMenu(params: SidebarCustomizeMenuParams) {
  const position = params.position;
  if (!position) {
    return nothing;
  }
  return html`
    <openclaw-menu-surface>
      <wa-dropdown
        class="sidebar-customize-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${t("nav.customize")}
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
          event.preventDefault();
          const value = event.detail.item.value;
          if (value === "reset") {
            params.onReset();
          } else if (value && SIDEBAR_NAV_ROUTES.includes(value as SidebarNavRoute)) {
            params.onToggleRoute(value as SidebarNavRoute);
          }
        }}
        @keydown=${(event: KeyboardEvent) =>
          trackDropdownKeyboardDismissal(event, params.onTabAway)}
        @wa-after-hide=${(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${t("nav.customize")}
          style="position: fixed; left: ${position.x}px; top: ${position.y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        <div class="sidebar-customize-menu__title">${t("nav.customize")}</div>
        ${SIDEBAR_NAV_ROUTES.filter((routeId) => params.isRouteEnabled(routeId)).map((routeId) => {
          const pinned = params.pinnedRoutes.includes(routeId);
          return html`
            <wa-dropdown-item
              class="sidebar-customize-menu__item"
              type="checkbox"
              value=${routeId}
              .checked=${pinned}
            >
              <span slot="icon" class="nav-item__icon" aria-hidden="true"
                >${icons[navigationIconForRoute(routeId)]}</span
              >
              <span class="sidebar-customize-menu__text">${titleForRoute(routeId)}</span>
            </wa-dropdown-item>
          `;
        })}
        <div class="sidebar-customize-menu__separator" role="separator"></div>
        <wa-dropdown-item class="sidebar-customize-menu__item" value="reset">
          <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.refresh}</span>
          <span class="sidebar-customize-menu__text">${t("nav.customizeReset")}</span>
        </wa-dropdown-item>
      </wa-dropdown>
    </openclaw-menu-surface>
  `;
}

/** More row carries the active highlight when the current route lives inside its menu. */
export function sidebarMoreMenuHoldsActiveRoute(params: {
  activeRouteId: NavigationRouteId | undefined;
  pinnedRoutes: readonly SidebarNavRoute[];
  isRouteEnabled: (routeId: NavigationRouteId) => boolean;
}): boolean {
  return (
    params.activeRouteId === "plugin" ||
    sidebarMoreRoutes(params.pinnedRoutes).some(
      (routeId) =>
        params.isRouteEnabled(routeId) && isSidebarRouteActive(params.activeRouteId, routeId),
    )
  );
}
