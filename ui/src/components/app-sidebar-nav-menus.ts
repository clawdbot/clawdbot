// Sidebar nav rows plus the More and pin-editor menus, split out of
// app-sidebar.ts to keep that hot component inside the TS LOC ratchet.
import { html, nothing } from "lit";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  isPluginsHubRoute,
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  navigationIconForRoute,
  type NavigationRouteId,
  type SidebarNavRoute,
  sidebarMoreRoutes,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { pluginTabSearch } from "../pages/plugin/route.ts";
import { icons, type IconName } from "./icons.ts";
import type { SidebarAutomationAttention } from "./sidebar-attention-items.ts";
import { consumeDropdownKeyboardDismissal, trackDropdownKeyboardDismissal } from "./web-awesome.ts";

type SidebarMenuPosition = { x: number; y: number };

function renderAutomationAttentionBadge(attention: SidebarAutomationAttention | undefined) {
  if (!attention || attention.count <= 0) {
    return nothing;
  }
  const label = t(
    attention.count === 1
      ? "attention.automationNeedsAttention"
      : "attention.automationsNeedAttention",
    { count: String(attention.count) },
  );
  return html`<openclaw-tooltip .content=${label}>
    <span
      class="sidebar-nav-health-badge sidebar-nav-health-badge--${attention.severity ?? "warning"}"
      role="status"
      aria-label=${label}
      >${attention.count > 9 ? "9+" : attention.count}</span
    >
  </openclaw-tooltip>`;
}

/** Settings routes highlight Settings; hub tabs highlight their hub entry. */
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
  if (routeId === "sessions") {
    return isSessionsHubRoute(activeRouteId);
  }
  return activeRouteId === routeId;
}

/** Stable ordering for plugin-provided sidebar tabs. */
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
  attention?: SidebarAutomationAttention;
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
      ${renderAutomationAttentionBadge(params.attention)}
    </a>
  `;
}

export function renderSidebarPluginTab(params: {
  tab: GatewayControlUiPluginTab;
  basePath: string;
  active: boolean;
  onNavigate: (search: string) => void;
}) {
  const search = pluginTabSearch({ pluginId: params.tab.pluginId, id: params.tab.id });
  const iconName = Object.hasOwn(icons, params.tab.icon!)
    ? (params.tab.icon as IconName)
    : "puzzle";
  return html`
    <a
      href=${`${pathForRoute("plugin", params.basePath)}${search}`}
      class="nav-item ${params.active ? "nav-item--active" : ""}"
      aria-current=${params.active ? "page" : nothing}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        params.onNavigate(search);
      }}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconName]}</span>
      <span class="nav-item__text">${params.tab.label}</span>
    </a>
  `;
}

type SidebarMenuNavigationHandlers = {
  onNavigateRoute: (routeId: SidebarNavRoute) => void;
  onPreloadRoute: (routeId: SidebarNavRoute, event: Event) => void;
  onCancelPreload: (event: Event) => void;
};

type SidebarMoreMenuParams = SidebarMenuNavigationHandlers & {
  position: SidebarMenuPosition | null;
  basePath: string;
  activeRouteId: NavigationRouteId | undefined;
  activeWorkboardBoardId: string;
  sidebarEntries: readonly string[];
  automationAttention: SidebarAutomationAttention;
  isRouteEnabled: (routeId: NavigationRouteId) => boolean;
  onEditPinnedItems: () => void;
  onTabAway: () => void;
  onClose: (restoreFocus: boolean) => void;
};

function renderMoreMenuRoute(params: SidebarMoreMenuParams, routeId: SidebarNavRoute) {
  const active =
    isSidebarRouteActive(params.activeRouteId, routeId) &&
    !(routeId === "workboard" && params.activeWorkboardBoardId);
  return html`
    <wa-dropdown-item
      value=${routeId}
      class="sidebar-customize-menu__item ${active ? "sidebar-customize-menu__item--active" : ""}"
      aria-current=${active ? "page" : nothing}
      @pointerenter=${(event: Event) => params.onPreloadRoute(routeId, event)}
      @pointerleave=${params.onCancelPreload}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          // wa-select also fires for native clicks; mark them so it does not add SPA navigation.
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
        ${routeId === "cron" ? renderAutomationAttentionBadge(params.automationAttention) : nothing}
      </a>
    </wa-dropdown-item>
  `;
}

export function renderSidebarMoreMenu(params: SidebarMoreMenuParams) {
  const position = params.position;
  if (!position) {
    return nothing;
  }
  const moreRoutes = sidebarMoreRoutes(params.sidebarEntries).filter((routeId) =>
    params.isRouteEnabled(routeId),
  );
  return html`
    <openclaw-menu-surface>
      <wa-dropdown
        class="sidebar-customize-menu sidebar-more-menu"
        .open=${true}
        placement="right-start"
        .distance=${5}
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
          style="position: fixed; left: ${position.x}px; top: ${position.y}px; width: 1px; min-width: 0; height: 1px; min-height: 0; padding: 0; border: 0; opacity: 0; pointer-events: none;"
        ></button>
        ${moreRoutes.map((routeId) => renderMoreMenuRoute(params, routeId))}
        <div class="sidebar-customize-menu__separator" role="separator"></div>
        <wa-dropdown-item class="sidebar-customize-menu__item" value="customize">
          <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.settings2}</span>
          <span class="sidebar-customize-menu__text">${t("nav.customize")}</span>
        </wa-dropdown-item>
      </wa-dropdown>
    </openclaw-menu-surface>
  `;
}
