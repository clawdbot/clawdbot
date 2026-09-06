import type { PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import "../components/app-topbar.ts";
import "../components/modal-dialog.ts";
import {
  formatDocumentTitle,
  isSettingsNavigationRoute,
  titleForRoute,
} from "../app-navigation.ts";
import "../components/resizable-divider.ts";
import { isSessionRouteId } from "../app-route-paths.ts";
import { APP_ROUTE_IDS, type RouteId } from "../app-routes.ts";
import type {
  CommandPaletteElement,
  CommandPaletteTargetDetail,
} from "../components/command-palette-contract.ts";
import type { ThemeModeChangeDetail } from "../components/theme-mode-toggle.ts";
import { i18n, t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import { invalidateChatMetadataStore } from "../lib/chat/chat-metadata-store.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { invalidateModelCatalogCache } from "../lib/model-catalog-store.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiKnownSelectedGlobalAgentId,
} from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import type { ChatPage } from "../pages/chat/chat-page.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import { selectShellRouteState, type ShellRouteState } from "./app-host-route-state.ts";
import { OpenClawApp } from "./app-root.ts";
import { ShellChromeOwner, type ShellChromeHost } from "./app-shell-chrome.ts";
import {
  ShellGatewayOwner,
  type OutboxStoreRuntime,
  type ShellGatewayHost,
  type StoredOutboxScopeHost,
} from "./app-shell-gateway.ts";
import { ShellNavigationOwner, type ShellNavigationHost } from "./app-shell-navigation.ts";
import { renderApplicationShell, type ShellViewHost } from "./app-shell-view.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "./context.ts";
import { syncControlUiSystemChrome } from "./control-ui-presentation.ts";
import { createGatewayControlUiReloadOptions } from "./gateway-control-ui-reload.ts";
import {
  BROWSER_PANEL_ELEMENT,
  COMMAND_PALETTE_ELEMENT,
  ASSISTANT_PANEL_ELEMENT,
  DESKTOP_PANEL_ELEMENT,
  EXEC_APPROVAL_ELEMENT,
  LazyCustomElementRequestController,
  type OptionalCustomElement,
  TERMINAL_PANEL_ELEMENT,
} from "./lazy-custom-element.ts";
import { postNativeNavState, type NativeNavState } from "./native-nav-state.ts";
import { readNativeHistoryState, type NativeHistoryState } from "./native-web-chrome.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";
import {
  changedServerUiPrefs,
  isApplyingServerUiPrefs,
  pushServerUiPrefs,
} from "./server-prefs.ts";
import { setSettingsChangeListener } from "./settings.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

const APP_SIDEBAR_TAG = "openclaw-app-sidebar";
const APP_SIDEBAR_ELEMENT = {
  tagName: APP_SIDEBAR_TAG,
  label: APP_SIDEBAR_TAG,
  loadModule: () => import("../components/app-sidebar.ts"),
} satisfies OptionalCustomElement;

i18n.setLocaleLoadRecovery({
  isUnrecoverableError: isStaleChunkImportError,
  onUnrecoverableLocaleLoad: () => {
    // Chrome 149 and WebKit can pin network-failed dynamic imports for the document. Keep the
    // in-place retry for engines that refetch; repeat failures use the guarded stale-chunk reload
    // owner instead of adding a locale-specific reload path.
    void scheduleStaleChunkReload();
  },
});

function equalShellRouteState(previous: ShellRouteState, next: ShellRouteState): boolean {
  return (
    previous.routeId === next.routeId &&
    previous.location?.pathname === next.location?.pathname &&
    previous.location?.search === next.location?.search &&
    previous.location?.hash === next.location?.hash &&
    previous.committedRouteId === next.committedRouteId &&
    previous.committedLocation?.pathname === next.committedLocation?.pathname &&
    previous.committedLocation?.search === next.committedLocation?.search &&
    previous.committedLocation?.hash === next.committedLocation?.hash &&
    previous.committedSessionKey === next.committedSessionKey
  );
}

class OpenClawShell
  extends OpenClawLightDomElement
  implements ShellChromeHost, ShellGatewayHost, ShellNavigationHost, ShellViewHost
{
  @property({ attribute: false }) runtime: ApplicationRuntime | undefined;
  @property({ attribute: false }) onboarding = false;

  @state() navDrawerOpen = false;
  @state() desktopNavigationExpanded = false;
  @state() activeSessionKey = "";
  @state() settingsSearchQuery = "";
  @state() routeState: ShellRouteState = {};
  @state() nativeHistoryState: NativeHistoryState = readNativeHistoryState();
  readonly commandPaletteElement = COMMAND_PALETTE_ELEMENT;
  readonly terminalPanelElement = TERMINAL_PANEL_ELEMENT;
  readonly browserPanelElement = BROWSER_PANEL_ELEMENT;
  readonly desktopPanelElement = DESKTOP_PANEL_ELEMENT;
  readonly assistantPanelElement = ASSISTANT_PANEL_ELEMENT;
  readonly execApprovalElement = EXEC_APPROVAL_ELEMENT;
  readonly onboardingMemoryImportElement = {
    tagName: "openclaw-onboarding-memory-import",
    label: t("onboarding.memoryImport.title"),
    loadModule: () => import("../components/onboarding-memory-import.ts"),
  } satisfies OptionalCustomElement;
  readonly lazyCustomElements = new LazyCustomElementRequestController(
    this,
    () => this.shellChrome.cancelPendingLazyAction(),
    (canReload) => this.shellChrome.retryPendingLazyAction(canReload),
  );
  // Gates lazy-action replay on the element being rendered; while the shell is
  // still splash-gated, replaying would loop through the open handlers forever.
  readonly queryRenderedElement = (tagName: string): Element | null =>
    this.renderRoot?.querySelector(tagName) ?? null;
  @query("openclaw-command-palette") commandPalette: CommandPaletteElement | undefined;
  @query("openclaw-exec-approval")
  approvalOverlay: (HTMLElement & { show(): void; dialogOpen?: boolean }) | undefined;
  commandPaletteTarget: CommandPaletteTargetDetail | undefined;
  navDrawerTrigger: HTMLElement | null = null;
  // Desktop and modal navigation are two slots for the same live sidebar.
  // Moving its element preserves session controllers and the resident pet
  // instead of resetting their lifecycle at every responsive breakpoint.
  readonly navigationSidebar = document.createElement(APP_SIDEBAR_TAG);
  // Where "Back to app" / Escape leaves the settings takeover; falls back to
  // chat (the app default route) when settings was the entry point.
  lastWorkspaceLocation: ShellNavigationHost["lastWorkspaceLocation"] = null;
  custodianMinimizeRequestId = 0;
  lastConcreteRouteId: RouteId | undefined;
  agentsListClient: GatewayBrowserClient | null = null;
  agentsListSource: ApplicationContext["agents"] | null = null;
  sessionKeyClient: GatewayBrowserClient | null = null;
  runtimeConfigClient: GatewayBrowserClient | null = null;
  runtimeConfigSource: ApplicationContext["runtimeConfig"] | null = null;
  lastLocalePrefSignature: string | null = null;
  previousGatewayPhase: ApplicationContext["gateway"]["snapshot"]["phase"] | null = null;
  agentRosterRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  outboxStoreRuntime: OutboxStoreRuntime | null = null;
  private outboxStoreUnsubscribe: (() => void) | null = null;
  private lastDeletedSessions: ApplicationContext["sessions"]["state"]["deletedSessions"] | null =
    null;
  readonly outboxStoreImport = createIdleImport(
    () =>
      import("../lib/chat/outbox-store-projection.ts").then((module): OutboxStoreRuntime => module),
    (runtime) => this.installOutboxStoreRuntime(runtime),
  );
  private lastNativeNavState: NativeNavState | undefined;
  didConsiderNativeRouteRestore = false;
  pendingNativeNewSession = false;
  readonly settingsPreloadTimers = new Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>();
  // Settings navigation is needed only after entering the settings takeover.
  // Keep its search, update-card, and sidebar rendering graph off the startup path.
  @state() settingsSidebarRenderer:
    | typeof import("../components/settings-sidebar.ts").renderSettingsSidebar
    | null = null;
  @state() settingsSidebarLoadFailed = false;
  private settingsSidebarRuntime: Promise<unknown> | null = null;
  private readonly sidebarUpdateCardImport = createIdleImport(
    () => import("../components/sidebar-update-card.ts"),
  );

  loadSettingsSidebarRenderer(): void {
    this.settingsSidebarRuntime ??= import("../components/settings-sidebar.ts")
      .then((module) => {
        this.settingsSidebarRenderer = module.renderSettingsSidebar;
        this.settingsSidebarLoadFailed = false;
      })
      .catch(() => {
        this.settingsSidebarLoadFailed = true;
        this.settingsSidebarRuntime = null;
      });
  }

  retrySettingsSidebarRenderer(): void {
    this.settingsSidebarLoadFailed = false;
    this.loadSettingsSidebarRenderer();
  }

  private loadSidebarUpdateCard(): void {
    void this.sidebarUpdateCardImport.load().catch((error: unknown) => {
      if (isStaleChunkImportError(error)) {
        void scheduleStaleChunkReload();
      }
    });
  }
  // Lazy: the critical-notice module stays out of the startup chunk (perf
  // budget); loaded on the first session.observer digest after boot.
  criticalNoticeRuntime: Promise<
    typeof import("../pages/chat/critical-observer-notice.runtime.ts")
  > | null = null;
  // Lazy for the same reason: the pairing modal is opened from Settings, not at
  // boot, so its template, icons, and strings stay off the startup chunk.
  @state() devicePairSetupRenderer:
    | typeof import("../pages/devices/view-pairing.runtime.ts").renderDevicePairSetup
    | null = null;
  // A rejected chunk must stay visible: the overlay is already open, so the
  // shell renders a recoverable failure instead of an empty dialog frame.
  @state() devicePairSetupLoadFailed = false;
  private devicePairSetupRuntime: Promise<unknown> | null = null;

  loadDevicePairSetupRenderer(): void {
    this.devicePairSetupRuntime ??= import("../pages/devices/view-pairing.runtime.ts")
      .then((module) => {
        this.devicePairSetupRenderer = module.renderDevicePairSetup;
        this.devicePairSetupLoadFailed = false;
      })
      .catch(() => {
        // Clearing the promise is what makes the retry below able to refetch.
        this.devicePairSetupLoadFailed = true;
        this.devicePairSetupRuntime = null;
      });
  }

  retryDevicePairSetupRenderer(): void {
    this.devicePairSetupLoadFailed = false;
    this.loadDevicePairSetupRenderer();
  }
  private readonly subscriptions = new SubscriptionsController(this);
  private readonly shellNavigation = new ShellNavigationOwner(this);
  private readonly shellChrome = new ShellChromeOwner(this);
  private readonly shellGateway = new ShellGatewayOwner(this);

  get context(): ApplicationContext<RouteId> | undefined {
    return this.runtime?.context;
  }

  get onboardingMode(): boolean {
    const routeSearch = this.routeState.location?.search;
    return routeSearch === undefined ? this.onboarding : resolveOnboardingMode(routeSearch);
  }

  private get workspaceChromeVisible(): boolean {
    const routeId = this.routeState.routeId;
    // Hidden workspace chrome must not preload its sidebar and panel graphs.
    return routeId !== undefined && !isSettingsNavigationRoute(routeId) && !this.onboardingMode;
  }

  storedOutboxScopeHost(context: ApplicationContext<RouteId>): StoredOutboxScopeHost {
    const gatewaySnapshot = context.gateway.snapshot;
    return {
      settings: { gatewayUrl: context.gateway.connection.gatewayUrl },
      assistantAgentId: gatewaySnapshot.assistantAgentId,
      agentsList: context.agents.state.agentsList,
      hello: gatewaySnapshot.hello,
    };
  }

  private chatTitleContext(
    context: ApplicationContext<RouteId>,
    outboxScopeHost: StoredOutboxScopeHost,
  ): string {
    const sessionKey = this.activeSessionKey;
    // An agent's main chat is its identity, so use its roster label when available.
    const parsed = parseAgentSessionKey(sessionKey);
    const mainAgentId = isUiGlobalSessionKey(sessionKey)
      ? resolveUiKnownSelectedGlobalAgentId(outboxScopeHost)
      : parsed?.rest === resolveUiConfiguredMainKey(outboxScopeHost)
        ? normalizeAgentId(parsed.agentId)
        : undefined;
    const agent = mainAgentId
      ? context.agents.state.agentsList?.agents.find(
          (candidate) => normalizeAgentId(candidate.id) === mainAgentId,
        )
      : undefined;
    return agent
      ? normalizeAgentLabel(agent)
      : resolveSessionDisplayName(
          sessionKey,
          context.sessions.state.result?.sessions.find((session) => session.key === sessionKey),
        );
  }

  constructor() {
    super();
    this.subscriptions
      .effect(
        () => this.context,
        (context) => {
          if (this.pendingNativeNewSession) {
            this.pendingNativeNewSession = false;
            this.handleNativeNewSession();
          }
          return () => {
            if (this.context !== context) {
              this.resetForContextEpoch();
            }
          };
        },
      )
      .watch(
        () => this.context?.nativeDeviceSettings,
        (settings, notify) => settings.subscribe(notify),
      )
      .watch(
        () => this.context?.navigation,
        (navigation, notify) => navigation.subscribe(notify),
      )
      .watch(
        () => this.context?.plugins,
        (plugins, notify) => plugins.subscribe(notify),
      )
      .watch(
        () => this.context?.agentSelection,
        (selection, notify) => selection.subscribe(notify),
      )
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeGateway(gateway.snapshot),
      )
      .effect(
        () => this.context?.gateway,
        (gateway) => gateway.subscribeEvents(this.handleGatewayEvent),
      )
      .watch(
        () => this.context?.config,
        (config, notify) => config.subscribe(notify),
      )
      .watch(
        () => this.context?.theme,
        (theme, notify) => theme.subscribe(notify),
      )
      .watch(
        () => this.context?.agents,
        (agents, notify) => agents.subscribe(notify),
        (agents) => {
          const snapshot = this.context?.gateway.snapshot;
          if (snapshot) {
            this.ensureAgentsList(snapshot, agents);
          }
        },
      )
      .effect(
        () => this.runtime?.router,
        (router) => {
          this.updateRouteState(selectShellRouteState(router.getState()));
          return router.subscribeSelector(
            selectShellRouteState,
            (routeState) => this.updateRouteState(routeState),
            equalShellRouteState,
          );
        },
      )
      .watch(
        () => this.context?.overlays,
        (overlays, notify) => overlays.subscribe(notify),
      )
      .watch(
        () => this.context?.sessions,
        (sessions, notify) => sessions.subscribe(notify),
        (sessions) => {
          this.observeDeletedSessions(sessions.state);
          this.recoverDeletedActiveSession(sessions.state);
        },
      )
      .watch(
        () => this.context?.runtimeConfig,
        (runtimeConfig, notify) =>
          runtimeConfig.subscribe(() => {
            this.reconcileServerUiPrefs(runtimeConfig);
            notify();
          }),
        (runtimeConfig) => {
          const snapshot = this.context?.gateway.snapshot;
          if (snapshot) {
            this.ensureRuntimeConfig(snapshot, runtimeConfig);
          }
          this.reconcileServerUiPrefs(runtimeConfig);
        },
      );
  }

  /**
   * Server config (ui.prefs) is the canonical home for synced display prefs;
   * apply server-side deltas to the browser mirror whenever a config snapshot
   * lands (connect, settings pages, reloads).
   */
  private reconcileServerUiPrefs(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    this.shellGateway.reconcileServerUiPrefs(runtimeConfig);
  }

  private reconcileCommittedServerUiPrefs(
    runtimeConfig: ApplicationContext["runtimeConfig"],
    needsRefresh: boolean,
    retainedLocal = false,
  ) {
    this.shellGateway.reconcileCommittedServerUiPrefs(runtimeConfig, needsRefresh, retainedLocal);
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.outboxStoreRuntime) {
      this.installOutboxStoreRuntime(this.outboxStoreRuntime);
    }
    this.outboxStoreImport.schedule();
    this.shellChrome.connect();
    // Write-through of synced display prefs to config ui.prefs. Server-applied
    // deltas are suppressed so a reconcile never echoes back to the gateway.
    setSettingsChangeListener((previous, next) => {
      if (isApplyingServerUiPrefs()) {
        return;
      }
      const prefs = changedServerUiPrefs(previous, next);
      const runtimeConfig = this.context?.runtimeConfig;
      if (prefs && runtimeConfig) {
        pushServerUiPrefs(runtimeConfig, prefs, {
          profile: this.context?.gateway.snapshot,
          afterCommit: ({ needsRefresh, retainedLocal }) =>
            this.reconcileCommittedServerUiPrefs(runtimeConfig, needsRefresh, retainedLocal),
        });
      }
    });
  }

  override disconnectedCallback() {
    this.shellChrome.disconnect();
    syncControlUiSystemChrome();
    this.outboxStoreImport.dispose();
    this.sidebarUpdateCardImport.dispose();
    this.outboxStoreUnsubscribe?.();
    this.outboxStoreUnsubscribe = null;
    this.lastLocalePrefSignature = null;
    setSettingsChangeListener(null);
    this.resetForDocumentDisconnect();
    super.disconnectedCallback();
  }

  private installOutboxStoreRuntime(runtime: OutboxStoreRuntime) {
    this.outboxStoreRuntime = runtime;
    if (!this.isConnected) {
      return;
    }
    this.outboxStoreUnsubscribe?.();
    this.outboxStoreUnsubscribe = runtime.subscribeStoredChatOutboxChanges(() =>
      this.requestUpdate(),
    );
    this.requestUpdate();
  }

  private resetForContextEpoch() {
    this.shellChrome.abandonPendingLazyActionForContext();
    this.resetShellState();
  }

  private resetForDocumentDisconnect() {
    this.shellChrome.preservePendingLazyActionForReload();
    this.resetShellState();
  }

  private resetShellState() {
    this.navDrawerOpen = false;
    this.desktopNavigationExpanded = false;
    this.navDrawerTrigger = null;
    this.lastWorkspaceLocation = null;
    this.activeSessionKey = "";
    this.settingsSearchQuery = "";
    this.commandPaletteTarget = undefined;
    this.lastDeletedSessions = null;
    this.shellGateway.reset();
    for (const timer of this.settingsPreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.settingsPreloadTimers.clear();
  }

  selectChatSession(sessionKey: string, agentId?: string | null) {
    this.shellNavigation.selectChatSession(sessionKey, agentId);
  }
  private readonly handleGatewayEvent = (event: GatewayEventFrame) => {
    if (event.event === "config.changed" || event.event === "chat.metadata.changed") {
      const client = this.context?.gateway?.snapshot.client;
      if (client) {
        invalidateModelCatalogCache(client);
        invalidateChatMetadataStore(client);
      }
    }
    this.shellGateway.handleGatewayEvent(event);
  };

  readonly handleThemeChange = (event: CustomEvent<ThemeModeChangeDetail>) => {
    const context = this.context;
    if (!context) {
      return;
    }
    context.theme.setMode(event.detail.mode, event.detail.element);
  };

  async handleSettingsSearchQueryChange(nextQuery: string): Promise<void> {
    this.settingsSearchQuery = nextQuery;
    const runtimeConfig = this.context?.runtimeConfig;
    if (!runtimeConfig || !nextQuery.trim()) {
      return;
    }
    try {
      await runtimeConfig.ensureLoaded();
      if (this.context?.runtimeConfig === runtimeConfig) {
        await runtimeConfig.ensureSchemaLoaded();
      }
    } catch {
      // Runtime config state owns the visible load error; search stays usable.
    }
  }

  chatNavigationOptions(face: BoardFace, options?: ApplicationNavigationOptions) {
    return this.shellNavigation.chatNavigationOptions(face, options);
  }

  navigate(routeId: string, options?: ApplicationNavigationOptions) {
    this.shellNavigation.navigate(routeId, options);
  }

  replaceChatWithCurrentSession() {
    return this.shellNavigation.replaceChatWithCurrentSession();
  }

  recoverDeletedActiveSession(sessionState: ApplicationContext["sessions"]["state"]) {
    this.shellNavigation.recoverDeletedActiveSession(sessionState);
  }

  observeDeletedSessions(sessionState: ApplicationContext["sessions"]["state"]): void {
    const context = this.context;
    const deletedSessions = sessionState.deletedSessions;
    if (!context || Object.is(deletedSessions, this.lastDeletedSessions)) {
      return;
    }
    this.lastDeletedSessions = deletedSessions;
    if (deletedSessions.length === 0) {
      return;
    }
    void import("../lib/chat/composer-draft-retirement.runtime.ts").then(
      ({ retireDeletedComposerDrafts }) => retireDeletedComposerDrafts(context, deletedSessions),
      () => showToast({ message: t("sessionsView.draftCleanupFailed") }),
    );
  }

  exitSettings() {
    this.shellNavigation.exitSettings();
  }

  readonly toggleNavigationSurface = this.shellChrome.toggleNavigationSurface;

  readonly closeNavDrawer = this.shellChrome.closeNavDrawer;

  readonly resizeNavigation = this.shellChrome.resizeNavigation;

  openNewSession(agentId: string, target?: NewSessionTarget) {
    this.shellNavigation.openNewSession(agentId, target);
  }

  // Shipped Mac app builds without web chrome still drive these handlers.
  readonly handleNativeToggleSidebar = this.shellChrome.handleNativeToggleSidebar;
  readonly handleNativeOpenSearch = this.shellChrome.handleNativeOpenSearch;
  readonly handleNativeToggleSearch = this.shellChrome.handleNativeToggleSearch;
  readonly handleNativeNewSession = this.shellChrome.handleNativeNewSession;
  readonly handleNativeNavigate = this.shellChrome.handleNativeNavigate;
  readonly handleNativeHistoryState = this.shellChrome.handleNativeHistoryState;
  readonly handleWindowResize = this.shellChrome.handleWindowResize;
  readonly handleDocumentKeydown = this.shellChrome.handleDocumentKeydown;
  readonly openPalette = this.shellChrome.openPalette;
  readonly refreshControlUi = (): Promise<boolean> => {
    const context = this.context;
    if (!context) {
      return Promise.resolve(false);
    }
    return retryStaleChunkReloadWhenReachable({
      timeoutMs: 0,
      ...createGatewayControlUiReloadOptions(
        context.gateway,
        () => this.context === context && context.overlays.snapshot.controlUiRefreshRequired,
      ),
    });
  };
  readonly handleShellNavDrawerToggle = this.shellChrome.handleShellNavDrawerToggle;
  readonly openApprovals = this.shellChrome.openApprovals;
  readonly handleCommandPaletteSlashCommand = this.shellChrome.handleCommandPaletteSlashCommand;
  readonly restorePendingLazyAction = this.shellChrome.restorePendingLazyAction;
  readonly nativeNavCollapsed = this.shellChrome.nativeNavCollapsed;
  /** Keep the tab/window title on the active destination. Runs after every
   * render so route changes and locale switches both refresh it; before the
   * first committed route the static boot title from index.html stays. */
  private syncDocumentTitle() {
    const routeId = this.routeState.routeId;
    const context = this.context;
    if (!routeId || !context) {
      return;
    }
    const outboxScopeHost = this.storedOutboxScopeHost(context);
    let primaryContext = routeId === "custodian" ? t("nav.askOpenClaw") : titleForRoute(routeId);
    if (isSessionRouteId(routeId) && this.activeSessionKey) {
      primaryContext = this.chatTitleContext(context, outboxScopeHost) || primaryContext;
    }
    const gatewayDisconnected = context.gateway.snapshot.phase !== "connected";
    let title = formatDocumentTitle({
      context: primaryContext,
      attentionCount: context.overlays.snapshot.approvalQueue.length,
      gatewayDisconnected,
      ...(gatewayDisconnected && {
        queuedCount: this.outboxStoreRuntime?.summarizeStoredChatOutboxes(outboxScopeHost).total,
      }),
    });
    const environment = context.config?.current.environment;
    if (environment) {
      title += ` · ${environment.label}`;
    }
    if (document.title !== title) {
      document.title = title;
    }
  }

  override updated(changed: PropertyValues<this>) {
    this.syncDocumentTitle();
    // Theme and breakpoint owners sync their changes; route/runtime changes
    // can change whether the committed shell uses the chat background.
    if (changed.has("routeState") || changed.has("runtime")) {
      syncControlUiSystemChrome();
    }
    // Render-gated pending lazy actions replay on the update that first
    // renders their element, independent of further context updates.
    this.restorePendingLazyAction();
    if (
      !customElements.get("openclaw-sidebar-update-card") &&
      this.querySelector("openclaw-sidebar-update-card")
    ) {
      this.loadSidebarUpdateCard();
    }
    const chatPage = this.querySelector<ChatPage>("openclaw-chat-page");
    if (chatPage) {
      chatPage.navDrawerOpen = this.navDrawerOpen && !this.onboardingMode;
    }
    const context = this.context;
    if (!context) {
      return;
    }
    if (this.workspaceChromeVisible) {
      this.shellChrome.panels.restore();
    }
    if ((context.overlays?.snapshot.approvalQueue.length ?? 0) > 0) {
      this.lazyCustomElements.preload(this.execApprovalElement);
    }
    this.restorePendingLazyAction();
    const navState = {
      collapsed: this.nativeNavCollapsed(),
      width: context.navigation.snapshot.navWidth,
    } satisfies NativeNavState;
    if (
      navState.collapsed === this.lastNativeNavState?.collapsed &&
      navState.width === this.lastNativeNavState.width
    ) {
      return;
    }
    this.lastNativeNavState = navState;
    // Shipped Mac app builds without web chrome still consume this bridge.
    postNativeNavState(navState);
  }

  private synchronizeGateway(snapshot: ApplicationContext["gateway"]["snapshot"]) {
    if (this.previousGatewayPhase === "connected" && snapshot.phase !== "connected") {
      // A disconnect can retain the browser client, so object identity alone
      // cannot keep metadata alive across logical Gateway connections.
      if (snapshot.client) {
        invalidateModelCatalogCache(snapshot.client);
        invalidateChatMetadataStore(snapshot.client);
      }
    }
    this.shellGateway.synchronizeGateway(snapshot);
  }

  private ensureRuntimeConfig(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    runtimeConfig = this.context?.runtimeConfig,
  ) {
    void this.shellGateway.ensureRuntimeConfig(snapshot, runtimeConfig).catch(() => undefined);
  }

  enabledRouteIds(): readonly RouteId[] {
    return APP_ROUTE_IDS;
  }

  /** Agent targeted by the open new-session route, keyed off its ?agent param. */
  newSessionRouteAgentId(): string {
    return this.shellNavigation.newSessionRouteAgentId();
  }

  ensureAgentsList(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    agents = this.context?.agents,
  ) {
    void this.shellGateway.ensureAgentsList(snapshot, agents).catch(() => undefined);
  }

  private updateRouteState(routeState: ShellRouteState) {
    this.shellNavigation.updateRouteState(routeState);
  }

  override render() {
    if (this.workspaceChromeVisible) {
      this.lazyCustomElements.preload(APP_SIDEBAR_ELEMENT);
    }
    return renderApplicationShell(this);
  }
}
if (!customElements.get("openclaw-app")) {
  customElements.define("openclaw-app", OpenClawApp);
}
if (!customElements.get("openclaw-app-shell")) {
  customElements.define("openclaw-app-shell", OpenClawShell);
}
