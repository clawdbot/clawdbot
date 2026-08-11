import { html, nothing } from "lit";
import { isSettingsNavigationRoute } from "../app-navigation.ts";
import { isSessionRouteId, workboardBoardIdFromPath } from "../app-route-paths.ts";
import { isRouteId, type RouteId } from "../app-routes.ts";
import type {
  SidebarWorkboardRenderers,
  SidebarWorkboardSnapshot,
} from "../components/app-sidebar-workboard.ts";
import { icons } from "../components/icons.ts";
import { renderSettingsSidebar } from "../components/settings-sidebar.ts";
import type { ThemeModeChangeDetail } from "../components/theme-mode-toggle.ts";
import { t } from "../i18n/index.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import { findSettingsSearchBlocks } from "../pages/config/settings-search.ts";
import { renderDevicePairSetup } from "../pages/devices/view-pairing.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import { pluginTabKey, pluginTabRefFromSearch } from "../pages/plugin/route.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import { resolveTerminalThemeMode } from "./app-root.ts";
import { isBrowserPanelAvailable, isDesktopPanelAvailable } from "./app-shell-chrome.ts";
import type { OutboxStoreRuntime, StoredOutboxScopeHost } from "./app-shell-gateway.ts";
import { findInlineApproval } from "./approval-presentation.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "./context.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import { isOptionalElementDefined, type OptionalCustomElement } from "./lazy-custom-element.ts";
import { isMobileNavLayout, shouldMergeChatChrome } from "./mobile-nav-layout.ts";
import type { NativeHistoryState } from "./native-web-chrome.ts";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";
import { navigationSurfaceIsHidden, renderFloatingUpdateCard } from "./navigation-surface.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";
import {
  NAV_WIDTH_MAX,
  NAV_WIDTH_MIN,
  loadSettings,
  normalizeCatalogOpenTarget,
} from "./settings.ts";

const EMPTY_OUTBOX_COUNT_FOR_SESSION = () => 0;
const EMPTY_SESSION_HAS_DRAFT = () => false;
const PALETTE_SHORTCUT = /Mac|iP(hone|ad|od)/i.test(globalThis.navigator?.platform ?? "")
  ? "⌘K"
  : "Ctrl K";

export interface ShellViewHost {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly runtime: ApplicationRuntime | undefined;
  readonly activeSessionKey: string;
  readonly commandPaletteElement: OptionalCustomElement;
  readonly custodianMinimizeRequestId: number;
  readonly desktopNavigationExpanded: boolean;
  readonly execApprovalElement: OptionalCustomElement;
  readonly nativeHistoryState: NativeHistoryState;
  readonly navDrawerOpen: boolean;
  readonly navigationSidebar: HTMLElement;
  readonly onboardingMode: boolean;
  readonly outboxStoreRuntime: OutboxStoreRuntime | null;
  readonly routeState: ShellRouteState;
  readonly settingsPreloadTimers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>;
  readonly settingsSearchQuery: string;
  readonly sidebarWorkboardRenderers: SidebarWorkboardRenderers | undefined;
  readonly sidebarWorkboardSnapshot: SidebarWorkboardSnapshot;
  closeNavDrawer(options?: { restoreFocus?: boolean }): void;
  draftSessionAgentId(): string;
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
  resizeNavigation(splitRatio: number): void;
  selectChatSession(sessionKey: string, agentId?: string | null): void;
  storedOutboxScopeHost(context: ApplicationContext<RouteId>): StoredOutboxScopeHost;
  toggleNavigationSurface(trigger?: HTMLElement): void;
}

export function renderApplicationShell(host: ShellViewHost) {
  const context = host.context;
  const runtime = host.runtime;
  if (!context || !runtime) {
    return nothing;
  }
  const gatewaySnapshot = context.gateway.snapshot;
  const gatewayConnected = gatewaySnapshot.phase === "connected";
  const operatorAccess = readGatewayOperatorAccess(gatewaySnapshot);
  const canUpdate = canCallGatewayMethod(gatewaySnapshot, "update.run", "operator.admin");
  const canHoldUpdate =
    canUpdate && canCallGatewayMethod(gatewaySnapshot, "update.hold", "operator.admin");
  const outboxScopeHost = host.storedOutboxScopeHost(context);
  const outboxStoreRuntime = host.outboxStoreRuntime;
  const storedOutboxes = outboxStoreRuntime
    ? outboxStoreRuntime.summarizeStoredChatOutboxes(outboxScopeHost)
    : null;
  const storedDraftScopeKeys = outboxStoreRuntime
    ? outboxStoreRuntime.listStoredDraftScopes(outboxScopeHost)
    : null;
  const outboxCountForSession = outboxStoreRuntime
    ? (sessionKey: string) => {
        const scope = outboxStoreRuntime.resolveStoredChatOutboxScope(outboxScopeHost, sessionKey);
        return (
          storedOutboxes?.countsByScope.get(outboxStoreRuntime.storedChatOutboxScopeKey(scope)) ?? 0
        );
      }
    : EMPTY_OUTBOX_COUNT_FOR_SESSION;
  const hasSessionDraft = outboxStoreRuntime
    ? (sessionKey: string) => {
        const scope = outboxStoreRuntime.resolveStoredChatOutboxScope(outboxScopeHost, sessionKey);
        return (
          storedDraftScopeKeys?.has(outboxStoreRuntime.storedChatOutboxScopeKey(scope)) === true
        );
      }
    : EMPTY_SESSION_HAS_DRAFT;
  const navigationSnapshot = context.navigation.snapshot;
  const overlaySnapshot = context.overlays.snapshot;
  const terminalAvailable = isTerminalAvailable(
    gatewaySnapshot,
    context.config.current.terminalEnabled ?? false,
  );
  const browserPanelAvailable = isBrowserPanelAvailable(gatewaySnapshot);
  const desktopPanelAvailable = isDesktopPanelAvailable(gatewaySnapshot);
  const custodianPanelAvailable =
    gatewayConnected && isGatewayMethodAdvertised(gatewaySnapshot, "openclaw.chat") === true;
  const activeRoute = host.routeState.routeId ?? "chat";
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
  const settingsSearchBlocks = findSettingsSearchBlocks({
    query: host.settingsSearchQuery,
    schema: runtimeConfig.configSchema,
    value: runtimeConfig.configForm ?? runtimeConfig.configSnapshot?.config ?? null,
    uiHints: runtimeConfig.configUiHints,
    identityAvailable: Boolean(gatewaySnapshot.selfUser),
    basePath: context.basePath,
  });
  const onboarding = host.onboardingMode;
  const navDrawerOpen = host.navDrawerOpen && !onboarding;
  const mobileNavLayout = isMobileNavLayout();
  const mergedChatChrome = shouldMergeChatChrome({
    mobileNavLayout,
    routeId: activeRoute,
    onboarding,
  });
  // Drawer navigation always opens expanded; the desktop collapse preference
  // stays persisted for when the viewport returns to the desktop layout.
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
  const shellWidth = Math.max(globalThis.innerWidth || 0, NAV_WIDTH_MAX);
  // Mirror the sidebar brand action: an open new-session draft wins over the
  // persisted selection so the collapsed cluster "+" targets the same agent.
  const selectedAgentId = normalizeAgentId(
    host.draftSessionAgentId() ||
      (context.agentSelection.state.selectedId ?? gatewaySnapshot.assistantAgentId),
  );
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
  // One storage read per render; theme.refresh() re-renders on pref changes.
  const uiSettings = loadSettings();
  // The new-session draft shares the chat layout: full-height pane that owns
  // its scrolling and pins the composer dock to the bottom.
  const chatLikeRoute = isSessionRouteId(activeRoute) || activeRoute === "new-session";
  const custodianRoute = activeRoute === "custodian";
  const inlineApproval = isSessionRouteId(activeRoute)
    ? findInlineApproval(overlaySnapshot.approvalQueue, host.activeSessionKey)
    : null;
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
      outboxCountForSession,
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
      gatewayVersion:
        context.config.current.serverVersion ?? gatewaySnapshot.hello?.server?.version ?? null,
      devGitBranch: context.config.current.devGitBranch,
      updateAvailable: navigationSurfaceHidden ? null : overlaySnapshot.updateAvailable,
      updateSchedule: navigationSurfaceHidden ? null : overlaySnapshot.updateSchedule,
      heldUpdateCampaignId: overlaySnapshot.heldUpdateCampaignId,
      updateRunning: overlaySnapshot.updateRunning,
      canUpdate,
      canHoldUpdate,
      onUpdate: () => void context.overlays.runUpdate(),
      refreshRequired: navigationSurfaceHidden ? false : overlaySnapshot.controlUiRefreshRequired,
      onRefresh: () => host.refreshControlUi(),
      onHoldUpdate: () => context.overlays.holdUpdate(),
      onOpenApprovals: () => host.openApprovals(),
      onRetryConnect: () => context.gateway.connect(),
      onOpenNewSession: openNewSession,
      draftSessionAgentId: host.draftSessionAgentId(),
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
    ? renderSettingsSidebar({
        basePath: context.basePath,
        activeRouteId: activeRoute,
        activePathname: host.routeState.location?.pathname ?? "",
        activeSearch: host.routeState.location?.search ?? "",
        activeHash: host.routeState.location?.hash ?? "",
        offline: gatewaySnapshot.offlineStable,
        queuedOutboxCount: storedOutboxes?.total ?? 0,
        lastError: gatewaySnapshot.lastError,
        gatewayVersion:
          context.config.current.serverVersion ?? gatewaySnapshot.hello?.server?.version ?? "",
        updateAvailable: navigationSurfaceHidden ? null : overlaySnapshot.updateAvailable,
        updateSchedule: navigationSurfaceHidden ? null : overlaySnapshot.updateSchedule,
        heldUpdateCampaignId: overlaySnapshot.heldUpdateCampaignId,
        updateRunning: overlaySnapshot.updateRunning,
        canUpdate,
        canHoldUpdate,
        onUpdate: () => void context.overlays.runUpdate(),
        refreshRequired: navigationSurfaceHidden ? false : overlaySnapshot.controlUiRefreshRequired,
        onRefresh: () => host.refreshControlUi(),
        onHoldUpdate: () => context.overlays.holdUpdate(),
        searchQuery: host.settingsSearchQuery,
        searchBlockMatches: settingsSearchBlocks,
        onExit: () => host.exitSettings(),
        onRetryConnect: () => context.gateway.connect(),
        onNavigate: (routeId, options) => host.navigate(routeId, options),
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
            overlaySnapshot.updateRunning ||
            overlaySnapshot.updateReconciliationPending,
          onRetry: () => void context.runtimeConfig.save(),
          onReload: () => void context.runtimeConfig.discardDraft(),
          onApply: () => void context.runtimeConfig.apply(),
        },
      })
    : host.navigationSidebar;
  // Optional tags stay mounted before definition. Lit replays their properties on upgrade,
  // and the upgraded panels catch the first toggle instead of dropping the event.
  return html`
    ${isOptionalElementDefined(host.commandPaletteElement)
      ? html`<openclaw-command-palette
          .onNavigate=${(routeId: RouteId) => host.navigate(routeId)}
          .onSelectSession=${(sessionKey: string) => host.selectChatSession(sessionKey)}
          .onSlashCommand=${(command: string) => host.handleCommandPaletteSlashCommand(command)}
        ></openclaw-command-palette>`
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
      <a class="shell-skip-link" href="#control-ui-main"> ${t("common.skipToMainContent")} </a>
      ${isNativeWebChromeHost() && !onboarding
        ? html`
            <openclaw-macos-titlebar-controls
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
        .basePath=${context.basePath}
        .searchDisabled=${false}
        .navDrawerOpen=${navDrawerOpen}
        .onboarding=${onboarding}
        .onOpenPalette=${() => host.openPalette()}
        .onToggleDrawer=${(trigger: HTMLElement) => host.toggleNavigationSurface(trigger)}
      ></openclaw-app-topbar>
      ${!onboarding && !settingsTakeover && !mobileNavLayout
        ? html`
            <div class="shell-chrome-controls">
              <openclaw-tooltip
                .content=${`${t(navCollapsed ? "nav.expand" : "nav.collapse")} (⌘B)`}
              >
                <button
                  type="button"
                  class="shell-chrome-controls__button shell-chrome-controls__nav-toggle"
                  aria-label=${t(navCollapsed ? "nav.expand" : "nav.collapse")}
                  aria-expanded=${navCollapsed ? "false" : "true"}
                  @click=${() => host.toggleNavigationSurface()}
                >
                  ${navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}
                </button>
              </openclaw-tooltip>
              ${navCollapsed
                ? html`<openclaw-tooltip
                    .content=${newSessionAccess.allowed
                      ? t("chat.runControls.newSession")
                      : newSessionAccess.reason}
                  >
                    <button
                      type="button"
                      class="shell-chrome-controls__button shell-chrome-controls__new-thread"
                      aria-label=${t("chat.runControls.newSession")}
                      ?disabled=${!newSessionAccess.allowed}
                      @click=${() => openNewSession(selectedAgentId)}
                    >
                      ${icons.plus}
                    </button>
                  </openclaw-tooltip>`
                : nothing}
              <openclaw-tooltip .content=${`${t("chat.openCommandPalette")} (${PALETTE_SHORTCUT})`}>
                <button
                  type="button"
                  class="shell-chrome-controls__button shell-chrome-controls__search"
                  aria-label=${t("chat.openCommandPalette")}
                  @click=${() => host.openPalette()}
                >
                  ${icons.search}
                </button>
              </openclaw-tooltip>
            </div>
          `
        : nothing}
      <div class="shell-nav" ?inert=${navigationSurfaceHidden}>
        ${mobileNavLayout
          ? html`<openclaw-modal-dialog
              class="drawer nav-drawer"
              .open=${navDrawerOpen}
              .label=${t("palette.categories.navigation")}
              @modal-cancel=${() => host.closeNavDrawer({ restoreFocus: true })}
            >
              <div class="shell-nav-modal__content" tabindex="-1" autofocus>
                ${navigationContent}
              </div>
            </openclaw-modal-dialog>`
          : navigationContent}
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
      >
        ${gatewaySnapshot.hello?.deviceAuthMigration?.pending === true
          ? // The migration banner is registered by a rare-flow dynamic import after first render.
            customElements.get("openclaw-device-auth-migration-banner")
            ? html`<openclaw-device-auth-migration-banner
                .props=${{
                  state: overlaySnapshot.deviceAuthMigration,
                  onSecure: () => void context.overlays.secureThisBrowser(),
                }}
              ></openclaw-device-auth-migration-banner>`
            : html`<openclaw-update-banner
                .props=${{
                  statusBanner: {
                    tone: overlaySnapshot.deviceAuthMigration.error ? "danger" : "warn",
                    text:
                      overlaySnapshot.deviceAuthMigration.error ??
                      t("login.deviceAuthMigration.banner"),
                  },
                }}
              ></openclaw-update-banner>`
          : nothing}
        <openclaw-update-banner
          .props=${{
            statusBanner: overlaySnapshot.updateStatusBanner,
          }}
        ></openclaw-update-banner>
        ${renderFloatingUpdateCard({
          navigationSurfaceHidden,
          onboarding,
          updateAvailable: overlaySnapshot.updateAvailable,
          updateSchedule: overlaySnapshot.updateSchedule,
          heldUpdateCampaignId: overlaySnapshot.heldUpdateCampaignId,
          updateRunning: overlaySnapshot.updateRunning,
          canUpdate,
          canHoldUpdate,
          onUpdate: () => void context.overlays.runUpdate(),
          refreshRequired: overlaySnapshot.controlUiRefreshRequired,
          onRefresh: () => host.refreshControlUi(),
          onHoldUpdate: () => context.overlays.holdUpdate(),
        })}
        <openclaw-router-outlet
          .router=${runtime.router}
          .retryContext=${context}
          .onNotFound=${() => host.replaceChatWithCurrentSession()}
          .notFoundRecoveryReady=${gatewayConnected}
        ></openclaw-router-outlet>
      </main>
      <openclaw-terminal-panel
        .client=${gatewayConnected ? gatewaySnapshot.client : null}
        .available=${terminalAvailable}
        .suppressed=${settingsTakeover}
        .themeMode=${resolveTerminalThemeMode()}
        .basePath=${context.basePath}
      ></openclaw-terminal-panel>
      <openclaw-browser-panel
        .client=${gatewayConnected ? gatewaySnapshot.client : null}
        .available=${browserPanelAvailable}
        .suppressed=${settingsTakeover}
        .basePath=${context.basePath}
        .authToken=${resolveControlUiAuthToken({
          hello: gatewaySnapshot.hello,
          settings: { token: context.gateway.connection.token },
          password: context.gateway.connection.password,
        })}
      ></openclaw-browser-panel>
      <openclaw-desktop-panel
        .client=${gatewayConnected ? gatewaySnapshot.client : null}
        .available=${desktopPanelAvailable}
        .suppressed=${settingsTakeover}
      ></openclaw-desktop-panel>
      <openclaw-custodian-panel
        .available=${custodianPanelAvailable}
        .suppressed=${activeRoute === "custodian"}
        .minimizeRequestId=${host.custodianMinimizeRequestId}
      ></openclaw-custodian-panel>
      ${isOptionalElementDefined(host.execApprovalElement)
        ? html`<openclaw-exec-approval
            .props=${{
              queue: overlaySnapshot.approvalQueue,
              busy: overlaySnapshot.approvalBusy,
              errors: overlaySnapshot.approvalErrors,
              nowMs: overlaySnapshot.approvalNowMs,
              inlineApprovalId: inlineApproval?.id ?? null,
              onDecision: (
                approvalId: string,
                decision: Parameters<typeof context.overlays.decideApproval>[0],
              ) => context.overlays.decideApproval(decision, approvalId),
            }}
          ></openclaw-exec-approval>`
        : nothing}
      ${renderDevicePairSetup({
        open: overlaySnapshot.devicePairSetupOpen,
        loading: overlaySnapshot.devicePairSetupLoading,
        error: overlaySnapshot.devicePairSetupError,
        setup: overlaySnapshot.devicePairSetup,
        access: overlaySnapshot.devicePairSetupAccess,
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
      ${onboarding && activeRoute !== "custodian"
        ? html`<openclaw-onboarding-memory-import
            .active=${true}
            .context=${context}
          ></openclaw-onboarding-memory-import>`
        : nothing}
      <openclaw-toast-host></openclaw-toast-host>
    </div>
  `;
}
