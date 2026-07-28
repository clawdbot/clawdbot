import { html, nothing } from "lit";
import {
  cancelRoutePreload,
  isSettingsNavigationRoute,
  navigationIconForRoute,
  SETTINGS_NAVIGATION_ROUTES,
  scheduleRoutePreload,
  titleForRoute,
} from "../app-navigation.ts";
import { isRouteId, pathForRoute, type RouteId } from "../app-route-paths.ts";
import type { HostPolicyCapability } from "../app/host-policy.ts";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";

const preloadTimers = new Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>();

function renderSettingsSectionNav(
  basePath: string,
  currentRouteId: RouteId,
  navigate: (routeId: RouteId) => void,
  preload?: (routeId: RouteId) => Promise<void> | void,
  hostPolicy?: HostPolicyCapability,
) {
  if (!isSettingsNavigationRoute(currentRouteId)) {
    return nothing;
  }
  const routes = SETTINGS_NAVIGATION_ROUTES.filter(
    (routeId) => isRouteId(routeId) && (hostPolicy?.isRouteEnabled(routeId) ?? true),
  );
  return html`
    <nav class="settings-section-nav" aria-label=${t("common.settingsSections")}>
      ${routes.map((routeId) => {
        const active = currentRouteId === routeId;
        const href = pathForRoute(routeId, basePath);
        return html`
          <a
            href=${href}
            class="settings-section-nav__item ${active ? "settings-section-nav__item--active" : ""}"
            @focus=${(event: Event) =>
              scheduleRoutePreload(preloadTimers, routeId, event, preload, active)}
            @blur=${(event: Event) => cancelRoutePreload(preloadTimers, event)}
            @pointerenter=${(event: Event) =>
              scheduleRoutePreload(preloadTimers, routeId, event, preload, active)}
            @pointerleave=${(event: Event) => cancelRoutePreload(preloadTimers, event)}
            @touchstart=${(event: TouchEvent) =>
              scheduleRoutePreload(preloadTimers, routeId, event, preload, active, true)}
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
              navigate(routeId);
            }}
          >
            <span class="settings-section-nav__icon" aria-hidden="true"
              >${icons[navigationIconForRoute(routeId)]}</span
            >
            <span class="settings-section-nav__label">${titleForRoute(routeId)}</span>
          </a>
        `;
      })}
    </nav>
  `;
}

export function renderSettingsWorkspace(
  basePath: string,
  body: unknown,
  routeId: RouteId,
  navigate: (routeId: RouteId) => void,
  preload?: (routeId: RouteId) => Promise<void> | void,
  options: { fillHeight?: boolean; hostPolicy?: HostPolicyCapability } = {},
) {
  const className = options.fillHeight
    ? "settings-workspace settings-workspace--fill-height"
    : "settings-workspace";
  return html`
    <section class=${className}>
      ${renderSettingsSectionNav(basePath, routeId, navigate, preload, options.hostPolicy)}
      <div class="settings-workspace__body">${body}</div>
    </section>
  `;
}
