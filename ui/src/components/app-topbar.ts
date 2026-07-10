import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  cancelRoutePreload,
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  isSettingsNavigationRoute,
  navigationIconForRoute,
  scheduleRoutePreload,
  SIDEBAR_NAV_ROUTES,
  sidebarMoreRoutes,
  titleForRoute,
  type NavigationRouteId,
  type SidebarNavRoute,
} from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { pluginTabKey, pluginTabSearch } from "../pages/plugin/route.ts";
import { icons, type IconName } from "./icons.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";

const PALETTE_SHORTCUT = /Mac|iP(hone|ad|od)/i.test(globalThis.navigator?.platform ?? "")
  ? "⌘K"
  : "Ctrl K";

function shouldHandleNavigationClick(event: MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** App-wide header bar: brand + primary navigation + global actions.
 * Desktop shows the full bar (nav pills, search, status); narrow viewports
 * collapse to drawer toggle + brand + search (layout.mobile.css). */
class AppTopbar extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) navDrawerOpen = false;
  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) activePluginTabId = "";
  @property({ attribute: false }) enabledRouteIds?: readonly NavigationRouteId[];
  @property({ attribute: false }) pinnedRoutes: readonly SidebarNavRoute[] =
    DEFAULT_SIDEBAR_PINNED_ROUTES;
  @property({ attribute: false }) pluginTabs: readonly GatewayControlUiPluginTab[] = [];
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) canPairDevice = false;
  @property({ attribute: false }) themeMode: ThemeMode = "system";
  @property({ attribute: false }) navCollapsed = false;
  @property({ attribute: false }) searchDisabled = false;
  @property({ attribute: false }) onToggleDrawer?: (trigger: HTMLElement) => void;
  @property({ attribute: false }) onToggleSidebar?: () => void;
  @property({ attribute: false }) onOpenPalette?: () => void;
  @property({ attribute: false }) onPairMobile?: () => void;
  @property({ attribute: false })
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  @property({ attribute: false }) onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;
  @property({ attribute: false }) onUpdatePinnedRoutes?: (routes: SidebarNavRoute[]) => void;

  @state() private moreMenuPosition: { x: number; y: number } | null = null;
  @state() private customizeMenuPosition: { x: number; y: number } | null = null;

  private moreMenuTrigger: HTMLElement | null = null;
  private customizeMenuTrigger: HTMLElement | null = null;
  private readonly routePreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();

  override disconnectedCallback() {
    this.closeMoreMenu();
    this.closeCustomizeMenu();
    for (const timer of this.routePreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.routePreloadTimers.clear();
    super.disconnectedCallback();
  }

  private isRouteEnabled(routeId: NavigationRouteId): boolean {
    return this.enabledRouteIds?.includes(routeId) ?? true;
  }

  private preloadRoute(routeId: NavigationRouteId, event: Event, immediate = false) {
    scheduleRoutePreload(
      this.routePreloadTimers,
      routeId,
      event,
      (nextRouteId) => this.onPreloadRoute?.(nextRouteId),
      routeId === this.activeRouteId || !this.isRouteEnabled(routeId),
      immediate,
    );
  }

  private readonly cancelPreload = (event: Event) => {
    cancelRoutePreload(this.routePreloadTimers, event);
  };

  private isRouteActive(routeId: NavigationRouteId): boolean {
    if (routeId === "config") {
      return this.activeRouteId !== undefined && isSettingsNavigationRoute(this.activeRouteId);
    }
    return this.activeRouteId === routeId;
  }

  private navigate(routeId: NavigationRouteId, options?: ApplicationNavigationOptions) {
    this.closeMoreMenu();
    this.closeCustomizeMenu();
    this.onNavigate?.(routeId, options);
  }

  private openMoreMenu(trigger: HTMLElement) {
    if (this.moreMenuPosition) {
      this.closeMoreMenu();
      return;
    }
    const menuWidth = 240;
    const rect = trigger.getBoundingClientRect();
    this.closeCustomizeMenu();
    this.moreMenuTrigger = trigger;
    this.moreMenuPosition = {
      x: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
      y: rect.bottom + 6,
    };
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(".topbar-menu .topbar-menu__item")?.focus();
    });
  }

  private closeMoreMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.moreMenuTrigger;
    this.moreMenuTrigger = null;
    this.moreMenuPosition = null;
    this.syncDocumentListeners();
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  private openCustomizeMenu(x: number, y: number, trigger: HTMLElement | null = null) {
    const menuWidth = 240;
    const menuMaxHeight = 420;
    this.closeMoreMenu();
    this.customizeMenuTrigger = trigger;
    this.customizeMenuPosition = {
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
    };
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(".sidebar-customize-menu__item")?.focus();
    });
  }

  private closeCustomizeMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.customizeMenuTrigger;
    this.customizeMenuTrigger = null;
    this.customizeMenuPosition = null;
    this.syncDocumentListeners();
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  private syncDocumentListeners() {
    if (this.moreMenuPosition || this.customizeMenuPosition) {
      return;
    }
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent) => {
    const path = event.composedPath();
    if (this.moreMenuTrigger && path.includes(this.moreMenuTrigger)) {
      return;
    }
    const menu = this.querySelector(".topbar-menu, .sidebar-customize-menu");
    if (menu && path.includes(menu)) {
      return;
    }
    this.closeMoreMenu();
    this.closeCustomizeMenu();
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.closeMoreMenu({ restoreFocus: true });
      this.closeCustomizeMenu({ restoreFocus: true });
    }
  };

  private readonly openCustomizeMenuFromContext = (event: MouseEvent) => {
    event.preventDefault();
    this.openCustomizeMenu(event.clientX, event.clientY);
  };

  private togglePinnedRoute(routeId: SidebarNavRoute) {
    const pinned = this.pinnedRoutes;
    const next = pinned.includes(routeId)
      ? pinned.filter((route) => route !== routeId)
      : [...pinned, routeId];
    this.onUpdatePinnedRoutes?.(next);
  }

  private renderNavItem(routeId: NavigationRouteId, menuItem = false) {
    if (!this.isRouteEnabled(routeId)) {
      return nothing;
    }
    const active = this.isRouteActive(routeId);
    const routeSessionKey = routeId === "chat" ? this.sessionKey.trim() : "";
    const href = routeSessionKey
      ? `${pathForRoute("chat", this.basePath)}${searchForSession(routeSessionKey)}`
      : pathForRoute(routeId, this.basePath);
    const label = titleForRoute(routeId);
    const classes = menuItem
      ? `topbar-menu__item ${active ? "topbar-menu__item--active" : ""}`
      : `topnav-item ${active ? "topnav-item--active" : ""}`;
    return html`
      <a
        href=${href}
        class=${classes}
        role=${menuItem ? "menuitem" : nothing}
        aria-current=${active ? "page" : nothing}
        @focus=${(event: Event) => this.preloadRoute(routeId, event)}
        @blur=${this.cancelPreload}
        @pointerenter=${(event: Event) => this.preloadRoute(routeId, event)}
        @pointerleave=${this.cancelPreload}
        @touchstart=${(event: TouchEvent) => this.preloadRoute(routeId, event, true)}
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          this.navigate(
            routeId,
            routeSessionKey ? { search: searchForSession(routeSessionKey) } : undefined,
          );
        }}
      >
        <span class="nav-item__icon" aria-hidden="true"
          >${icons[navigationIconForRoute(routeId)]}</span
        >
        <span class="topnav-item__text">${label}</span>
      </a>
    `;
  }

  private renderPluginTabItem(tab: GatewayControlUiPluginTab) {
    const ref = { pluginId: tab.pluginId, id: tab.id };
    const search = pluginTabSearch(ref);
    const href = `${pathForRoute("plugin", this.basePath)}${search}`;
    const active = this.activeRouteId === "plugin" && this.activePluginTabId === pluginTabKey(ref);
    const iconName = tab.icon && Object.hasOwn(icons, tab.icon) ? (tab.icon as IconName) : "puzzle";
    return html`
      <a
        href=${href}
        class="topbar-menu__item ${active ? "topbar-menu__item--active" : ""}"
        role="menuitem"
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          this.navigate("plugin", { search });
        }}
      >
        <span class="nav-item__icon" aria-hidden="true">${icons[iconName]}</span>
        <span class="topnav-item__text">${tab.label}</span>
      </a>
    `;
  }

  private renderMoreMenu() {
    const position = this.moreMenuPosition;
    if (!position) {
      return nothing;
    }
    const moreRoutes = sidebarMoreRoutes(this.pinnedRoutes);
    return html`
      <div
        class="topbar-menu"
        role="menu"
        aria-label=${t("nav.more")}
        style="left: ${position.x}px; top: ${position.y}px;"
      >
        ${moreRoutes.map((routeId) => this.renderNavItem(routeId, true))}
        ${this.pluginTabs.map((tab) => this.renderPluginTabItem(tab))}
        <div class="topbar-menu__separator" role="separator"></div>
        <a
          class="topbar-menu__item"
          role="menuitem"
          href="https://docs.openclaw.ai"
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
        >
          <span class="nav-item__icon" aria-hidden="true">${icons.book}</span>
          <span class="topnav-item__text">${t("common.docs")}</span>
          <span class="nav-item__external-icon" aria-hidden="true">${icons.externalLink}</span>
        </a>
        <button
          type="button"
          class="topbar-menu__item"
          role="menuitem"
          @click=${(event: MouseEvent) => {
            const trigger = event.currentTarget as HTMLElement;
            const rect = trigger.getBoundingClientRect();
            this.openCustomizeMenu(rect.left, rect.top);
          }}
        >
          <span class="nav-item__icon" aria-hidden="true">${icons.penLine}</span>
          <span class="topnav-item__text">${t("nav.customize")}</span>
        </button>
      </div>
    `;
  }

  private renderCustomizeMenu() {
    const position = this.customizeMenuPosition;
    if (!position) {
      return nothing;
    }
    return html`
      <div
        class="sidebar-customize-menu"
        role="menu"
        aria-label=${t("nav.customize")}
        style="left: ${position.x}px; top: ${position.y}px;"
      >
        <div class="sidebar-customize-menu__title">${t("nav.customize")}</div>
        ${SIDEBAR_NAV_ROUTES.filter((routeId) => this.isRouteEnabled(routeId)).map((routeId) => {
          const pinned = this.pinnedRoutes.includes(routeId);
          return html`
            <button
              type="button"
              class="sidebar-customize-menu__item"
              role="menuitemcheckbox"
              aria-checked=${String(pinned)}
              @click=${() => this.togglePinnedRoute(routeId)}
            >
              <span class="sidebar-customize-menu__check" aria-hidden="true">
                ${pinned ? icons.check : nothing}
              </span>
              <span class="nav-item__icon" aria-hidden="true"
                >${icons[navigationIconForRoute(routeId)]}</span
              >
              <span class="sidebar-customize-menu__text">${titleForRoute(routeId)}</span>
            </button>
          `;
        })}
        <div class="sidebar-customize-menu__separator" role="separator"></div>
        <button
          type="button"
          class="sidebar-customize-menu__item"
          role="menuitem"
          @click=${() => {
            this.onUpdatePinnedRoutes?.([...DEFAULT_SIDEBAR_PINNED_ROUTES]);
            this.closeCustomizeMenu({ restoreFocus: true });
          }}
        >
          <span class="sidebar-customize-menu__check" aria-hidden="true"></span>
          <span class="nav-item__icon" aria-hidden="true">${icons.refresh}</span>
          <span class="sidebar-customize-menu__text">${t("nav.customizeReset")}</span>
        </button>
      </div>
    `;
  }

  override render() {
    const drawerLabel = this.navDrawerOpen ? t("nav.collapse") : t("nav.expand");
    const panelLabel = this.navCollapsed ? t("nav.expand") : t("nav.collapse");
    const gatewayStatus = t("chat.gatewayStatus", {
      status: this.connected ? t("common.online") : t("common.offline"),
    });
    const settingsActive =
      this.activeRouteId !== undefined && isSettingsNavigationRoute(this.activeRouteId);
    const searchTooltip = `${t("chat.openCommandPalette")} (${PALETTE_SHORTCUT})`;
    return html`
      <header
        class="topbar"
        ?inert=${this.onboarding}
        aria-hidden=${this.onboarding ? "true" : nothing}
      >
        <div class="topnav-shell">
          <openclaw-tooltip .content=${drawerLabel}>
            <button
              type="button"
              class="topbar-icon-btn topbar-nav-toggle"
              @click=${(event: MouseEvent) =>
                this.onToggleDrawer?.(event.currentTarget as HTMLElement)}
              aria-label=${drawerLabel}
              aria-expanded=${String(this.navDrawerOpen)}
            >
              <span class="nav-collapse-toggle__icon" aria-hidden="true">${icons.menu}</span>
            </button>
          </openclaw-tooltip>
          <!-- Brand stays non-interactive: on native macOS an AppKit drag
               region floats over this strip (DashboardWindowController), so
               anything clickable here would be unreachable in the Mac app. -->
          <div class="topbar-brand" aria-label="OpenClaw">
            <openclaw-tooltip .content=${gatewayStatus}>
              <span class="topbar-brand__logo-wrap">
                <img
                  class="topbar-brand__logo"
                  src=${controlUiPublicAssetPath("apple-touch-icon.png", this.basePath)}
                  alt=""
                  aria-hidden="true"
                />
                <span
                  class="topbar-brand__status ${this.connected
                    ? "topbar-brand__status--online"
                    : "topbar-brand__status--offline"}"
                  role="img"
                  aria-live="polite"
                  aria-label=${gatewayStatus}
                ></span>
              </span>
            </openclaw-tooltip>
            <span class="topbar-brand__title">OpenClaw</span>
          </div>
          ${settingsActive
            ? nothing
            : html`
                <openclaw-tooltip .content=${`${panelLabel} (⌘B)`}>
                  <button
                    type="button"
                    class="topbar-icon-btn topbar-panel-toggle"
                    @click=${() => this.onToggleSidebar?.()}
                    aria-label=${panelLabel}
                    aria-expanded=${String(!this.navCollapsed)}
                  >
                    ${this.navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}
                  </button>
                </openclaw-tooltip>
              `}
          <nav class="topbar-nav" @contextmenu=${this.openCustomizeMenuFromContext}>
            ${this.renderNavItem("chat")}
            ${this.pinnedRoutes.map((routeId) => this.renderNavItem(routeId))}
            <button
              type="button"
              class="topnav-item topnav-item--more"
              aria-haspopup="menu"
              aria-expanded=${String(this.moreMenuPosition !== null)}
              @click=${(event: MouseEvent) => this.openMoreMenu(event.currentTarget as HTMLElement)}
            >
              <span class="topnav-item__text">${t("nav.more")}</span>
              <span class="topnav-item__chevron" aria-hidden="true">${icons.chevronDown}</span>
            </button>
          </nav>
          <div class="topnav-shell__actions">
            <openclaw-tooltip .content=${searchTooltip}>
              <button
                class="topbar-search"
                ?disabled=${this.searchDisabled || !this.onOpenPalette}
                @click=${() => this.onOpenPalette?.()}
                aria-label=${t("chat.openCommandPalette")}
              >
                ${icons.search}
                <span class="topbar-search__label">${t("nav.search")}</span>
                <kbd class="topbar-search__kbd">${PALETTE_SHORTCUT}</kbd>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip
              .content=${this.canPairDevice
                ? t("nodes.pairing.button")
                : t("nodes.pairing.adminRequired")}
            >
              <button
                class="topbar-icon-btn topbar-action topbar-pair-mobile"
                type="button"
                aria-label=${t("nodes.pairing.button")}
                ?disabled=${!this.canPairDevice}
                @click=${() => this.onPairMobile?.()}
              >
                ${icons.smartphone}
              </button>
            </openclaw-tooltip>
            <span class="topbar-action topbar-mode-switch">
              <openclaw-theme-mode-toggle .mode=${this.themeMode}></openclaw-theme-mode-toggle>
            </span>
            <openclaw-tooltip .content=${titleForRoute("config")}>
              <a
                href=${pathForRoute("config", this.basePath)}
                class="topbar-icon-btn topbar-action ${settingsActive
                  ? "topbar-icon-btn--active"
                  : ""}"
                aria-label=${titleForRoute("config")}
                aria-current=${settingsActive ? "page" : nothing}
                @focus=${(event: Event) => this.preloadRoute("config", event)}
                @blur=${this.cancelPreload}
                @pointerenter=${(event: Event) => this.preloadRoute("config", event)}
                @pointerleave=${this.cancelPreload}
                @touchstart=${(event: TouchEvent) => this.preloadRoute("config", event, true)}
                @click=${(event: MouseEvent) => {
                  if (!shouldHandleNavigationClick(event)) {
                    return;
                  }
                  event.preventDefault();
                  this.navigate("config");
                }}
              >
                ${icons.settings}
              </a>
            </openclaw-tooltip>
          </div>
        </div>
        ${this.renderMoreMenu()} ${this.renderCustomizeMenu()}
      </header>
    `;
  }
}

if (!customElements.get("openclaw-app-topbar")) {
  customElements.define("openclaw-app-topbar", AppTopbar);
}
