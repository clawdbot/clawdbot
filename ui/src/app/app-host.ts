import { ContextProvider } from "@lit/context";
import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import { hasStoredGatewayAuth, type GatewayBrowserClient } from "../api/gateway.ts";
import "../components/app-sidebar.ts";
import "../components/app-topbar.ts";
import "../components/connection-banner.ts";
import "../components/exec-approval.ts";
import "../components/gateway-url-confirmation.ts";
import "../components/github-link-hovercard.ts";
import "../components/login-gate.ts";
import "../components/resizable-divider.ts";
import "../components/terminal/terminal-panel.ts";
import "../components/tooltip.ts";
import "../components/update-banner.ts";
import { isSettingsNavigationRoute, type SidebarNavRoute } from "../app-navigation.ts";
import { APP_ROUTE_IDS, isRouteId, type RouteId } from "../app-routes.ts";
import {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPalette,
  type CommandPaletteTargetDetail,
} from "../components/command-palette.ts";
import { renderSettingsSidebar } from "../components/settings-sidebar.ts";
import type { ThemeModeChangeDetail } from "../components/theme-mode-toggle.ts";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../lib/plugin-activation.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { renderDevicePairSetup } from "../pages/nodes/view-pairing.ts";
import { pluginTabKey, pluginTabRefFromSearch } from "../pages/plugin/route.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationNavigationOptions,
} from "./context.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";
import { controlUiPublicAssetPath } from "./public-assets.ts";
import { selectRenderedRouteMatch } from "./router-outlet.ts";
import { NAV_WIDTH_MAX, NAV_WIDTH_MIN } from "./settings.ts";

type ShellRouteState = {
  routeId?: RouteId;
  location?: RouteLocation;
};

// Stable references so the sidebar's enabledRouteIds property does not churn
// on every shell render.
const ROUTE_IDS_WITHOUT_WORKBOARD = APP_ROUTE_IDS.filter((routeId) => routeId !== "workboard");

function selectShellRouteState(routerState: RouterState<RouteId>): ShellRouteState {
  const match = selectRenderedRouteMatch(routerState.matches[0], routerState.pendingMatches[0]);
  return match
    ? {
        routeId: match.routeId,
        location: match.location,
      }
    : {};
}

function equalShellRouteState(previous: ShellRouteState, next: ShellRouteState): boolean {
  return (
    previous.routeId === next.routeId &&
    previous.location?.pathname === next.location?.pathname &&
    previous.location?.search === next.location?.search &&
    previous.location?.hash === next.location?.hash
  );
}

function resolveOnboardingMode(): boolean {
  const raw = new URLSearchParams(globalThis.location?.search ?? "").get("onboarding");
  return raw !== null && /^(?:1|true|yes|on)$/iu.test(raw.trim());
}

/**
 * Terminal-only document mode (`?view=terminal`): the mobile apps embed the
 * terminal as a full-screen WebView page instead of the whole Control UI.
 * Fixed per document load — the apps construct the URL, users never toggle it.
 */
function isTerminalOnlyView(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? "").get("view") === "terminal";
}

function resolveTerminalThemeMode(): "dark" | "light" {
  return document.documentElement.dataset.themeMode === "light" ? "light" : "dark";
}

// The mascot SVG animates via SMIL, so it must load through <img src> —
// inlining the markup would freeze it (see ui/public/favicon.svg).
function renderConnectingSplash(basePath: string) {
  return html`
    <main class="connect-splash" role="status" aria-live="polite" aria-label=${t("common.loading")}>
      <img
        class="connect-splash__logo"
        src=${controlUiPublicAssetPath("favicon.svg", basePath)}
        alt=""
      />
    </main>
  `;
}

function isTerminalAvailable(
  snapshot: ApplicationContext["gateway"]["snapshot"],
  terminalEnabled: boolean,
): boolean {
  if (!snapshot.connected || !terminalEnabled) {
    return false;
  }
  return (
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    isGatewayMethodAdvertised(snapshot, "terminal.open") === true
  );
}

function isMobileNavLayout(): boolean {
  return globalThis.matchMedia?.("(max-width: 1100px)").matches ?? false;
}

class OpenClawApp extends OpenClawLightDomElement {
  // Pinned while a connect submitted from the visible login gate is in
  // flight, so a failed manual attempt cannot flash the shell in between.
  @state() private loginGatePinned = false;
  @state() private loginGatewayUrl = "";
  @state() private loginToken = "";
  @state() private loginPassword = "";
  @state() private loginShowGatewayToken = false;
  @state() private loginShowGatewayPassword = false;
  @state() private pendingGatewayUrl: string | null = null;
  @state() private onboarding = resolveOnboardingMode();

  private readonly terminalOnly = isTerminalOnlyView();
  // Fixed at page load: whether this browser held credentials (token,
  // password, or stored device token) before the first connect attempt.
  // Later manual gate submissions are covered by loginGatePinned instead.
  private initialAuthPresent = false;
  private runtime: ApplicationRuntime | undefined;
  private readonly contextProvider = new ContextProvider(this, {
    context: applicationContext,
  });
  private readonly subscriptions = new SubscriptionsController(this);
  private loginGatewaySource: ApplicationContext["gateway"] | null = null;
  private loginConnectionClient: GatewayBrowserClient | null = null;

  private get context(): ApplicationContext<RouteId> | undefined {
    return this.runtime?.context;
  }

  constructor() {
    super();
    this.subscriptions
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeGateway(gateway),
      )
      .watch(
        () => (this.terminalOnly ? this.context?.config : undefined),
        (config, notify) => config.subscribe(notify),
      );
  }

  override connectedCallback() {
    super.connectedCallback();
    this.resetLoginSensitivePresentation();
    this.runtime = bootstrapApplication();
    const context = this.runtime.context;
    this.initialAuthPresent = hasStoredGatewayAuth(context.gateway.connection);
    this.pendingGatewayUrl = this.runtime.pendingGatewayConnection?.gatewayUrl ?? null;
    // Context identity changes only across a full app-tree connection epoch;
    // descendants reconnect and rebuild their controller-owned state afterward.
    this.contextProvider.setValue(context);
    this.syncLoginConnection();
    // The runtime is created after controller hostConnected hooks run. Ensure
    // their lazy source getters bind on both the initial mount and reconnect.
    this.requestUpdate();
    void this.runtime.start().catch((error: unknown) => {
      console.error("[openclaw] application start failed", error);
    });
  }

  override disconnectedCallback() {
    // Stop reactive subscriptions before disposing their application sources.
    this.subscriptions.clear();
    this.runtime?.stop();
    this.runtime = undefined;
    this.loginGatewaySource = null;
    this.loginConnectionClient = null;
    this.pendingGatewayUrl = null;
    this.resetLoginSensitivePresentation();
    super.disconnectedCallback();
  }

  private synchronizeGateway(gateway: ApplicationContext["gateway"]) {
    const sourceChanged = gateway !== this.loginGatewaySource;
    if (sourceChanged) {
      this.loginGatewaySource = gateway;
      this.loginConnectionClient = null;
      this.resetLoginSensitivePresentation();
    }
    const snapshot = gateway.snapshot;
    const clientChanged = snapshot.client !== this.loginConnectionClient;
    if (clientChanged) {
      this.loginConnectionClient = snapshot.client;
      this.resetLoginSensitivePresentation();
    }
    if (sourceChanged || clientChanged) {
      this.syncLoginConnection(gateway);
    }
    if (snapshot.connected) {
      this.loginGatePinned = false;
    }
  }

  private syncLoginConnection(gateway = this.context?.gateway) {
    const connection = gateway?.connection;
    if (!connection) {
      return;
    }
    this.loginGatewayUrl = connection.gatewayUrl;
    this.loginToken = connection.token;
    this.loginPassword = connection.password;
  }

  private resetLoginSensitivePresentation() {
    this.loginShowGatewayToken = false;
    this.loginShowGatewayPassword = false;
  }

  override render() {
    const context = this.context;
    const runtime = this.runtime;
    if (!context || !runtime) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const gatewaySnapshot = context.gateway.snapshot;
    const gatewayUrlConfirmation = this.pendingGatewayUrl
      ? html`
          <openclaw-gateway-url-confirmation
            .props=${{
              pendingGatewayUrl: this.pendingGatewayUrl,
              onConfirm: () => {
                runtime.confirmPendingGatewayConnection();
                this.pendingGatewayUrl = null;
              },
              onCancel: () => {
                runtime.cancelPendingGatewayConnection();
                this.pendingGatewayUrl = null;
              },
            }}
          ></openclaw-gateway-url-confirmation>
        `
      : nothing;
    // Embedded mobile terminals own the whole document. Keep the generic login
    // gate out of this path or a connecting native session exposes Web UI chrome.
    if (this.terminalOnly) {
      const terminalAvailable = isTerminalAvailable(
        gatewaySnapshot,
        context.config.current.terminalEnabled ?? false,
      );
      return html`
        <openclaw-terminal-panel
          .client=${gatewaySnapshot.connected ? gatewaySnapshot.client : null}
          .available=${terminalAvailable}
          .themeMode=${resolveTerminalThemeMode()}
          fullscreen
        ></openclaw-terminal-panel>
        ${!terminalAvailable && (gatewaySnapshot.connected || gatewaySnapshot.lastError)
          ? html`<div class="terminal-view-unavailable">${t("terminal.unavailable")}</div>`
          : nothing}
      `;
    }
    // Transport drops after an established session keep the shell mounted
    // (offline banner + client auto-retry); the login gate is reserved for
    // credential-less first connects, credential rejections, and manual gate
    // submissions. A first connect backed by stored credentials paints the
    // connecting splash instead of flashing the login gate; the gate returns
    // the moment the attempt fails (lastError set on every close).
    const initialConnectPending =
      this.initialAuthPresent &&
      !gatewaySnapshot.connected &&
      !gatewaySnapshot.reconnecting &&
      !this.loginGatePinned &&
      gatewaySnapshot.lastError === null &&
      gatewaySnapshot.client !== null;
    if (initialConnectPending) {
      return html`
        <openclaw-tooltip-provider>
          ${renderConnectingSplash(context.basePath)} ${gatewayUrlConfirmation}
        </openclaw-tooltip-provider>
      `;
    }
    const showLoginGate =
      !gatewaySnapshot.connected && (this.loginGatePinned || !gatewaySnapshot.reconnecting);
    if (showLoginGate) {
      return html`
        <openclaw-tooltip-provider>
          <openclaw-login-gate
            .props=${{
              basePath: context.basePath,
              connected: gatewaySnapshot.connected,
              lastError: gatewaySnapshot.lastError,
              lastErrorCode: gatewaySnapshot.lastErrorCode,
              hasToken: Boolean(this.loginToken.trim()),
              hasPassword: Boolean(this.loginPassword.trim()),
              gatewayUrl: this.loginGatewayUrl,
              token: this.loginToken,
              password: this.loginPassword,
              showGatewayToken: this.loginShowGatewayToken,
              showGatewayPassword: this.loginShowGatewayPassword,
              onGatewayUrlChange: (value: string) => {
                this.loginGatewayUrl = value;
              },
              onTokenChange: (value: string) => {
                this.loginToken = value;
              },
              onPasswordChange: (value: string) => {
                this.loginPassword = value;
              },
              onToggleGatewayToken: () => {
                this.loginShowGatewayToken = !this.loginShowGatewayToken;
              },
              onToggleGatewayPassword: () => {
                this.loginShowGatewayPassword = !this.loginShowGatewayPassword;
              },
              onConnect: () => {
                this.loginGatePinned = true;
                context.gateway.connect({
                  gatewayUrl: this.loginGatewayUrl,
                  token: this.loginToken,
                  password: this.loginPassword,
                });
              },
            }}
          ></openclaw-login-gate>
          ${gatewayUrlConfirmation}
        </openclaw-tooltip-provider>
      `;
    }
    return html`
      <openclaw-tooltip-provider>
        <openclaw-github-link-hovercard-provider .client=${gatewaySnapshot.client}>
          ${gatewayUrlConfirmation}
          <openclaw-app-shell
            .runtime=${runtime}
            .onboarding=${this.onboarding}
          ></openclaw-app-shell>
        </openclaw-github-link-hovercard-provider>
      </openclaw-tooltip-provider>
    `;
  }
}

class OpenClawShell extends OpenClawLightDomElement {
  @property({ attribute: false }) runtime?: ApplicationRuntime;
  @property({ attribute: false }) onboarding = false;

  @state() private navDrawerOpen = false;
  @state() private activeSessionKey = "";
  @state() private routeState: ShellRouteState = {};
  @query("openclaw-command-palette") private commandPalette?: CommandPalette;
  private commandPaletteTarget?: CommandPaletteTargetDetail;
  private navDrawerTrigger: HTMLElement | null = null;
  // Where "Back to app" / Escape leaves the settings takeover; falls back to
  // chat (the app default route) when settings was the entry point.
  private lastWorkspaceLocation: { routeId: RouteId; search: string } | null = null;
  private agentsListClient: GatewayBrowserClient | null = null;
  private agentsListSource: ApplicationContext["agents"] | null = null;
  private sessionKeyClient: GatewayBrowserClient | null = null;
  private runtimeConfigClient: GatewayBrowserClient | null = null;
  private runtimeConfigSource: ApplicationContext["runtimeConfig"] | null = null;
  private readonly settingsPreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();
  private readonly subscriptions = new SubscriptionsController(this);

  private get context(): ApplicationContext<RouteId> | undefined {
    return this.runtime?.context;
  }

  constructor() {
    super();
    this.subscriptions
      .effect(
        () => this.context,
        () => () => this.resetShellEpochState(),
      )
      .watch(
        () => this.context?.navigation,
        (navigation, notify) => navigation.subscribe(notify),
      )
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeGateway(gateway.snapshot),
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
        () => this.context?.runtimeConfig,
        (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
        (runtimeConfig) => {
          const snapshot = this.context?.gateway.snapshot;
          if (snapshot) {
            this.ensureRuntimeConfig(snapshot, runtimeConfig);
          }
        },
      );
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener(COMMAND_PALETTE_TARGET_EVENT, this.handleCommandPaletteTarget);
    document.addEventListener("keydown", this.handleDocumentKeydown);
    window.addEventListener("resize", this.handleWindowResize);
  }

  override disconnectedCallback() {
    this.removeEventListener(COMMAND_PALETTE_TARGET_EVENT, this.handleCommandPaletteTarget);
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    window.removeEventListener("resize", this.handleWindowResize);
    this.resetShellEpochState();
    super.disconnectedCallback();
  }

  private resetShellEpochState() {
    this.navDrawerOpen = false;
    this.navDrawerTrigger = null;
    this.lastWorkspaceLocation = null;
    this.activeSessionKey = "";
    this.commandPaletteTarget = undefined;
    this.agentsListClient = null;
    this.agentsListSource = null;
    this.sessionKeyClient = null;
    this.runtimeConfigClient = null;
    this.runtimeConfigSource = null;
    for (const timer of this.settingsPreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.settingsPreloadTimers.clear();
  }

  private readonly handleThemeChange = (event: CustomEvent<ThemeModeChangeDetail>) => {
    const context = this.context;
    if (!context) {
      return;
    }
    context.theme.setMode(event.detail.mode, event.detail.element);
  };

  private chatNavigationOptions(options?: ApplicationNavigationOptions) {
    if (options) {
      return options;
    }
    const sessionKey = this.activeSessionKey.trim();
    return sessionKey ? { search: searchForSession(sessionKey) } : undefined;
  }

  private navigate(routeId: string, options?: ApplicationNavigationOptions) {
    const context = this.context;
    if (!context || !isRouteId(routeId)) {
      return;
    }
    this.closeNavDrawer({ restoreFocus: true });
    context.navigate(routeId, routeId === "chat" ? this.chatNavigationOptions(options) : options);
  }

  private replaceChatWithCurrentSession() {
    this.context?.replace("chat", this.chatNavigationOptions());
  }

  private isSettingsTakeover(): boolean {
    const routeId = this.routeState.routeId;
    return routeId !== undefined && isSettingsNavigationRoute(routeId);
  }

  private exitSettings() {
    const previous = this.lastWorkspaceLocation;
    if (previous) {
      this.navigate(previous.routeId, previous.search ? { search: previous.search } : undefined);
      return;
    }
    this.navigate("chat");
  }

  private toggleNavigationSurface(trigger?: HTMLElement) {
    const context = this.context;
    // Desktop settings takeover has no app nav to collapse; the mobile drawer
    // hosts the settings sidebar and must keep toggling.
    if (!context || this.onboarding || (this.isSettingsTakeover() && !isMobileNavLayout())) {
      return;
    }
    if (isMobileNavLayout()) {
      if (this.navDrawerOpen) {
        this.closeNavDrawer({ restoreFocus: Boolean(trigger) });
        return;
      }
      this.navDrawerTrigger = trigger ?? null;
      this.navDrawerOpen = true;
      return;
    }
    // A drawer that survived a breakpoint change is visually expanded even
    // when the persisted desktop preference says collapsed.
    const nextNavCollapsed = this.navDrawerOpen || !context.navigation.snapshot.navCollapsed;
    this.closeNavDrawer();
    context.navigation.update({
      navCollapsed: nextNavCollapsed,
    });
  }

  private closeNavDrawer(options: { restoreFocus?: boolean } = {}) {
    const focusTarget = options.restoreFocus ? this.navDrawerTrigger : null;
    this.navDrawerOpen = false;
    this.navDrawerTrigger = null;
    if (!(focusTarget instanceof HTMLElement) || !focusTarget.isConnected) {
      return;
    }
    requestAnimationFrame(() => {
      if (focusTarget.isConnected) {
        focusTarget.focus();
      }
    });
  }

  private resizeNavigation(splitRatio: number) {
    const shell = this.querySelector<HTMLElement>(".shell");
    const context = this.context;
    if (!shell || !context) {
      return;
    }
    const navWidth = Math.round(
      Math.min(NAV_WIDTH_MAX, Math.max(NAV_WIDTH_MIN, splitRatio * shell.clientWidth)),
    );
    context.navigation.update({ navWidth });
  }

  private readonly handleWindowResize = () => {
    this.requestUpdate();
  };

  private readonly handleShellKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Escape" || !this.navDrawerOpen) {
      return;
    }
    event.preventDefault();
    this.closeNavDrawer({ restoreFocus: true });
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) {
      return;
    }
    const plainKey = !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey;
    if (plainKey && event.key === "Escape" && this.isSettingsTakeover()) {
      if (this.navDrawerOpen) {
        event.preventDefault();
        this.closeNavDrawer({ restoreFocus: true });
        return;
      }
      if (this.shouldIgnoreSettingsEscape(event)) {
        return;
      }
      event.preventDefault();
      this.exitSettings();
      return;
    }
    if (
      event.altKey ||
      event.shiftKey ||
      !event.metaKey ||
      event.ctrlKey ||
      event.key.toLowerCase() !== "b"
    ) {
      return;
    }
    event.preventDefault();
    this.toggleNavigationSurface();
  };

  /**
   * Escape only exits settings when nothing else claims it: open dialogs,
   * palette, menus, and text inputs keep their native dismiss/blur behavior.
   */
  private shouldIgnoreSettingsEscape(event: KeyboardEvent): boolean {
    const overlaySnapshot = this.context?.overlays.snapshot;
    if (
      this.commandPalette?.isOpen ||
      overlaySnapshot?.devicePairSetupOpen ||
      (overlaySnapshot?.approvalQueue.length ?? 0) > 0 ||
      document.querySelector("dialog[open]")
    ) {
      return true;
    }
    const target = event.target;
    return (
      target instanceof Element &&
      target.closest(
        "input, textarea, select, [contenteditable], dialog, [role='dialog'], [role='menu'], [role='listbox']",
      ) !== null
    );
  }

  private readonly openPalette = () => {
    this.commandPalette?.openPalette();
  };

  private readonly handleCommandPaletteSlashCommand = (command: string) => {
    const chatHandler = this.commandPaletteTarget?.owner.isConnected
      ? this.commandPaletteTarget.onSlashCommand
      : null;
    if (chatHandler) {
      chatHandler(command);
      return;
    }
    // Keep Chat's in-place draft path fast; other routes hand the draft through navigation.
    const search = new URLSearchParams(this.chatNavigationOptions()?.search);
    search.set("draft", command.endsWith(" ") ? command : `${command} `);
    this.navigate("chat", { search: `?${search.toString()}` });
  };

  private readonly handleCommandPaletteTarget = (event: Event) => {
    const detail = (event as CustomEvent<CommandPaletteTargetDetail>).detail;
    if (!detail || !(detail.owner instanceof Element)) {
      return;
    }
    if (detail.onSlashCommand) {
      this.commandPaletteTarget = detail;
    } else if (this.commandPaletteTarget?.owner === detail.owner) {
      this.commandPaletteTarget = undefined;
    }
    this.requestUpdate();
  };

  private synchronizeGateway(snapshot: ApplicationContext["gateway"]["snapshot"]) {
    this.updateGatewaySessionKey(snapshot);
    this.ensureAgentsList(snapshot);
    this.ensureRuntimeConfig(snapshot);
  }

  private ensureRuntimeConfig(
    snapshot: {
      client: GatewayBrowserClient | null;
      connected: boolean;
    },
    runtimeConfig = this.context?.runtimeConfig,
  ) {
    // The sidebar hides config-gated routes (Workboard), so the snapshot must
    // load eagerly instead of waiting for a page that happens to fetch it.
    if (!snapshot.connected || !snapshot.client || !runtimeConfig) {
      this.runtimeConfigClient = null;
      return;
    }
    if (
      this.runtimeConfigClient === snapshot.client &&
      this.runtimeConfigSource === runtimeConfig
    ) {
      return;
    }
    this.runtimeConfigClient = snapshot.client;
    this.runtimeConfigSource = runtimeConfig;
    void runtimeConfig.ensureLoaded();
  }

  private enabledRouteIds(): readonly RouteId[] {
    return isWorkboardEnabledInConfigSnapshot(this.context?.runtimeConfig.state.configSnapshot)
      ? APP_ROUTE_IDS
      : ROUTE_IDS_WITHOUT_WORKBOARD;
  }

  private ensureAgentsList(
    snapshot: { client: GatewayBrowserClient | null; connected: boolean },
    agents = this.context?.agents,
  ) {
    if (!snapshot.connected || !snapshot.client) {
      this.agentsListClient = null;
      return;
    }
    const routeId = this.routeState.routeId;
    if (!agents || !routeId || routeId === "chat" || agents.state.agentsList) {
      return;
    }
    if (this.agentsListClient === snapshot.client && this.agentsListSource === agents) {
      return;
    }
    this.agentsListClient = snapshot.client;
    this.agentsListSource = agents;
    void agents.ensureList();
  }

  private updateGatewaySessionKey(snapshot: {
    client: GatewayBrowserClient | null;
    sessionKey: string;
  }) {
    const sessionKey = snapshot.sessionKey.trim();
    if (snapshot.client === this.sessionKeyClient && sessionKey === this.activeSessionKey) {
      return;
    }
    this.sessionKeyClient = snapshot.client;
    if (sessionKey) {
      this.activeSessionKey = sessionKey;
    }
  }

  private updateRouteState(routeState: ShellRouteState) {
    this.routeState = routeState;
    const context = this.context;
    if (context) {
      this.ensureAgentsList(context.gateway.snapshot);
    }
    if (routeState.routeId && !isSettingsNavigationRoute(routeState.routeId)) {
      this.lastWorkspaceLocation = {
        routeId: routeState.routeId,
        search: routeState.location?.search ?? "",
      };
    }
    if (routeState.routeId !== "chat") {
      return;
    }
    const sessionKey = new URLSearchParams(routeState.location?.search).get("session")?.trim();
    if (sessionKey) {
      this.activeSessionKey = sessionKey;
    }
  }

  override render() {
    const context = this.context;
    const runtime = this.runtime;
    if (!context || !runtime) {
      return nothing;
    }
    const gatewaySnapshot = context.gateway.snapshot;
    const navigationSnapshot = context.navigation.snapshot;
    const overlaySnapshot = context.overlays.snapshot;
    const terminalAvailable = isTerminalAvailable(
      gatewaySnapshot,
      context.config.current.terminalEnabled ?? false,
    );
    const activeRoute = this.routeState.routeId ?? "chat";
    // Plugin tabs share one route; the search picks the active item.
    const activePluginTabId =
      activeRoute === "plugin"
        ? pluginTabKey(pluginTabRefFromSearch(this.routeState.location?.search ?? ""))
        : "";
    const settingsTakeover = isSettingsNavigationRoute(activeRoute);
    const navDrawerOpen = this.navDrawerOpen && !this.onboarding;
    // Drawer navigation always opens expanded; the desktop collapse preference
    // stays persisted for when the viewport returns to the desktop layout.
    // The settings sidebar has a fixed width, so the collapse state pauses too.
    const navCollapsed = navigationSnapshot.navCollapsed && !navDrawerOpen && !settingsTakeover;
    const shellWidth = Math.max(globalThis.innerWidth || 0, NAV_WIDTH_MAX);
    return html`
      <openclaw-command-palette
        .onNavigate=${(routeId: RouteId) => this.navigate(routeId)}
        .onSelectSession=${(sessionKey: string) => {
          context.gateway.setSessionKey(sessionKey);
          this.navigate("chat", { search: searchForSession(sessionKey) });
        }}
        .onSlashCommand=${this.handleCommandPaletteSlashCommand}
      ></openclaw-command-palette>
      <div
        class="shell ${activeRoute === "chat" ? "shell--chat" : ""} ${navCollapsed
          ? "shell--nav-collapsed"
          : ""} ${navDrawerOpen ? "shell--nav-drawer-open" : ""} ${this.onboarding
          ? "shell--onboarding"
          : ""} ${settingsTakeover ? "shell--settings" : ""}"
        style=${`--shell-nav-expanded-width: ${navigationSnapshot.navWidth}px`}
        @keydown=${this.handleShellKeydown}
        @theme-change=${this.handleThemeChange}
      >
        <button
          type="button"
          class="shell-nav-backdrop"
          aria-label="Close navigation"
          @click=${() => this.closeNavDrawer({ restoreFocus: true })}
        ></button>
        <openclaw-app-topbar
          .basePath=${context.basePath}
          .searchDisabled=${false}
          .navDrawerOpen=${navDrawerOpen}
          .onboarding=${this.onboarding}
          .onOpenPalette=${this.openPalette}
          .onToggleDrawer=${(trigger: HTMLElement) => this.toggleNavigationSurface(trigger)}
        ></openclaw-app-topbar>
        <div class="shell-nav">
          ${settingsTakeover
            ? renderSettingsSidebar({
                basePath: context.basePath,
                activeRouteId: activeRoute,
                connected: gatewaySnapshot.connected,
                version:
                  context.config.current.serverVersion ??
                  gatewaySnapshot.hello?.server?.version ??
                  "",
                onExit: () => this.exitSettings(),
                onNavigate: (routeId) => this.navigate(routeId),
                onPreload: (routeId) => context.preload(routeId),
                preloadTimers: this.settingsPreloadTimers,
              })
            : html`<openclaw-app-sidebar
                .basePath=${context.basePath}
                .activeRouteId=${activeRoute}
                .activePluginTabId=${activePluginTabId}
                .enabledRouteIds=${this.enabledRouteIds()}
                .sessionKey=${this.activeSessionKey}
                .collapsed=${navCollapsed}
                .connected=${gatewaySnapshot.connected}
                .canPairDevice=${gatewaySnapshot.connected &&
                hasOperatorAdminAccess(gatewaySnapshot.hello?.auth ?? null)}
                .sidebarPinnedRoutes=${navigationSnapshot.sidebarPinnedRoutes}
                .sidebarMoreExpanded=${navigationSnapshot.sidebarMoreExpanded}
                .themeMode=${context.theme.mode}
                .onOpenPalette=${this.openPalette}
                .onToggleSidebar=${() => this.toggleNavigationSurface()}
                .onToggleMore=${() =>
                  context.navigation.update({
                    sidebarMoreExpanded: !context.navigation.snapshot.sidebarMoreExpanded,
                  })}
                .onUpdatePinnedRoutes=${(routes: SidebarNavRoute[]) =>
                  context.navigation.update({ sidebarPinnedRoutes: routes })}
                .onPairMobile=${() => void context.overlays.openDevicePairSetup()}
                .onNavigate=${(routeId: string, options?: ApplicationNavigationOptions) =>
                  this.navigate(routeId, options)}
                .onPreloadRoute=${(routeId: string) =>
                  isRouteId(routeId) ? context.preload(routeId) : Promise.resolve()}
              ></openclaw-app-sidebar>`}
        </div>
        ${!navCollapsed && !this.onboarding && !settingsTakeover
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
                  this.resizeNavigation(event.detail.splitRatio)}
              ></resizable-divider>
            `
          : nothing}
        <main
          class="content ${activeRoute === "chat" ? "content--chat" : ""} ${activeRoute ===
          "workboard"
            ? "content--workboard"
            : ""}"
        >
          ${gatewaySnapshot.connected
            ? nothing
            : html`<openclaw-connection-banner
                .props=${{
                  lastError: gatewaySnapshot.lastError,
                  onRetry: () => context.gateway.connect(),
                }}
              ></openclaw-connection-banner>`}
          <openclaw-update-banner
            .props=${{
              statusBanner: overlaySnapshot.updateStatusBanner,
              updateAvailable: overlaySnapshot.updateAvailable,
              updateRunning: overlaySnapshot.updateRunning,
              connected: gatewaySnapshot.connected,
              onUpdate: () => context.overlays.runUpdate(),
              onDismiss: () => context.overlays.dismissUpdate(),
            }}
          ></openclaw-update-banner>
          <openclaw-router-outlet
            .router=${runtime.router}
            .retryContext=${context}
            .onNotFound=${() => this.replaceChatWithCurrentSession()}
          ></openclaw-router-outlet>
        </main>
        <openclaw-terminal-panel
          .client=${gatewaySnapshot.connected ? gatewaySnapshot.client : null}
          .available=${terminalAvailable}
          .themeMode=${resolveTerminalThemeMode()}
        ></openclaw-terminal-panel>
        <openclaw-exec-approval
          .props=${{
            queue: overlaySnapshot.approvalQueue,
            busy: overlaySnapshot.approvalBusy,
            error: overlaySnapshot.approvalError,
            onDecision: (decision: Parameters<typeof context.overlays.decideApproval>[0]) =>
              context.overlays.decideApproval(decision),
          }}
        ></openclaw-exec-approval>
        ${renderDevicePairSetup({
          open: overlaySnapshot.devicePairSetupOpen,
          loading: overlaySnapshot.devicePairSetupLoading,
          error: overlaySnapshot.devicePairSetupError,
          setup: overlaySnapshot.devicePairSetup,
          pendingCount: overlaySnapshot.devicePairPendingCount,
          onRefresh: () => void context.overlays.refreshDevicePairSetup(),
          onClose: () => context.overlays.closeDevicePairSetup(),
          onCopy: (setupCode) => void copyToClipboard(setupCode),
          onManageDevices: () => {
            context.overlays.closeDevicePairSetup();
            this.navigate("nodes");
          },
        })}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-app")) {
  customElements.define("openclaw-app", OpenClawApp);
}
if (!customElements.get("openclaw-app-shell")) {
  customElements.define("openclaw-app-shell", OpenClawShell);
}
