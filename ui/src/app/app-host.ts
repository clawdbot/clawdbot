import { consume, ContextProvider } from "@lit/context";
import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import { html, LitElement, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import { hasStoredGatewayAuth, type GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import "../components/app-sidebar.ts";
import "../components/app-topbar.ts";
import "../components/connection-banner.ts";
import "../components/exec-approval.ts";
import "../components/gateway-url-confirmation.ts";
import "../components/github-link-hovercard.ts";
import "../components/login-gate.ts";
import "../components/terminal/terminal-panel.ts";
import "../components/tooltip.ts";
import "../components/update-banner.ts";
import type { SidebarNavRoute } from "../app-navigation.ts";
import { APP_ROUTE_IDS, isRouteId, pathForRoute, type RouteId } from "../app-routes.ts";
import {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPalette,
  type CommandPaletteTargetDetail,
} from "../components/command-palette.ts";
import type { ThemeModeChangeDetail } from "../components/theme-mode-toggle.ts";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../lib/plugin-activation.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import { resolveAgentIdFromSessionKey } from "../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../lib/string-coerce.ts";
import { renderDevicePairSetup } from "../pages/nodes/view-pairing.ts";
import { pluginTabKey, pluginTabRefFromSearch } from "../pages/plugin/route.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationNavigationOptions,
} from "./context.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";
import type { ApplicationOverlaySnapshot } from "./overlays.ts";
import { controlUiPublicAssetPath } from "./public-assets.ts";
import { selectRenderedRouteMatch } from "./router-outlet.ts";

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

function resolveAgentLabel(sessionKey: string, agentsList: AgentsListResult | null): string {
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const agent = agentsList?.agents.find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === agentId,
  );
  return (
    normalizeOptionalString(agent?.identity?.name) ??
    normalizeOptionalString(agent?.name) ??
    agentId
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

class OpenClawApp extends LitElement {
  @state() private gatewayConnected = false;
  @state() private gatewayReconnecting = false;
  @state() private gatewayLastError: string | null = null;
  @state() private gatewayLastErrorCode: string | null = null;
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
  @state() private terminalAvailable = false;
  @state() private terminalClient: GatewayBrowserClient | null = null;

  private readonly terminalOnly = isTerminalOnlyView();
  // Fixed at page load: whether this browser held credentials (token,
  // password, or stored device token) before the first connect attempt.
  // Later manual gate submissions are covered by loginGatePinned instead.
  private initialAuthPresent = false;
  private runtime: ApplicationRuntime | undefined;
  private context: ApplicationContext<RouteId> | undefined;
  private readonly contextProvider = new ContextProvider(this, {
    context: applicationContext,
  });
  private stopGatewaySubscription: (() => void) | undefined;
  private stopConfigSubscription: (() => void) | undefined;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.runtime = bootstrapApplication();
    this.context = this.runtime.context;
    this.initialAuthPresent = hasStoredGatewayAuth(this.context.gateway.connection);
    this.pendingGatewayUrl = this.runtime.pendingGatewayConnection?.gatewayUrl ?? null;
    this.contextProvider.setValue(this.context);
    this.syncLoginConnection();
    let gatewayClient = this.context.gateway.snapshot.client;
    this.updateGatewayStatus(this.context.gateway.snapshot);
    this.stopGatewaySubscription = this.context.gateway.subscribe((snapshot) => {
      if (snapshot.client !== gatewayClient) {
        gatewayClient = snapshot.client;
        this.syncLoginConnection();
      }
      this.updateGatewayStatus(snapshot);
      this.updateTerminalSurface();
    });
    if (this.terminalOnly) {
      // Terminal availability also depends on config.terminalEnabled, which
      // can arrive after the gateway snapshot; track it for this document mode.
      this.updateTerminalSurface();
      this.stopConfigSubscription = this.context.config.subscribe(() => {
        this.updateTerminalSurface();
      });
    }
    void this.runtime.start().catch((error: unknown) => {
      console.error("[openclaw] application start failed", error);
    });
  }

  override disconnectedCallback() {
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopConfigSubscription?.();
    this.stopConfigSubscription = undefined;
    this.runtime?.stop();
    this.runtime = undefined;
    this.context = undefined;
    this.pendingGatewayUrl = null;
    super.disconnectedCallback();
  }

  private syncLoginConnection() {
    const connection = this.context?.gateway.connection;
    if (!connection) {
      return;
    }
    this.loginGatewayUrl = connection.gatewayUrl;
    this.loginToken = connection.token;
    this.loginPassword = connection.password;
  }

  private readonly updateGatewayStatus = (snapshot: {
    connected: boolean;
    reconnecting: boolean;
    lastError: string | null;
    lastErrorCode: string | null;
  }) => {
    this.gatewayConnected = snapshot.connected;
    this.gatewayReconnecting = snapshot.reconnecting;
    this.gatewayLastError = snapshot.lastError;
    this.gatewayLastErrorCode = snapshot.lastErrorCode;
    if (snapshot.connected) {
      this.loginGatePinned = false;
    }
  };

  private updateTerminalSurface() {
    if (!this.terminalOnly || !this.context) {
      return;
    }
    const snapshot = this.context.gateway.snapshot;
    this.terminalClient = snapshot.connected ? snapshot.client : null;
    this.terminalAvailable = isTerminalAvailable(
      snapshot,
      this.context.config.current.terminalEnabled ?? false,
    );
  }

  override render() {
    const context = this.context;
    const runtime = this.runtime;
    if (!context || !runtime) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
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
      return html`
        <openclaw-terminal-panel
          .client=${this.terminalClient}
          .available=${this.terminalAvailable}
          .themeMode=${resolveTerminalThemeMode()}
          fullscreen
        ></openclaw-terminal-panel>
        ${!this.terminalAvailable && (this.gatewayConnected || this.gatewayLastError)
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
      !this.gatewayConnected &&
      !this.gatewayReconnecting &&
      !this.loginGatePinned &&
      this.gatewayLastError === null &&
      context.gateway.snapshot.client !== null;
    if (initialConnectPending) {
      return html`
        <openclaw-tooltip-provider>
          ${renderConnectingSplash(context.basePath)} ${gatewayUrlConfirmation}
        </openclaw-tooltip-provider>
      `;
    }
    const showLoginGate =
      !this.gatewayConnected && (this.loginGatePinned || !this.gatewayReconnecting);
    if (showLoginGate) {
      return html`
        <openclaw-tooltip-provider>
          <openclaw-login-gate
            .props=${{
              basePath: context.basePath,
              connected: this.gatewayConnected,
              lastError: this.gatewayLastError,
              lastErrorCode: this.gatewayLastErrorCode,
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
        <openclaw-github-link-hovercard-provider .client=${context.gateway.snapshot.client}>
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

class OpenClawShell extends LitElement {
  @property({ attribute: false }) runtime?: ApplicationRuntime;
  @property({ attribute: false }) onboarding = false;
  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext<RouteId>;

  @state() private navCollapsed = false;
  @state() private sidebarPinnedRoutes: readonly SidebarNavRoute[] = [];
  @state() private sidebarMoreExpanded = false;
  @state() private navDrawerOpen = false;
  @state() private gatewayConnected = false;
  @state() private gatewayLastError: string | null = null;
  @state() private terminalAvailable = false;
  @state() private terminalClient: GatewayBrowserClient | null = null;
  @state() private activeSessionKey = "";
  @state() private agentLabel = "";
  @state() private routeState: ShellRouteState = {};
  @state() private overlaySnapshot: ApplicationOverlaySnapshot = {
    updateAvailable: null,
    updateRunning: false,
    updateStatusBanner: null,
    approvalQueue: [],
    approvalBusy: false,
    approvalError: null,
    devicePairSetupOpen: false,
    devicePairSetupLoading: false,
    devicePairSetupError: null,
    devicePairSetup: null,
    devicePairPendingCount: 0,
  };
  @query("openclaw-command-palette") private commandPalette?: CommandPalette;
  private commandPaletteTarget?: CommandPaletteTargetDetail;
  private navDrawerTrigger: HTMLElement | null = null;
  private agentsListClient: GatewayBrowserClient | null = null;
  private sessionKeyClient: GatewayBrowserClient | null = null;
  private stopAgentsSubscription: (() => void) | undefined;
  private stopConfigSubscription: (() => void) | undefined;
  private stopGatewaySubscription: (() => void) | undefined;
  private stopNavigationSubscription: (() => void) | undefined;
  private stopRouteSubscription: (() => void) | undefined;
  private stopOverlaySubscription: (() => void) | undefined;
  private stopRuntimeConfigSubscription: (() => void) | undefined;
  private stopHostPolicySubscription: (() => void) | undefined;
  private stopThemeSubscription: (() => void) | undefined;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.startSubscriptions();
    this.addEventListener(COMMAND_PALETTE_TARGET_EVENT, this.handleCommandPaletteTarget);
    document.addEventListener("keydown", this.handleDocumentKeydown);
  }

  override updated() {
    this.startSubscriptions();
  }

  private startSubscriptions() {
    const runtime = this.runtime;
    const context = this.context;
    if (
      !runtime ||
      !context ||
      this.stopAgentsSubscription ||
      this.stopConfigSubscription ||
      this.stopGatewaySubscription ||
      this.stopNavigationSubscription ||
      this.stopRouteSubscription ||
      this.stopOverlaySubscription ||
      this.stopRuntimeConfigSubscription ||
      this.stopHostPolicySubscription ||
      this.stopThemeSubscription
    ) {
      return;
    }
    this.updateNavigationPreferences(context.navigation.snapshot);
    this.stopNavigationSubscription = context.navigation.subscribe((snapshot) => {
      this.updateNavigationPreferences(snapshot);
    });
    this.updateGatewaySessionKey(context.gateway.snapshot);
    this.updateGatewayStatus(context.gateway.snapshot);
    this.updateTerminalSurface(context.gateway.snapshot);
    this.updateAgentLabel();
    this.ensureRuntimeConfig(context.gateway.snapshot);
    this.stopGatewaySubscription = context.gateway.subscribe((snapshot) => {
      this.updateGatewaySessionKey(snapshot);
      this.updateGatewayStatus(snapshot);
      this.updateTerminalSurface(snapshot);
      this.updateAgentLabel();
      this.ensureAgentsList(snapshot);
      this.ensureRuntimeConfig(snapshot);
    });
    this.stopConfigSubscription = context.config.subscribe(() => {
      this.updateTerminalSurface(context.gateway.snapshot);
    });
    this.stopThemeSubscription = context.theme.subscribe(() => this.requestUpdate());
    this.stopAgentsSubscription = context.agents.subscribe(() => {
      this.updateAgentLabel();
    });
    this.updateRouteState(selectShellRouteState(runtime.router.getState()));
    this.stopRouteSubscription = runtime.router.subscribeSelector(
      selectShellRouteState,
      (routeState) => {
        this.updateRouteState(routeState);
      },
      equalShellRouteState,
    );
    this.overlaySnapshot = context.overlays.snapshot;
    this.stopOverlaySubscription = context.overlays.subscribe((snapshot) => {
      this.overlaySnapshot = snapshot;
    });
    this.stopRuntimeConfigSubscription = context.runtimeConfig.subscribe(() => {
      // Route enablement derives from runtime config and host policy.
      this.requestUpdate();
    });
    this.stopHostPolicySubscription = context.hostPolicy.subscribe(() => {
      this.requestUpdate();
    });
  }

  override disconnectedCallback() {
    this.removeEventListener(COMMAND_PALETTE_TARGET_EVENT, this.handleCommandPaletteTarget);
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    this.stopAgentsSubscription?.();
    this.stopAgentsSubscription = undefined;
    this.stopConfigSubscription?.();
    this.stopConfigSubscription = undefined;
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopNavigationSubscription?.();
    this.stopNavigationSubscription = undefined;
    this.stopRouteSubscription?.();
    this.stopRouteSubscription = undefined;
    this.stopOverlaySubscription?.();
    this.stopOverlaySubscription = undefined;
    this.stopRuntimeConfigSubscription?.();
    this.stopRuntimeConfigSubscription = undefined;
    this.stopHostPolicySubscription?.();
    this.stopHostPolicySubscription = undefined;
    this.stopThemeSubscription?.();
    this.stopThemeSubscription = undefined;
    this.agentsListClient = null;
    this.sessionKeyClient = null;
    this.terminalClient = null;
    this.navDrawerTrigger = null;
    super.disconnectedCallback();
  }

  private readonly handleThemeChange = (event: CustomEvent<ThemeModeChangeDetail>) => {
    const context = this.context;
    if (!context) {
      return;
    }
    context.theme.setMode(event.detail.mode, event.detail.element);
    this.requestUpdate();
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

  private toggleNavigationSurface(trigger?: HTMLElement) {
    const context = this.context;
    if (!context || this.onboarding) {
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
    context.navigation.update({
      navCollapsed: !this.navCollapsed,
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

  private readonly handleShellKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Escape" || !this.navDrawerOpen) {
      return;
    }
    event.preventDefault();
    this.closeNavDrawer({ restoreFocus: true });
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
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

  private readonly updateGatewayStatus = (snapshot: {
    connected: boolean;
    lastError: string | null;
  }) => {
    if (
      snapshot.connected === this.gatewayConnected &&
      snapshot.lastError === this.gatewayLastError
    ) {
      return;
    }
    this.gatewayConnected = snapshot.connected;
    this.gatewayLastError = snapshot.lastError;
  };

  private updateTerminalSurface(snapshot: ApplicationContext["gateway"]["snapshot"]) {
    this.terminalClient = snapshot.connected ? snapshot.client : null;
    this.terminalAvailable = isTerminalAvailable(
      snapshot,
      this.context?.config.current.terminalEnabled ?? false,
    );
  }

  private ensureRuntimeConfig(snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
  }) {
    // The sidebar hides config-gated routes (Workboard), so the snapshot must
    // load eagerly instead of waiting for a page that happens to fetch it.
    if (snapshot.connected && snapshot.client) {
      void this.context?.runtimeConfig.ensureLoaded();
    }
  }

  private enabledRouteIds(): readonly RouteId[] {
    const baseRoutes = isWorkboardEnabledInConfigSnapshot(
      this.context?.runtimeConfig.state.configSnapshot,
    )
      ? APP_ROUTE_IDS
      : ROUTE_IDS_WITHOUT_WORKBOARD;
    const hostPolicy = this.context?.hostPolicy;
    return hostPolicy
      ? baseRoutes.filter((routeId) => hostPolicy.isRouteEnabled(routeId))
      : baseRoutes;
  }

  private ensureAgentsList(snapshot: { client: GatewayBrowserClient | null; connected: boolean }) {
    if (!snapshot.connected || !snapshot.client) {
      this.agentsListClient = null;
      return;
    }
    const routeId = this.routeState.routeId;
    if (!routeId || routeId === "chat" || this.context?.agents.state.agentsList) {
      return;
    }
    if (this.agentsListClient === snapshot.client) {
      return;
    }
    this.agentsListClient = snapshot.client;
    void this.context?.agents.ensureList();
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
      this.updateAgentLabel();
    }
  }

  private updateAgentLabel() {
    const context = this.context;
    if (!context) {
      return;
    }
    this.agentLabel = resolveAgentLabel(
      this.activeSessionKey || context.gateway.snapshot.sessionKey,
      context.agents.state.agentsList,
    );
  }

  private updateRouteState(routeState: ShellRouteState) {
    this.routeState = routeState;
    const context = this.context;
    if (context && routeState.routeId && !context.hostPolicy.isRouteEnabled(routeState.routeId)) {
      context.replace(
        APP_ROUTE_IDS.find((routeId) => context.hostPolicy.isRouteEnabled(routeId)) ?? "chat",
      );
      return;
    }
    if (context) {
      this.ensureAgentsList(context.gateway.snapshot);
    }
    if (routeState.routeId !== "chat") {
      return;
    }
    const sessionKey = new URLSearchParams(routeState.location?.search).get("session")?.trim();
    if (sessionKey) {
      this.activeSessionKey = sessionKey;
      this.updateAgentLabel();
    }
  }

  private readonly updateNavigationPreferences = (
    snapshot: ApplicationRuntime["context"]["navigation"]["snapshot"],
  ) => {
    this.navCollapsed = snapshot.navCollapsed;
    this.sidebarPinnedRoutes = snapshot.sidebarPinnedRoutes;
    this.sidebarMoreExpanded = snapshot.sidebarMoreExpanded;
  };

  override render() {
    const context = this.context;
    const runtime = this.runtime;
    if (!context || !runtime) {
      return nothing;
    }
    const activeRoute = this.routeState.routeId ?? "chat";
    // Plugin tabs share one route; the search picks the active item.
    const activePluginTabId =
      activeRoute === "plugin"
        ? pluginTabKey(pluginTabRefFromSearch(this.routeState.location?.search ?? ""))
        : "";
    const navDrawerOpen = this.navDrawerOpen && !this.onboarding;
    // Drawer navigation always opens expanded; the desktop collapse preference
    // stays persisted for when the viewport returns to the desktop layout.
    const navCollapsed = this.navCollapsed && !navDrawerOpen;
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
          : ""}"
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
          .routeId=${activeRoute}
          .basePath=${context.basePath}
          .agentLabel=${this.agentLabel}
          .overviewHref=${pathForRoute("overview", context.basePath)}
          .searchDisabled=${false}
          .navDrawerOpen=${navDrawerOpen}
          .onboarding=${this.onboarding}
          .onOpenPalette=${this.openPalette}
          .onToggleDrawer=${(trigger: HTMLElement) => this.toggleNavigationSurface(trigger)}
          .onNavigate=${(routeId: string, options?: ApplicationNavigationOptions) =>
            this.navigate(routeId, options)}
        ></openclaw-app-topbar>
        <div class="shell-nav">
          <openclaw-app-sidebar
            .basePath=${context.basePath}
            .activeRouteId=${activeRoute}
            .activePluginTabId=${activePluginTabId}
            .enabledRouteIds=${this.enabledRouteIds()}
            .sessionKey=${this.activeSessionKey}
            .collapsed=${navCollapsed}
            .connected=${this.gatewayConnected}
            .canPairDevice=${this.gatewayConnected &&
            hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null)}
            .sidebarPinnedRoutes=${this.sidebarPinnedRoutes}
            .sidebarMoreExpanded=${this.sidebarMoreExpanded}
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
          ></openclaw-app-sidebar>
        </div>
        <main
          class="content ${activeRoute === "chat" ? "content--chat" : ""} ${activeRoute ===
          "workboard"
            ? "content--workboard"
            : ""}"
        >
          ${this.gatewayConnected
            ? nothing
            : html`<openclaw-connection-banner
                .props=${{
                  lastError: this.gatewayLastError,
                  onRetry: () => context.gateway.connect(),
                }}
              ></openclaw-connection-banner>`}
          <openclaw-update-banner
            .props=${{
              statusBanner: this.overlaySnapshot.updateStatusBanner,
              updateAvailable: this.overlaySnapshot.updateAvailable,
              updateRunning: this.overlaySnapshot.updateRunning,
              connected: this.gatewayConnected,
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
          .client=${this.terminalClient}
          .available=${this.terminalAvailable}
          .themeMode=${resolveTerminalThemeMode()}
        ></openclaw-terminal-panel>
        <openclaw-exec-approval
          .props=${{
            queue: this.overlaySnapshot.approvalQueue,
            busy: this.overlaySnapshot.approvalBusy,
            error: this.overlaySnapshot.approvalError,
            onDecision: (decision: Parameters<typeof context.overlays.decideApproval>[0]) =>
              context.overlays.decideApproval(decision),
          }}
        ></openclaw-exec-approval>
        ${renderDevicePairSetup({
          open: this.overlaySnapshot.devicePairSetupOpen,
          loading: this.overlaySnapshot.devicePairSetupLoading,
          error: this.overlaySnapshot.devicePairSetupError,
          setup: this.overlaySnapshot.devicePairSetup,
          pendingCount: this.overlaySnapshot.devicePairPendingCount,
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
