import { html, nothing } from "lit";
import { isSettingsNavigationRoute } from "../app-navigation.ts";
import { isSessionRouteId, workboardBoardIdFromPath } from "../app-route-paths.ts";
import { isRouteId, type RouteId } from "../app-routes.ts";
import type {
  SidebarWorkboardRenderers,
  SidebarWorkboardSnapshot,
} from "../components/app-sidebar-workboard.ts";
import { icons } from "../components/icons.ts";
import { renderLazyElementModal } from "../components/lazy-view-error.ts";
import { renderNewSessionLink } from "../components/new-session-link.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import {
  renderLazySettingsSidebar,
  type SettingsSidebarModule,
} from "../components/settings-sidebar-lazy.ts";
import type { ThemeModeChangeDetail } from "../components/theme-mode-toggle.ts";
import { t } from "../i18n/index.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import { pluginTabKey, pluginTabRefFromSearch } from "../pages/plugin/route.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import { renderCommandPaletteLoading } from "./app-shell-command-palette-loading.ts";
import type { OutboxStoreRuntime, StoredOutboxScopeHost } from "./app-shell-gateway.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "./context.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import {
  DEBUG_OVERLAY_ELEMENT,
  isOptionalElementDefined,
  KEYBOARD_SHORTCUTS_ELEMENT,
  type LazyCustomElementRequestController,
  MACOS_TITLEBAR_ELEMENT,
  type OptionalCustomElement,
} from "./lazy-custom-element.ts";
import { isMobileNavLayout, shouldMergeChatChrome } from "./mobile-nav-layout.ts";
import type { NativeHistoryState } from "./native-web-chrome.ts";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";
import {
  floatingSidebarAttentionVisible,
  navigationSurfaceIsHidden,
  renderFloatingUpdateCard,
} from "./navigation-surface.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";
import { isBrowserPanelAvailable, isDesktopPanelAvailable } from "./panel-availability.ts";
import {
  NAV_WIDTH_MAX,
  NAV_WIDTH_MIN,
  normalizeCatalogOpenTarget,
  normalizeChatSendShortcut,
} from "./settings.ts";
import { createUpdateProgressWatcher } from "./update-overlay-helpers.ts";

const EMPTY_SESSION_HAS_DRAFT = () => false;
const SIDEBAR_ATTENTION_ELEMENT = {
  tagName: "openclaw-sidebar-attention",
  label: t("attention.issues"),
  loadModule: () => import("../components/sidebar-attention.ts"),
} satisfies OptionalCustomElement;

export interface ShellViewHost {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly runtime: ApplicationRuntime | undefined;
  readonly activeSessionKey: string;
  readonly commandPaletteElement: OptionalCustomElement;
  readonly custodianMinimizeRequestId: number;
  readonly desktopNavigationExpanded: boolean;
  readonly execApprovalElement: OptionalCustomElement;
  readonly onboardingMemoryImportElement: OptionalCustomElement;
  readonly lazyCustomElements: LazyCustomElementRequestController;
  readonly nativeHistoryState: NativeHistoryState;
  readonly navDrawerOpen: boolean;
  readonly navigationSidebar: HTMLElement;
  readonly onboardingMode: boolean;
  readonly outboxStoreRuntime: OutboxStoreRuntime | null;
  readonly routeState: ShellRouteState;
  readonly settingsPreloadTimers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>;
  readonly settingsSidebarRenderer: SettingsSidebarModule["renderSettingsSidebar"] | null;
  readonly settingsSidebarLoadFailed: boolean;
  readonly settingsSearchQuery: string;
  readonly sidebarWorkboardRenderers: SidebarWorkboardRenderers | undefined;
  readonly sidebarWorkboardSnapshot: SidebarWorkboardSnapshot;
  readonly devicePairSetupRenderer: DevicePairSetupModule["renderDevicePairSetup"] | null;
  readonly devicePairSetupLoadFailed: boolean;
  loadDevicePairSetupRenderer(): void;
  loadSettingsSidebarRenderer(): void;
  retryDevicePairSetupRenderer(): void;
  retrySettingsSidebarRenderer(): void;
  closeNavDrawer(options?: { restoreFocus?: boolean }): void;
  newSessionRouteAgentId(): string;
  enabledRouteIds(): readonly RouteId[];
  exitSettings(): void;
  handleCommandPaletteSlashCommand(command: string): void;
  handleNativeNewSession(): void;
  handleSettingsSearchQueryChange(query: string): Promise<void>;
  handleThemeChange(event: CustomEvent<ThemeModeChangeDetail>): void;
  nativeNavCollapsed(): boolean;
  navigate(routeId: string, options?: ApplicationNavigationOptions): void;
  openApprovals(): void;
  openNewSession(agentId: string, target?: NewSessionTarget): void;
  openPalette(): void;
  refreshControlUi(): void;
  replaceChatWithCurrentSession(): boolean;
  requestUpdate(): void;
  resizeNavigation(splitRatio: number): void;
  selectChatSession(sessionKey: string, agentId?: string | null): void;
  storedOutboxScopeHost(context: ApplicationContext<RouteId>): StoredOutboxScopeHost;
  toggleNavigationSurface(trigger?: HTMLElement): void;
}

type DevicePairSetupModule = typeof import("../pages/devices/view-pairing.runtime.ts");
type DevicePairSetupProps = Parameters<DevicePairSetupModule["renderDevicePairSetup"]>[0];

// Lazy: the pairing modal stays out of the startup chunk (perf budget); it is
// fetched the first time an operator opens Pair mobile device. The eager shell
// stays visible during that import so the action never appears to do nothing.
function renderLazyDevicePairSetup(host: ShellViewHost, props: DevicePairSetupProps) {
  if (!props.open) {
    return nothing;
  }
  const renderer = host.devicePairSetupRenderer;
  if (renderer) {
    return renderer(props);
  }
  if (host.devicePairSetupLoadFailed) {
    return renderDevicePairSetupLoadFailure(host, props);
  }
  host.loadDevicePairSetupRenderer();
  return renderDevicePairSetupLoading(props);
}

function renderDevicePairSetupLoading(props: DevicePairSetupProps) {
  const title = t("devices.pairing.title");
  const message = t("common.loading");
  return html`<openclaw-modal-dialog
    label=${title}
    description=${message}
    @modal-cancel=${props.onClose}
  >
    <section class="device-pair-setup" aria-busy="true">
      <header class="device-pair-setup__header">
        <div>
          <h2>${title}</h2>
          <p role="status">${message}</p>
        </div>
      </header>
      <footer class="device-pair-setup__footer">
        <button class="btn btn--ghost" type="button" @click=${props.onClose}>
          ${t("common.close")}
        </button>
      </footer>
    </section>
  </openclaw-modal-dialog>`;
}

// The pairing chunk failed to load while its overlay is open. Reuse the eager
// modal chrome so the operator still gets a dialog, a reason, and a retry
// instead of a silently empty surface.
function renderDevicePairSetupLoadFailure(host: ShellViewHost, props: DevicePairSetupProps) {
  const title = t("devices.pairing.title");
  const message = t("devices.pairing.loadFailed");
  return html`<openclaw-modal-dialog
    label=${title}
    description=${message}
    @modal-cancel=${props.onClose}
  >
    <section class="device-pair-setup">
      <header class="device-pair-setup__header">
        <div>
          <h2>${title}</h2>
          <p>${message}</p>
        </div>
      </header>
      <footer class="device-pair-setup__footer">
        <button
          class="btn btn--primary"
          type="button"
          @click=${() => host.retryDevicePairSetupRenderer()}
        >
          ${t("common.retry")}
        </button>
        <button class="btn btn--ghost" type="button" @click=${props.onClose}>
          ${t("common.close")}
        </button>
      </footer>
    </section>
  </openclaw-modal-dialog>`;
}

export function renderApplicationShell(host: ShellViewHost) {
  const context = host.context;
  const runtime = host.runtime;
  if (!context || !runtime) {
    return nothing;
  }
  if (host.routeState.routeId === undefined) {
    return html`<main class="connect-splash" role="status" aria-label=${t("common.loading")}>
      <openclaw-mascot mood="thinking" .size=${120}></openclaw-mascot>
    </main>`;
  }
  const gatewaySnapshot = context.gateway.snapshot;
  const config = context.config.current;
  const gatewayConnected = gatewaySnapshot.phase === "connected";
  const operatorAccess = readGatewayOperatorAccess(gatewaySnapshot);
  const canUpdate = canCallGatewayMethod(gatewaySnapshot, "update.run", "operator.admin");
  const canHoldUpdate =
    canUpdate && canCallGatewayMethod(gatewaySnapshot, "update.hold", "operator.admin");
  const outboxScopeHost = host.storedOutboxScopeHost(context);
  const outboxStoreRuntime = host.outboxStoreRuntime;
  const storedOutboxes = outboxStoreRuntime?.summarizeStoredChatOutboxes(outboxScopeHost) ?? null;
  const outboxAttentionCountForSession = outboxStoreRuntime
    ? (sessionKey: string) => {
        const scope = outboxStoreRuntime.resolveStoredChatOutboxScope(outboxScopeHost, sessionKey);
        const scopeKey = outboxStoreRuntime.storedChatOutboxScopeKey(scope);
        return storedOutboxes?.attentionCountsByScope.get(scopeKey) ?? 0;
      }
    : () => 0;
  const hasSessionDraft = outboxStoreRuntime
    ? (sessionKey: string) => {
        const scope = outboxStoreRuntime.resolveStoredChatOutboxScope(outboxScopeHost, sessionKey);
        return (
          storedOutboxes?.draftScopes.has(outboxStoreRuntime.storedChatOutboxScopeKey(scope)) ===
          true
        );
      }
    : EMPTY_SESSION_HAS_DRAFT;
  const navigationSnapshot = context.navigation.snapshot;
  const overlaySnapshot = context.overlays.snapshot;
  // The install keeps running after `update.run` answers, so the reconciliation
  // — not the request — decides how long the update surfaces stay busy.
  const updateBusy = overlaySnapshot.updateRunning || overlaySnapshot.updateReconciliationPending;
  const watchUpdateProgress = createUpdateProgressWatcher(context);
  const terminalAvailable = isTerminalAvailable(gatewaySnapshot, config.terminalEnabled ?? false);
  const browserPanelAvailable = isBrowserPanelAvailable(gatewaySnapshot);
  const desktopPanelAvailable = isDesktopPanelAvailable(gatewaySnapshot);
  const custodianPanelAvailable =
    // Scope-aware to match the store: admin-only, never advertisement alone.
    canCallGatewayMethod(gatewaySnapshot, "openclaw.chat", "operator.admin");
  const lazyElementState = host.lazyCustomElements.visibleState;
  const activeRoute = host.routeState.routeId ?? "chat";
  const sessionRoute = isSessionRouteId(activeRoute);
  // Chat has an offline outbox, New Session keeps a local draft, and Appearance
  // persists local preference intent for replay. Their server actions are
  // independently gated; other pages cannot submit useful disconnected work.
  const pageActionsBlocked =
    gatewaySnapshot.phase === "reload-required" ||
    (!gatewayConnected &&
      activeRoute !== "chat" &&
      activeRoute !== "new-session" &&
      activeRoute !== "appearance");
  // Plugin tabs share one route; the search picks the active item.
  const activePluginRef =
    activeRoute === "plugin"
      ? pluginTabRefFromSearch(host.routeState.location?.search ?? "")
      : null;
  const activePluginTabId = activePluginRef ? pluginTabKey(activePluginRef) : "";
  // Onboarding renders without any navigation chrome, so the settings takeover
  // must not reserve its fixed sidebar column (the grid would stay off-center).
  const settingsTakeover = isSettingsNavigationRoute(activeRoute) && !host.onboardingMode;
  const runtimeConfig = context.runtimeConfig.state;
  const onboarding = host.onboardingMode;
  const memoryImportActive = onboarding && activeRoute !== "custodian";
  host.lazyCustomElements.requestWhileActive(
    host.onboardingMemoryImportElement,
    memoryImportActive,
  );
  const navDrawerOpen = host.navDrawerOpen && !onboarding;
  const mobileNavLayout = isMobileNavLayout();
  const nativeWebChrome = isNativeWebChromeHost();
  // Native chrome is absent in browsers; the shell owns visible retry if its chunk fails.
  if (nativeWebChrome && !onboarding) {
    host.lazyCustomElements.preload(MACOS_TITLEBAR_ELEMENT, { reportError: true });
  }
  const mergedChatChrome = shouldMergeChatChrome({
    mobileNavLayout,
    routeId: activeRoute,
    onboarding,
  });
  // Drawer navigation always opens expanded; the tab's desktop collapse state
  // stays in memory for when the viewport returns to the desktop layout.
  // The settings sidebar has a fixed width, so the collapse state pauses too.
  const navCollapsed =
    navigationSnapshot.navCollapsed &&
    !host.desktopNavigationExpanded &&
    !navDrawerOpen &&
    !settingsTakeover;
  const navigationSurfaceHidden = navigationSurfaceIsHidden({
    onboarding,
    navCollapsed,
    navDrawerOpen,
    mobileNavLayout,
  });
  if (
    floatingSidebarAttentionVisible({
      navigationSurfaceHidden,
      mobileNavLayout,
      onboarding,
      settingsTakeover,
      compact: mergedChatChrome,
    })
  ) {
    host.lazyCustomElements.preload(SIDEBAR_ATTENTION_ELEMENT, { reportError: true });
  }
  const shellWidth = Math.max(globalThis.innerWidth || 0, NAV_WIDTH_MAX);
  // A route query is navigation input, not an owner record. Let it override the
  // live selection only after the roster proves that agent exists.
  const requestedRouteAgentId = host.newSessionRouteAgentId();
  const routeAgentId = requestedRouteAgentId ? normalizeAgentId(requestedRouteAgentId) : null;
  const routeAgentIsKnown =
    routeAgentId !== null &&
    context.agents.state.agentsList?.agents.some(
      (agent) => normalizeAgentId(agent.id) === routeAgentId,
    ) === true;
  const selectedAgentId = routeAgentIsKnown
    ? routeAgentId
    : normalizeAgentId(context.agentSelection.state.selectedId ?? gatewaySnapshot.assistantAgentId);
  const newSessionAccess = readSessionMethodAccess(gatewaySnapshot, {
    method: "sessions.create",
    params: {},
  });
  const openNewSession = (agentId: string, target?: NewSessionTarget) => {
    const access = readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.create",
      params: {},
    });
    if (access.allowed) {
      host.openNewSession(agentId, target);
    }
  };
  const uiSettings = context.theme.settings;
  // The new-session draft shares the chat layout: full-height pane that owns
  // its scrolling and pins the composer dock to the bottom.
  const chatLikeRoute = sessionRoute || activeRoute === "new-session";
  const custodianRoute = activeRoute === "custodian";
  if (!settingsTakeover) {
    Object.assign(host.navigationSidebar, {
      basePath: context.basePath,
      activeRouteId: activeRoute,
      activePluginTabId,
      enabledRouteIds: host.enabledRouteIds(),
      activeWorkboardBoardId:
        workboardBoardIdFromPath(host.routeState.location?.pathname ?? "", context.basePath) ?? "",
      sessionKey: host.activeSessionKey,
      connected: gatewayConnected,
      offline: gatewaySnapshot.offlineStable,
      restartPending: gatewaySnapshot.restartPending === true,
      queuedOutboxCount: storedOutboxes?.total ?? 0,
      lastError: gatewaySnapshot.lastError,
      outboxAttentionCountForSession,
      hasSessionDraft,
      terminalAvailable,
      catalogOpenTarget: normalizeCatalogOpenTarget(uiSettings.catalogOpenTarget),
      canPairDevice: gatewayConnected && (operatorAccess.canAdmin || operatorAccess.canPair),
      preferencesBrowserOnly: gatewayConnected && context.runtimeConfig.canPatch === false,
      sidebarEntries: navigationSnapshot.sidebarEntries,
      workboardBoards: host.sidebarWorkboardSnapshot.boards,
      workboardBoardsReady: host.sidebarWorkboardSnapshot.ready,
      workboardRenderers: host.sidebarWorkboardRenderers,
      sidebarLiveActivity: uiSettings.sidebarLiveActivity !== false,
      pinnedAgentIds: navigationSnapshot.pinnedAgentIds,
      themeMode: context.theme.mode,
      lobsterPetVisits: uiSettings.lobsterPetVisits !== false,
      lobsterPetSounds: uiSettings.lobsterPetSounds === true,
      gatewayVersion: config.serverVersion ?? gatewaySnapshot.hello?.server?.version ?? null,
      devGitBranch: config.devGitBranch,
      watchUpdateProgress,
      onOpenApprovals: () => host.openApprovals(),
      onRetryConnect: () => context.gateway.connect(),
      onOpenNewSession: openNewSession,
      onUpdateSidebarEntries: (entries: string[]) =>
        context.navigation.update({ sidebarEntries: entries }),
      onPairMobile: () => void context.overlays.openDevicePairSetup(),
      onNavigate: (routeId: string, options?: ApplicationNavigationOptions) =>
        host.navigate(routeId, options),
      onPreloadRoute: (routeId: string) =>
        isRouteId(routeId) ? context.preload(routeId) : Promise.resolve(),
    });
  }
  const navigationContent = settingsTakeover
    ? renderLazySettingsSidebar(host, {
        basePath: context.basePath,
        activeRouteId: activeRoute,
        activePathname: host.routeState.location?.pathname ?? "",
        activeSearch: host.routeState.location?.search ?? "",
        activeHash: host.routeState.location?.hash ?? "",
        offline: gatewaySnapshot.offlineStable,
        restartPending: gatewaySnapshot.restartPending,
        queuedOutboxCount: storedOutboxes?.total ?? 0,
        lastError: gatewaySnapshot.lastError,
        gatewayVersion: config.serverVersion ?? gatewaySnapshot.hello?.server?.version ?? "",
        updateAvailable: navigationSurfaceHidden ? null : overlaySnapshot.updateAvailable,
        updateSchedule: navigationSurfaceHidden ? null : overlaySnapshot.updateSchedule,
        heldUpdateCampaignId: overlaySnapshot.heldUpdateCampaignId,
        updateBusy,
        updateStatusBanner: overlaySnapshot.updateStatusBanner,
        watchUpdateProgress,
        canUpdate,
        canHoldUpdate,
        onUpdate: () => void context.overlays.runUpdate(),
        refreshRequired: navigationSurfaceHidden ? false : overlaySnapshot.controlUiRefreshRequired,
        onRefresh: () => host.refreshControlUi(),
        onHoldUpdate: () => context.overlays.holdUpdate(),
        onReviewUpdate: () => host.navigate("updates"),
        searchQuery: host.settingsSearchQuery,
        searchParams: {
          query: host.settingsSearchQuery,
          schema: runtimeConfig.configSchema,
          value: runtimeConfig.configForm ?? runtimeConfig.configSnapshot?.config ?? null,
          uiHints: runtimeConfig.configUiHints,
          identityAvailable: Boolean(gatewaySnapshot.selfUser),
          basePath: context.basePath,
          canAdmin: operatorAccess.canAdmin,
        },
        onExit: () => host.exitSettings(),
        onRetryConnect: () => context.gateway.connect(),
        onNavigate: (routeId, options) => host.navigate(routeId, options),
        onOpenApprovals: () => host.openApprovals(),
        onPreload: (routeId) => context.preload(routeId),
        onSearchQueryChange: (nextQuery) => {
          void host.handleSettingsSearchQueryChange(nextQuery);
        },
        preloadTimers: host.settingsPreloadTimers,
        saveIndicator: {
          status: runtimeConfig.configAutoSaveStatus,
          lastError: runtimeConfig.lastError,
          needsApply: runtimeConfig.configNeedsApply,
          applying: runtimeConfig.configApplying,
          applyDisabled:
            context.runtimeConfig.canApply === false ||
            runtimeConfig.configLoading ||
            runtimeConfig.configSaving ||
            (runtimeConfig.configFormDirty && runtimeConfig.configFormMode === "raw") ||
            updateBusy,
          onRetry: () => void context.runtimeConfig.save(),
          onReload: () => void context.runtimeConfig.discardDraft(),
          onApply: () => void context.runtimeConfig.apply(),
        },
        canAdmin: operatorAccess.canAdmin,
      })
    : host.navigationSidebar;
  // Optional tags stay mounted before definition. Lit replays their properties on upgrade,
  // and the upgraded panels catch the first toggle instead of dropping the event.
  return html`
    ${lazyElementState?.status === "loading" &&
    lazyElementState.element === host.commandPaletteElement
      ? renderCommandPaletteLoading(() => host.lazyCustomElements.close())
      : renderLazyElementModal(host.lazyCustomElements)}
    ${isOptionalElementDefined(host.commandPaletteElement)
      ? html`<openclaw-command-palette
          .onNavigate=${(routeId: RouteId, options?: ApplicationNavigationOptions) =>
            host.navigate(routeId, options)}
          .onSelectSession=${(sessionKey: string) => host.selectChatSession(sessionKey)}
          .onSlashCommand=${(command: string) => host.handleCommandPaletteSlashCommand(command)}
        ></openclaw-command-palette>`
      : nothing}
    ${isOptionalElementDefined(DEBUG_OVERLAY_ELEMENT)
      ? html`<openclaw-debug-overlay></openclaw-debug-overlay>`
      : nothing}
    ${isOptionalElementDefined(KEYBOARD_SHORTCUTS_ELEMENT)
      ? html`<openclaw-keyboard-shortcuts-dialog
          .sendShortcut=${normalizeChatSendShortcut(uiSettings.chatSendShortcut)}
        ></openclaw-keyboard-shortcuts-dialog>`
      : nothing}
    <div
      class="shell ${chatLikeRoute ? "shell--chat" : ""} ${navCollapsed
        ? "shell--nav-collapsed"
        : ""} ${mobileNavLayout ? "shell--mobile-nav" : ""} ${mergedChatChrome
        ? "shell--merged-chat-chrome"
        : ""} ${navDrawerOpen ? "shell--nav-drawer-open" : ""} ${onboarding
        ? "shell--onboarding"
        : ""} ${settingsTakeover ? "shell--settings" : ""}"
      style=${`--shell-nav-expanded-width: ${navigationSnapshot.navWidth}px`}
      @theme-change=${(event: CustomEvent<ThemeModeChangeDetail>) => host.handleThemeChange(event)}
    >
      <a class="shell-skip-link" href="#control-ui-main" ?inert=${navDrawerOpen}>
        ${t("common.skipToMainContent")}
      </a>
      ${nativeWebChrome && !onboarding
        ? html`
            <openclaw-macos-titlebar-controls
              ?inert=${navDrawerOpen}
              .navCollapsed=${host.nativeNavCollapsed()}
              .historyOnly=${settingsTakeover}
              .canGoBack=${host.nativeHistoryState.canGoBack}
              .canGoForward=${host.nativeHistoryState.canGoForward}
              .newSessionDisabledReason=${newSessionAccess.allowed
                ? undefined
                : newSessionAccess.reason}
              .onToggleSidebar=${() => host.toggleNavigationSurface()}
              .onOpenPalette=${() => host.openPalette()}
              .onOpenNewSession=${() => host.handleNativeNewSession()}
            ></openclaw-macos-titlebar-controls>
          `
        : nothing}
      <openclaw-app-topbar
        ?inert=${navDrawerOpen}
        .resourceBasePath=${context.resourceBasePath}
        .environment=${config.environment}
        .navDrawerOpen=${navDrawerOpen}
        .onOpenPalette=${() => host.openPalette()}
        .onToggleDrawer=${(trigger: HTMLElement) => host.toggleNavigationSurface(trigger)}
      ></openclaw-app-topbar>
      ${!onboarding && !settingsTakeover && !mobileNavLayout
        ? html`
            <div class="shell-chrome-controls">
              <openclaw-tooltip
                .content=${`${t(navCollapsed ? "nav.expand" : "nav.collapse")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)})`}
              >
                <button
                  type="button"
                  class="shell-chrome-controls__button shell-chrome-controls__nav-toggle"
                  aria-label=${t(navCollapsed ? "nav.expand" : "nav.collapse")}
                  aria-expanded=${navCollapsed ? "false" : "true"}
                  data-env-avatar=${navCollapsed && config.environment
                    ? config.assistantIdentity.name.charAt(0)
                    : nothing}
                  @click=${() => host.toggleNavigationSurface()}
                >
                  ${navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}
                </button>
              </openclaw-tooltip>
              ${navCollapsed
                ? renderNewSessionLink({
                    basePath: context.basePath,
                    agentId: selectedAgentId,
                    className: "shell-chrome-controls__button shell-chrome-controls__new-thread",
                    label: t("chat.runControls.newSession"),
                    disabledReason: newSessionAccess.allowed ? undefined : newSessionAccess.reason,
                    onOpen: openNewSession,
                  })
                : nothing}
              <openclaw-tooltip
                .content=${`${t("chat.openCommandPalette")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette)})`}
              >
                <button
                  type="button"
                  class="shell-chrome-controls__button shell-chrome-controls__search"
                  aria-label=${t("chat.openCommandPalette")}
                  @click=${() => host.openPalette()}
                >
                  ${icons.search}
                </button>
              </openclaw-tooltip>
              ${navCollapsed && custodianPanelAvailable
                ? html`<openclaw-tooltip .content=${t("nav.askOpenClaw")}>
                    <button
                      type="button"
                      class="shell-chrome-controls__button shell-chrome-controls__custodian"
                      aria-label=${t("nav.askOpenClaw")}
                      @click=${() =>
                        window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT))}
                    >
                      ${icons.lobster}
                    </button>
                  </openclaw-tooltip>`
                : nothing}
            </div>
          `
        : nothing}
      <button
        type="button"
        class="shell-nav-backdrop"
        tabindex="-1"
        aria-hidden="true"
        ?inert=${!navDrawerOpen}
        @click=${() => host.closeNavDrawer({ restoreFocus: true })}
      ></button>
      <div
        class="shell-nav ${mobileNavLayout ? "nav-drawer" : ""}"
        role=${mobileNavLayout ? "dialog" : nothing}
        aria-modal=${mobileNavLayout && navDrawerOpen ? "true" : nothing}
        aria-label=${mobileNavLayout ? t("palette.categories.navigation") : nothing}
        aria-hidden=${mobileNavLayout && navigationSurfaceHidden ? "true" : nothing}
        tabindex=${mobileNavLayout ? -1 : nothing}
        ?inert=${navigationSurfaceHidden}
      >
        ${navigationContent}
      </div>
      ${!navCollapsed && !onboarding && !settingsTakeover
        ? html`
            <resizable-divider
              class="sidebar-resizer"
              .label=${t("nav.resize")}
              .splitRatio=${navigationSnapshot.navWidth / shellWidth}
              .minRatio=${NAV_WIDTH_MIN / shellWidth}
              .maxRatio=${NAV_WIDTH_MAX / shellWidth}
              aria-valuetext=${`${navigationSnapshot.navWidth} pixels`}
              title=${t("nav.resize")}
              @resize=${(event: CustomEvent<{ splitRatio: number }>) =>
                host.resizeNavigation(event.detail.splitRatio)}
            ></resizable-divider>
          `
        : nothing}
      <main
        id="control-ui-main"
        class="content ${chatLikeRoute ? "content--chat" : ""} ${custodianRoute
          ? "content--custodian"
          : ""} ${activeRoute === "workboard" ? "content--workboard" : ""}"
        .tabIndex=${-1}
        ?inert=${pageActionsBlocked || (mobileNavLayout && navDrawerOpen)}
      >
        ${pageActionsBlocked && gatewaySnapshot.phase !== "reload-required"
          ? html`<div class="connection-action-block" role="status" aria-live="polite">
              <span class="connection-action-block__icon" aria-hidden="true"
                >${icons.globeOff}</span
              >
              <span class="connection-action-block__text">
                ${t(
                  settingsTakeover
                    ? "connection.settingsChangesUnavailable"
                    : "connection.actionsUnavailable",
                )}
              </span>
            </div>`
          : nothing}
        ${renderFloatingUpdateCard({
          navigationSurfaceHidden,
          mobileNavLayout,
          onboarding,
          settingsTakeover,
          compact: mergedChatChrome,
          updateAvailable: overlaySnapshot.updateAvailable,
          updateSchedule: overlaySnapshot.updateSchedule,
          heldUpdateCampaignId: overlaySnapshot.heldUpdateCampaignId,
          updateBusy,
          statusBanner: overlaySnapshot.updateStatusBanner,
          watchUpdateProgress,
          canUpdate,
          canHoldUpdate,
          onUpdate: () => void context.overlays.runUpdate(),
          refreshRequired: overlaySnapshot.controlUiRefreshRequired,
          onRefresh: () => host.refreshControlUi(),
          onHoldUpdate: () => context.overlays.holdUpdate(),
          onReviewUpdate: () => host.navigate("updates"),
          onNavigate: (routeId) => host.navigate(routeId),
          onOpenApprovals: () => host.openApprovals(),
        })}
        <openclaw-router-outlet
          ?inert=${pageActionsBlocked}
          aria-disabled=${pageActionsBlocked ? "true" : nothing}
          .router=${runtime.router}
          .retryContext=${context}
          .onNotFound=${() => host.replaceChatWithCurrentSession()}
          .notFoundRecoveryReady=${gatewayConnected}
        ></openclaw-router-outlet>
      </main>
      <openclaw-terminal-panel
        ?inert=${navDrawerOpen}
        .client=${gatewayConnected ? gatewaySnapshot.client : null}
        .available=${terminalAvailable}
        .agentId=${selectedAgentId}
        .sessionKey=${sessionRoute ? host.activeSessionKey : null}
        .suppressed=${settingsTakeover}
        .themeMode=${context.theme.resolvedMode}
        .basePath=${context.basePath}
      ></openclaw-terminal-panel>
      ${sessionRoute
        ? nothing
        : html`
            <openclaw-browser-panel
              ?inert=${navDrawerOpen}
              data-chat-autotype-exempt
              .client=${gatewayConnected ? gatewaySnapshot.client : null}
              .available=${browserPanelAvailable}
              .suppressed=${settingsTakeover}
              .resourceBasePath=${context.resourceBasePath}
              .authToken=${resolveControlUiAuthToken({
                hello: gatewaySnapshot.hello,
                settings: { token: context.gateway.connection.token },
                password: context.gateway.connection.password,
              })}
            ></openclaw-browser-panel>
            <openclaw-desktop-panel
              ?inert=${navDrawerOpen}
              data-chat-autotype-exempt
              .client=${gatewayConnected ? gatewaySnapshot.client : null}
              .available=${desktopPanelAvailable}
              .suppressed=${settingsTakeover}
              .basePath=${context.basePath}
            ></openclaw-desktop-panel>
          `}
      <openclaw-custodian-panel
        ?inert=${navDrawerOpen}
        .available=${custodianPanelAvailable}
        .suppressed=${activeRoute === "custodian"}
        .minimizeRequestId=${host.custodianMinimizeRequestId}
      ></openclaw-custodian-panel>
      ${isOptionalElementDefined(host.execApprovalElement)
        ? html`<openclaw-exec-approval
            .props=${{
              queue: overlaySnapshot.approvalQueue,
              busy: overlaySnapshot.approvalBusy,
              canGrant: overlaySnapshot.approvalCanGrant,
              errors: overlaySnapshot.approvalErrors,
              onDecision: (
                approvalId: string,
                decision: Parameters<typeof context.overlays.decideApproval>[0],
              ) => context.overlays.decideApproval(decision, approvalId),
            }}
          ></openclaw-exec-approval>`
        : nothing}
      ${renderLazyDevicePairSetup(host, {
        open: overlaySnapshot.devicePairSetupOpen,
        lifecycle: overlaySnapshot.devicePairSetupLifecycle,
        nowMs: Date.now(),
        pendingCount: overlaySnapshot.devicePairPendingCount,
        onRefresh: () => void context.overlays.refreshDevicePairSetup(),
        onAccessChange: (access) => void context.overlays.setDevicePairSetupAccess(access),
        onClose: () => context.overlays.closeDevicePairSetup(),
        onManageDevices: () => {
          context.overlays.closeDevicePairSetup();
          host.navigate("devices");
        },
        onGetApps: () => {
          context.overlays.closeDevicePairSetup();
          host.navigate("apps");
        },
      })}
      ${memoryImportActive && isOptionalElementDefined(host.onboardingMemoryImportElement)
        ? html`<openclaw-onboarding-memory-import
            .active=${true}
            .context=${context}
          ></openclaw-onboarding-memory-import>`
        : nothing}
      <openclaw-toast-host></openclaw-toast-host>
    </div>
  `;
}
