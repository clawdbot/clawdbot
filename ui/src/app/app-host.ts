import { ContextProvider } from "@lit/context";
import type { UiCommandParams } from "@openclaw/gateway-protocol";
import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import {
  type GatewayEventFrame,
  hasStoredGatewayAuth,
  type GatewayBrowserClient,
} from "../api/gateway.ts";
import type { GatewayAgentRow } from "../api/types.ts";
import "../components/app-sidebar.ts";
import "../components/app-topbar.ts";
import "../components/gateway-url-confirmation.ts";
import "../components/github-link-hovercard-registration.ts";
import "../components/login-gate.ts";
import "../components/macos-titlebar-controls.ts";
import "../components/onboarding-memory-import.ts";
import "../components/resizable-divider.ts";
import "../components/sidebar-update-card.ts";
import "../components/tooltip.ts";
import "../components/update-banner.ts";
import {
  formatDocumentTitle,
  isSettingsNavigationRoute,
  titleForRoute,
} from "../app-navigation.ts";
import { workboardBoardIdFromPath } from "../app-route-paths.ts";
import { APP_ROUTE_IDS, isRouteId, type RouteId } from "../app-routes.ts";
import {
  EMPTY_SIDEBAR_WORKBOARD_SNAPSHOT,
  type SidebarWorkboardRenderers,
  type SidebarWorkboardRuntime,
  type SidebarWorkboardRuntimeFactory,
} from "../components/app-sidebar-workboard.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  COMMAND_PALETTE_TARGET_EVENT,
  isCommandPaletteShortcut,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type CommandPaletteElement,
  type CommandPaletteTargetDetail,
  type ShellNavDrawerToggleDetail,
} from "../components/command-palette-contract.ts";
import { icons } from "../components/icons.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  isTerminalPanelShortcut,
  TERMINAL_PANEL_TOGGLE_EVENT,
  UI_COMMAND_EVENT,
  type PanelToggleElement,
} from "../components/panel-toggle-contract.ts";
import { renderSettingsSidebar } from "../components/settings-sidebar.ts";
import type { ThemeModeChangeDetail } from "../components/theme-mode-toggle.ts";
import { i18n, isSupportedLocale, t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../lib/plugin-activation.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiKnownSelectedGlobalAgentId,
} from "../lib/sessions/session-key.ts";
import "../lib/toast.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { findSettingsSearchBlocks } from "../pages/config/settings-search.ts";
import { newSessionSearch, type NewSessionTarget } from "../pages/new-session/location.ts";
import { renderDevicePairSetup } from "../pages/nodes/view-pairing.ts";
import { pluginTabKey, pluginTabRefFromSearch } from "../pages/plugin/route.ts";
import { findInlineApproval } from "./approval-presentation.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationNavigationOptions,
} from "./context.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import {
  APPROVAL_PAGE_ELEMENT,
  BROWSER_PANEL_ELEMENT,
  COMMAND_PALETTE_ELEMENT,
  EXEC_APPROVAL_ELEMENT,
  ensureOptionalElementForHost,
  isOptionalElementDefined,
  preloadOptionalElement,
  TERMINAL_PANEL_ELEMENT,
  type OptionalCustomElement,
} from "./lazy-custom-element.ts";
import { isMobileNavLayout, shouldMergeChatChrome } from "./mobile-nav-layout.ts";
import { postNativeNavState, type NativeNavState } from "./native-nav-state.ts";
import { considerRouteRestore, persistRoute } from "./native-route-memory.ts";
import {
  isNativeWebChromeHost,
  NATIVE_HISTORY_STATE_EVENT,
  readNativeHistoryState,
  type NativeHistoryState,
} from "./native-web-chrome.ts";
import { navigationSurfaceIsHidden, renderFloatingUpdateCard } from "./navigation-surface.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";
import { controlUiPublicAssetPath } from "./public-assets.ts";
import { selectRenderedRouteMatch } from "./router-outlet.ts";
import {
  applyServerUiPrefs,
  changedServerUiPrefs,
  isApplyingServerUiPrefs,
  pushServerUiPrefs,
  resetServerUiPrefsSync,
} from "./server-prefs.ts";
import {
  NAV_WIDTH_MAX,
  NAV_WIDTH_MIN,
  loadSettings,
  normalizeCatalogOpenTarget,
  setSettingsChangeListener,
} from "./settings.ts";

type ShellRouteState = {
  routeId?: RouteId;
  location?: RouteLocation;
  committedRouteId?: RouteId;
  committedLocation?: RouteLocation;
};
type AppSidebarElement = HTMLElement & {
  dismissTransientMenus: () => boolean;
};

// Stable references so the sidebar's enabledRouteIds property does not churn
// on every shell render.
const ROUTE_IDS_WITHOUT_WORKBOARD = APP_ROUTE_IDS.filter((routeId) => routeId !== "workboard");
const AGENT_ROSTER_REFRESH_DEBOUNCE_MS = 100;
const EMPTY_OUTBOX_COUNT_FOR_SESSION = () => 0;
const PALETTE_SHORTCUT = /Mac|iP(hone|ad|od)/i.test(globalThis.navigator?.platform ?? "")
  ? "⌘K"
  : "Ctrl K";

type StoredOutboxScopeHost = {
  settings: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
};

type OutboxStoreRuntime = {
  summarizeStoredChatOutboxes: (state: StoredOutboxScopeHost) => {
    countsByScope: ReadonlyMap<string, number>;
    total: number;
  };
  resolveStoredChatOutboxScope: (
    state: StoredOutboxScopeHost,
    sessionKey: string,
  ) => { sessionKey: string; agentId?: string };
  storedChatOutboxScopeKey: (scope: { sessionKey: string; agentId?: string }) => string;
  subscribeStoredChatOutboxChanges: (listener: () => void) => () => void;
};

function diffAgentRoster(
  previous: readonly GatewayAgentRow[],
  next: readonly GatewayAgentRow[],
): { invalidatedIds: string[]; changedIds: string[] } {
  const nextById = new Map(next.map((agent) => [agent.id, agent]));
  const invalidatedIds: string[] = [];
  const changedIds: string[] = [];
  for (const agent of previous) {
    const replacement = nextById.get(agent.id);
    if (!replacement) {
      invalidatedIds.push(agent.id);
    } else if (JSON.stringify(replacement) !== JSON.stringify(agent)) {
      invalidatedIds.push(agent.id);
      changedIds.push(agent.id);
    }
  }
  return { invalidatedIds, changedIds };
}

function selectShellRouteState(routerState: RouterState<RouteId>): ShellRouteState {
  const match = selectRenderedRouteMatch(routerState.matches[0], routerState.pendingMatches[0]);
  const committedMatch = routerState.matches[0];
  return {
    ...(match ? { routeId: match.routeId, location: match.location } : {}),
    ...(committedMatch
      ? { committedRouteId: committedMatch.routeId, committedLocation: committedMatch.location }
      : {}),
  };
}

function equalShellRouteState(previous: ShellRouteState, next: ShellRouteState): boolean {
  return (
    previous.routeId === next.routeId &&
    previous.location?.pathname === next.location?.pathname &&
    previous.location?.search === next.location?.search &&
    previous.location?.hash === next.location?.hash &&
    previous.committedRouteId === next.committedRouteId &&
    previous.committedLocation?.pathname === next.committedLocation?.pathname &&
    previous.committedLocation?.search === next.committedLocation?.search &&
    previous.committedLocation?.hash === next.committedLocation?.hash
  );
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

function renderApprovalDocument(runtime: ApplicationRuntime) {
  const documentMode = runtime.documentMode;
  if (documentMode?.kind !== "approval") {
    return nothing;
  }
  return html`
    <openclaw-approval-page .approvalId=${documentMode.approvalId ?? ""}>
      <main class="approval-page approval-page--booting" role="status" aria-live="polite">
        <img
          class="connect-splash__logo"
          src=${controlUiPublicAssetPath("favicon.svg", runtime.context.basePath)}
          alt=""
        />
        <span>${t("common.loading")}</span>
      </main>
    </openclaw-approval-page>
  `;
}

function isBrowserPanelAvailable(snapshot: ApplicationContext["gateway"]["snapshot"]): boolean {
  if (snapshot.phase !== "connected") {
    return false;
  }
  return (
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    isGatewayMethodAdvertised(snapshot, "browser.request") === true
  );
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
  @state() private onboarding = resolveOnboardingMode(globalThis.location?.search ?? "");

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
    if (this.terminalOnly) {
      preloadOptionalElement(this, TERMINAL_PANEL_ELEMENT);
    }
    if (this.runtime.documentMode?.kind === "approval") {
      preloadOptionalElement(this, APPROVAL_PAGE_ELEMENT);
    }
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
    if (snapshot.phase === "connected") {
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
    const gatewayConnected = gatewaySnapshot.phase === "connected";
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
      // Embedded clients query this host immediately; keep it stable while the chunk loads.
      return html`
        <openclaw-terminal-panel
          .client=${gatewayConnected ? gatewaySnapshot.client : null}
          .available=${terminalAvailable}
          .themeMode=${resolveTerminalThemeMode()}
          fullscreen
        ></openclaw-terminal-panel>
        ${!isOptionalElementDefined(TERMINAL_PANEL_ELEMENT) && terminalAvailable
          ? renderConnectingSplash(context.basePath)
          : nothing}
        ${!terminalAvailable && (gatewayConnected || gatewaySnapshot.lastError)
          ? html`<div class="terminal-view-unavailable">${t("terminal.unavailable")}</div>`
          : nothing}
      `;
    }
    // Transport drops after an established session keep the shell mounted
    // (offline presentation + client auto-retry); the login gate is reserved for
    // credential-less first connects, credential rejections, and manual gate
    // submissions. A first connect backed by stored credentials paints the
    // connecting splash instead of flashing the login gate; the gate returns
    // the moment the attempt fails (lastError set on every close).
    const initialConnectPending =
      this.initialAuthPresent &&
      !gatewayConnected &&
      gatewaySnapshot.phase !== "reconnecting" &&
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
      !gatewayConnected && (this.loginGatePinned || gatewaySnapshot.phase !== "reconnecting");
    if (showLoginGate) {
      return html`
        <openclaw-tooltip-provider>
          <openclaw-login-gate
            .props=${{
              basePath: context.basePath,
              connected: gatewayConnected,
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
    if (runtime.documentMode?.kind === "approval") {
      return html`
        <openclaw-tooltip-provider>
          ${gatewayUrlConfirmation} ${renderApprovalDocument(runtime)}
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
  @state() private settingsSearchQuery = "";
  @state() private routeState: ShellRouteState = {};
  @state() private nativeHistoryState: NativeHistoryState = readNativeHistoryState();
  private readonly commandPaletteElement = COMMAND_PALETTE_ELEMENT;
  private readonly terminalPanelElement = TERMINAL_PANEL_ELEMENT;
  private readonly browserPanelElement = BROWSER_PANEL_ELEMENT;
  private readonly execApprovalElement = EXEC_APPROVAL_ELEMENT;
  @query("openclaw-command-palette") private commandPalette?: CommandPaletteElement;
  @query("openclaw-exec-approval")
  private approvalOverlay?: HTMLElement & { show(): void };
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
  private sidebarWorkboardSnapshot = EMPTY_SIDEBAR_WORKBOARD_SNAPSHOT;
  private sidebarWorkboardRuntime: SidebarWorkboardRuntime | null = null;
  private sidebarWorkboardHost: ApplicationContext["workboard"] | null = null;
  private sidebarWorkboardRenderers: SidebarWorkboardRenderers | undefined;
  private sidebarWorkboardRuntimeLoad: Promise<SidebarWorkboardRuntimeFactory> | null = null;
  private sidebarWorkboardEpoch = 0;
  private agentRosterRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private outboxStoreRuntime: OutboxStoreRuntime | null = null;
  private outboxStoreUnsubscribe: (() => void) | null = null;
  private readonly outboxStoreImport = createIdleImport(
    () => import("../lib/chat/outbox-store.ts").then((module): OutboxStoreRuntime => module),
    (runtime) => this.installOutboxStoreRuntime(runtime),
  );
  private lastNativeNavState: NativeNavState | undefined;
  private didConsiderNativeRouteRestore = false;
  private pendingNativeNewSession = false;
  private readonly settingsPreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();
  private readonly subscriptions = new SubscriptionsController(this);

  private get context(): ApplicationContext<RouteId> | undefined {
    return this.runtime?.context;
  }

  private get onboardingMode(): boolean {
    const routeSearch = this.routeState.location?.search;
    return routeSearch === undefined ? this.onboarding : resolveOnboardingMode(routeSearch);
  }

  private storedOutboxScopeHost(context: ApplicationContext<RouteId>): StoredOutboxScopeHost {
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
    const row = context.sessions.state.result?.sessions.find(
      (session) => session.key === sessionKey,
    );
    // An agent's main chat is its identity, so use its roster label when available.
    const parsed = parseAgentSessionKey(sessionKey);
    const mainAgentId = isUiGlobalSessionKey(sessionKey)
      ? resolveUiKnownSelectedGlobalAgentId(outboxScopeHost)
      : parsed?.rest === resolveUiConfiguredMainKey(outboxScopeHost)
        ? normalizeAgentId(parsed.agentId)
        : undefined;
    const agent = context.agents.state.agentsList?.agents.find(
      (candidate) => normalizeAgentId(candidate.id) === mainAgentId,
    );
    return agent ? normalizeAgentLabel(agent) : resolveSessionDisplayName(sessionKey, row);
  }

  constructor() {
    super();
    this.subscriptions
      .effect(
        () => this.context,
        () => {
          if (this.pendingNativeNewSession) {
            this.pendingNativeNewSession = false;
            this.handleNativeNewSession();
          }
          return () => this.resetShellEpochState();
        },
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
      )
      .watch(
        () => this.context?.runtimeConfig,
        (runtimeConfig, notify) =>
          runtimeConfig.subscribe(() => {
            this.reconcileServerUiPrefs(runtimeConfig);
            this.syncSidebarWorkboard();
            notify();
          }),
        (runtimeConfig) => {
          const snapshot = this.context?.gateway.snapshot;
          if (snapshot) {
            this.ensureRuntimeConfig(snapshot, runtimeConfig);
          }
          this.reconcileServerUiPrefs(runtimeConfig);
          this.syncSidebarWorkboard();
        },
      );
  }

  /**
   * Server config (ui.prefs) is the canonical home for synced display prefs;
   * apply server-side deltas to the browser mirror whenever a config snapshot
   * lands (connect, settings pages, reloads).
   */
  private reconcileServerUiPrefs(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    const snapshot = runtimeConfig.state.configSnapshot;
    const context = this.context;
    if (!snapshot?.config || !context) {
      return;
    }
    applyServerUiPrefs(snapshot.config, {
      scope: context.gateway.connection.gatewayUrl,
      snapshotHash: snapshot.hash ?? undefined,
      onApplied: (patch) => {
        if (patch.sidebarEntries !== undefined) {
          context.navigation.update({ sidebarEntries: patch.sidebarEntries });
        }
        if (isSupportedLocale(patch.locale)) {
          void i18n.setLocale(patch.locale);
        }
        context.theme.refresh();
      },
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.outboxStoreRuntime) {
      this.installOutboxStoreRuntime(this.outboxStoreRuntime);
    }
    this.outboxStoreImport.schedule();
    this.nativeHistoryState = readNativeHistoryState();
    this.addEventListener(COMMAND_PALETTE_TARGET_EVENT, this.handleCommandPaletteTarget);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, this.openPalette);
    window.addEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, this.handleShellNavDrawerToggle);
    document.addEventListener("keydown", this.handleDocumentKeydown);
    window.addEventListener("resize", this.handleWindowResize);
    window.addEventListener("dragover", this.handleUnhandledFileDrag);
    window.addEventListener("drop", this.handleUnhandledFileDrag);
    window.addEventListener(NATIVE_HISTORY_STATE_EVENT, this.handleNativeHistoryState);
    // Shipped Mac app builds without web chrome still drive these events; the
    // app's ⌘N menu item reuses native-new-session, while its ⌘K menu item
    // uses native-toggle-search because the legacy open-search is open-only.
    window.addEventListener("openclaw:native-toggle-sidebar", this.handleNativeToggleSidebar);
    window.addEventListener("openclaw:native-open-search", this.handleNativeOpenSearch);
    window.addEventListener("openclaw:native-toggle-search", this.handleNativeToggleSearch);
    window.addEventListener("openclaw:native-new-session", this.handleNativeNewSession);
    window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.handleDeferredTerminalToggle);
    window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.handleDeferredBrowserToggle);
    // Write-through of synced display prefs to config ui.prefs. Server-applied
    // deltas are suppressed so a reconcile never echoes back to the gateway.
    setSettingsChangeListener((previous, next) => {
      if (isApplyingServerUiPrefs()) {
        return;
      }
      const prefs = changedServerUiPrefs(previous, next);
      const snapshot = this.context?.gateway.snapshot;
      if (prefs && snapshot?.phase === "connected" && snapshot.client) {
        pushServerUiPrefs(snapshot.client, prefs);
      }
    });
  }

  override disconnectedCallback() {
    this.removeEventListener(COMMAND_PALETTE_TARGET_EVENT, this.handleCommandPaletteTarget);
    window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, this.openPalette);
    window.removeEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, this.handleShellNavDrawerToggle);
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    window.removeEventListener("resize", this.handleWindowResize);
    window.removeEventListener("dragover", this.handleUnhandledFileDrag);
    window.removeEventListener("drop", this.handleUnhandledFileDrag);
    window.removeEventListener(NATIVE_HISTORY_STATE_EVENT, this.handleNativeHistoryState);
    window.removeEventListener("openclaw:native-toggle-sidebar", this.handleNativeToggleSidebar);
    window.removeEventListener("openclaw:native-open-search", this.handleNativeOpenSearch);
    window.removeEventListener("openclaw:native-toggle-search", this.handleNativeToggleSearch);
    window.removeEventListener("openclaw:native-new-session", this.handleNativeNewSession);
    window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.handleDeferredTerminalToggle);
    window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.handleDeferredBrowserToggle);
    this.outboxStoreImport.dispose();
    this.outboxStoreUnsubscribe?.();
    this.outboxStoreUnsubscribe = null;
    setSettingsChangeListener(null);
    this.resetShellEpochState();
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

  private resetShellEpochState() {
    this.navDrawerOpen = false;
    this.navDrawerTrigger = null;
    this.lastWorkspaceLocation = null;
    this.activeSessionKey = "";
    this.settingsSearchQuery = "";
    this.commandPaletteTarget = undefined;
    this.agentsListClient = null;
    this.agentsListSource = null;
    this.sessionKeyClient = null;
    this.runtimeConfigClient = null;
    this.runtimeConfigSource = null;
    this.disposeSidebarWorkboard();
    if (this.agentRosterRefreshTimer !== null) {
      globalThis.clearTimeout(this.agentRosterRefreshTimer);
      this.agentRosterRefreshTimer = null;
    }
    resetServerUiPrefsSync();
    for (const timer of this.settingsPreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.settingsPreloadTimers.clear();
  }

  private readonly handleGatewayEvent = (event: GatewayEventFrame) => {
    this.sidebarWorkboardRuntime?.handleGatewayEvent(event.event);
    if (event.event === "config.changed") {
      // Another writer (agent-approved config_set, other device, CLI) changed
      // openclaw.json; refresh the snapshot so ui.prefs reconcile live. A
      // dirty local settings draft wins — the autosave/conflict flow owns it.
      const runtimeConfig = this.context?.runtimeConfig;
      if (runtimeConfig && !runtimeConfig.state.configFormDirty) {
        void runtimeConfig.refresh();
      }
      this.scheduleAgentRosterRefresh();
      return;
    }
    if (event.event !== "ui.command" || !event.payload) {
      return;
    }
    const context = this.context;
    if (!context) {
      return;
    }
    const commandParams = event.payload as UiCommandParams;
    const { command } = commandParams;
    if (!command) {
      return;
    }
    if (command.kind === "sidebar") {
      context.navigation.update({ navCollapsed: !command.visible });
      return;
    }
    if (command.kind === "panel") {
      window.dispatchEvent(
        new CustomEvent(
          command.panel === "terminal" ? TERMINAL_PANEL_TOGGLE_EVENT : BROWSER_PANEL_TOGGLE_EVENT,
          {
            detail: {
              open: command.open,
              ...(command.dock ? { dock: command.dock } : {}),
              ...(command.panel === "terminal" && command.terminalSessionId
                ? { terminalSessionId: command.terminalSessionId }
                : {}),
            },
          },
        ),
      );
      return;
    }

    const handled = !window.dispatchEvent(
      new CustomEvent(UI_COMMAND_EVENT, { detail: commandParams, cancelable: true }),
    );
    if (handled || (command.kind !== "navigate" && command.kind !== "split")) {
      return;
    }
    context.gateway.setSessionKey(command.sessionKey);
    this.navigate("chat", { search: searchForSession(command.sessionKey) });
  };

  private scheduleAgentRosterRefresh() {
    // Persisted config writes can arrive as a tight sequence; roster state is
    // snapshot-based, so only the final forced read in that burst is useful.
    if (this.agentRosterRefreshTimer !== null) {
      globalThis.clearTimeout(this.agentRosterRefreshTimer);
    }
    this.agentRosterRefreshTimer = globalThis.setTimeout(() => {
      this.agentRosterRefreshTimer = null;
      void this.refreshAgentRoster();
    }, AGENT_ROSTER_REFRESH_DEBOUNCE_MS);
  }

  private async refreshAgentRoster() {
    const context = this.context;
    if (!context) {
      return;
    }
    const previous = context.agents.state.agentsList;
    const activeAgentId = context.agentSelection.state.selectedId;
    const next = await context.agents.refreshList();
    if (!next || this.context !== context) {
      return;
    }
    const rosterDiff = diffAgentRoster(previous?.agents ?? [], next.agents);
    if (rosterDiff.invalidatedIds.length > 0) {
      context.agents.invalidateFiles(rosterDiff.invalidatedIds);
      context.agentIdentity.invalidate(rosterDiff.invalidatedIds);
    }
    if (rosterDiff.changedIds.length > 0) {
      void context.agentIdentity.ensure(rosterDiff.changedIds);
    }
    const previousIds = new Set(previous?.agents.map((agent) => agent.id) ?? []);
    const nextIds = new Set(next.agents.map((agent) => agent.id));
    if (
      activeAgentId &&
      context.agentSelection.state.selectedId === activeAgentId &&
      previousIds.has(activeAgentId) &&
      !nextIds.has(activeAgentId)
    ) {
      context.agentSelection.set(next.defaultId);
    }
  }

  private readonly handleThemeChange = (event: CustomEvent<ThemeModeChangeDetail>) => {
    const context = this.context;
    if (!context) {
      return;
    }
    context.theme.setMode(event.detail.mode, event.detail.element);
  };

  private async handleSettingsSearchQueryChange(nextQuery: string): Promise<void> {
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

  private chatNavigationOptions(options?: ApplicationNavigationOptions) {
    const sessionKey = this.activeSessionKey.trim();
    return options ?? (sessionKey ? { search: searchForSession(sessionKey) } : undefined);
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
    if (!context || this.onboardingMode || (this.isSettingsTakeover() && !isMobileNavLayout())) {
      return;
    }
    if (isMobileNavLayout()) {
      if (this.navDrawerOpen) {
        this.closeNavDrawer({ restoreFocus: true });
        return;
      }
      this.navDrawerTrigger = trigger ?? this.querySelector<HTMLElement>(".topbar-nav-toggle");
      this.navDrawerOpen = true;
      return;
    }
    // A drawer that survived a breakpoint change is visually expanded even
    // when the persisted desktop preference says collapsed.
    const nextNavCollapsed = this.navDrawerOpen || !context.navigation.snapshot.navCollapsed;
    if (nextNavCollapsed) {
      this.dismissSidebarTransientMenus();
    }
    this.closeNavDrawer();
    context.navigation.update({
      navCollapsed: nextNavCollapsed,
    });
    if (nextNavCollapsed) {
      void this.updateComplete.then(() => {
        this.restoreFocusTo(this.querySelector<HTMLElement>(".shell-chrome-controls__nav-toggle"));
      });
    }
  }

  /** Focus a restoration target, falling back to the content anchor. Native
   * Mac chrome hides the in-page toggles, so focus must not strand on the body
   * or inside an offscreen drawer. */
  private restoreFocusTo(target: HTMLElement | null | undefined) {
    const resolved =
      target?.isConnected && target.checkVisibility()
        ? target
        : this.querySelector<HTMLElement>(".content");
    resolved?.focus();
  }

  private visibleNavDrawerToggle(): HTMLElement | undefined {
    return [
      ...this.querySelectorAll<HTMLElement>(".topbar-nav-toggle, .chat-pane__nav-toggle"),
    ].find((candidate) => candidate.checkVisibility());
  }

  private closeNavDrawer(options: { restoreFocus?: boolean } = {}) {
    if (this.navDrawerOpen) {
      this.dismissSidebarTransientMenus();
    }
    const trigger = options.restoreFocus ? this.navDrawerTrigger : null;
    this.navDrawerOpen = false;
    this.navDrawerTrigger = null;
    if (!options.restoreFocus) {
      return;
    }
    requestAnimationFrame(() => {
      this.restoreFocusTo(trigger instanceof HTMLElement ? trigger : null);
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

  private openNewSession(agentId: string, target?: NewSessionTarget) {
    this.navigate("new-session", { search: newSessionSearch(agentId, target) });
  }

  // Shipped Mac app builds without web chrome still drive these handlers.
  private readonly handleNativeToggleSidebar = () => {
    this.toggleNavigationSurface();
  };

  private readonly handleNativeOpenSearch = () => {
    this.openPalette();
  };

  private readonly handleNativeToggleSearch = (event: Event) => {
    // The ⌘K menu item intercepts the key equivalent before page keydown, so
    // closing must route through here; preventDefault acknowledges the event
    // (the native dispatcher falls back to open-search when unhandled).
    event.preventDefault();
    this.togglePalette();
  };

  private readonly handleNativeNewSession = () => {
    const context = this.context;
    if (this.onboardingMode) {
      return;
    }
    if (!context) {
      // Native hosts flush queued commands at document-finish, which can beat
      // runtime initialization; retain the request and replay once the
      // context effect fires instead of silently dropping the ⌘N. A boolean is
      // enough: the destination is idempotent, so repeated presses collapse.
      this.pendingNativeNewSession = true;
      return;
    }
    const agentId = context.agentSelection.state.selectedId ?? "";
    this.openNewSession(agentId);
  };

  private readonly handleNativeHistoryState = (event: Event) => {
    const detail = (event as CustomEvent<NativeHistoryState>).detail;
    if (typeof detail?.canGoBack !== "boolean" || typeof detail.canGoForward !== "boolean") {
      return;
    }
    this.nativeHistoryState = detail;
  };

  private readonly handleWindowResize = () => {
    this.requestUpdate();
    void this.updateComplete.then(() => {
      if (isMobileNavLayout() && !this.navDrawerOpen && this.dismissSidebarTransientMenus()) {
        requestAnimationFrame(() => {
          this.restoreFocusTo(this.visibleNavDrawerToggle());
        });
      }
    });
  };

  private readonly handleUnhandledFileDrag = (event: DragEvent) => {
    // Bubble phase is intentional: explicit drop targets get first refusal by
    // preventing the event, while only unaccepted file drags reach this fallback.
    const nativeFileInput = event
      .composedPath()
      .some(
        (target) =>
          target instanceof HTMLInputElement && target.type === "file" && !target.disabled,
      );
    if (
      event.defaultPrevented ||
      nativeFileInput ||
      !Array.from(event.dataTransfer?.types ?? []).includes("Files")
    ) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
  };

  private dismissSidebarTransientMenus(): boolean {
    return (
      this.querySelector<AppSidebarElement>("openclaw-app-sidebar")?.dismissTransientMenus() ??
      false
    );
  }

  private readonly handleShellKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Escape" || !this.navDrawerOpen) {
      return;
    }
    event.preventDefault();
    this.closeNavDrawer({ restoreFocus: true });
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (!this.commandPalette && isCommandPaletteShortcut(event)) {
      event.preventDefault();
      this.togglePalette();
      return;
    }
    if (!isOptionalElementDefined(this.terminalPanelElement) && isTerminalPanelShortcut(event)) {
      event.preventDefault();
      this.handleDeferredTerminalToggle(new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT));
      return;
    }
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
    const settingsModifier = event.metaKey !== event.ctrlKey && !event.altKey;
    if (settingsModifier && event.shiftKey && event.code === "Comma") {
      event.preventDefault();
      this.navigate("config");
      return;
    }
    const commandKey = event.metaKey && !event.ctrlKey && !event.altKey;
    if (!commandKey || event.shiftKey || event.key.toLowerCase() !== "b") {
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

  private runWithCommandPalette(action: (palette: CommandPaletteElement) => void): void {
    const palette = this.commandPalette;
    if (palette) {
      action(palette);
      return;
    }
    void ensureOptionalElementForHost(this, this.commandPaletteElement)
      .then(async () => {
        await this.updateComplete;
        const loadedPalette = this.commandPalette;
        if (loadedPalette) {
          action(loadedPalette);
        }
      })
      .catch(() => undefined);
  }

  private readonly openPalette = () => {
    this.runWithCommandPalette((palette) => palette.openPalette());
  };

  private readonly refreshControlUi = () => {
    globalThis.location.reload();
  };

  private readonly handleShellNavDrawerToggle = (event: Event) => {
    const trigger = (event as CustomEvent<ShellNavDrawerToggleDetail>).detail?.trigger;
    this.toggleNavigationSurface(trigger instanceof HTMLElement ? trigger : undefined);
  };

  private readonly togglePalette = () => {
    this.runWithCommandPalette((palette) => palette.togglePalette());
  };

  private readonly openApprovals = () => {
    const show = () => this.approvalOverlay?.show();
    if (isOptionalElementDefined(this.execApprovalElement)) {
      show();
      return;
    }
    void ensureOptionalElementForHost(this, this.execApprovalElement)
      .then(async () => {
        await this.updateComplete;
        show();
      })
      .catch(() => undefined);
  };

  private deliverPanelEventAfterLoad(element: OptionalCustomElement, event: Event): void {
    void ensureOptionalElementForHost(this, element)
      .then(async () => {
        // Definition upgrades the mounted tag; one host update applies availability before delivery.
        await this.updateComplete;
        this.querySelector<PanelToggleElement>(element.tagName)?.handleToggleRequest(event);
      })
      .catch(() => undefined);
  }

  private readonly handleDeferredTerminalToggle = (event: Event) => {
    if (isOptionalElementDefined(this.terminalPanelElement)) {
      return;
    }
    const context = this.context;
    const snapshot = context?.gateway?.snapshot;
    if (
      !snapshot ||
      !isTerminalAvailable(snapshot, context.config?.current.terminalEnabled ?? false)
    ) {
      return;
    }
    this.deliverPanelEventAfterLoad(this.terminalPanelElement, event);
  };

  private readonly handleDeferredBrowserToggle = (event: Event) => {
    if (isOptionalElementDefined(this.browserPanelElement)) {
      return;
    }
    const snapshot = this.context?.gateway?.snapshot;
    if (!snapshot || !isBrowserPanelAvailable(snapshot)) {
      return;
    }
    this.deliverPanelEventAfterLoad(this.browserPanelElement, event);
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

  /** Collapsed as seen by macOS titlebar chrome (native accessory on shipped
   * apps, the web toolbar on current ones): drawer widths, settings takeover,
   * and onboarding all hide the expanded rail. */
  private nativeNavCollapsed(): boolean {
    const mobileNavLayout = isMobileNavLayout();
    return (
      this.onboardingMode ||
      mobileNavLayout ||
      (this.isSettingsTakeover() && !mobileNavLayout) ||
      (!this.navDrawerOpen && (this.context?.navigation.snapshot.navCollapsed ?? false))
    );
  }

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
    let primaryContext = titleForRoute(routeId);
    if (routeId === "chat" && this.activeSessionKey) {
      primaryContext = this.chatTitleContext(context, outboxScopeHost) || primaryContext;
    } else if (routeId === "custodian") {
      primaryContext = t("nav.askOpenClaw");
    }
    const title = formatDocumentTitle({
      context: primaryContext,
      attentionCount: context.overlays.snapshot.approvalQueue.length,
      offline: context.gateway.snapshot.phase !== "connected",
      queuedCount: this.outboxStoreRuntime?.summarizeStoredChatOutboxes(outboxScopeHost).total ?? 0,
    });
    if (document.title !== title) {
      document.title = title;
    }
  }

  override updated() {
    this.syncDocumentTitle();
    const context = this.context;
    if (!context) {
      return;
    }
    const gatewaySnapshot = context.gateway?.snapshot;
    if (gatewaySnapshot) {
      if (isTerminalAvailable(gatewaySnapshot, context.config?.current.terminalEnabled ?? false)) {
        preloadOptionalElement(this, this.terminalPanelElement);
      }
      if (isBrowserPanelAvailable(gatewaySnapshot)) {
        preloadOptionalElement(this, this.browserPanelElement);
      }
    }
    if ((context.overlays?.snapshot.approvalQueue.length ?? 0) > 0) {
      preloadOptionalElement(this, this.execApprovalElement);
    }
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
    this.updateGatewaySessionKey(snapshot);
    this.ensureAgentsList(snapshot);
    this.ensureRuntimeConfig(snapshot);
    this.syncSidebarWorkboard();
    // Chunks are usually served by the gateway, so a failed idle load of the
    // outbox module recovers on reconnect, not only on a browser online event.
    if (snapshot.phase === "connected") {
      void this.outboxStoreImport.load().catch(() => undefined);
    }
  }

  private syncSidebarWorkboard() {
    const context = this.context;
    const snapshot = context?.gateway.snapshot;
    const configSnapshot = context?.runtimeConfig.state.configSnapshot;
    if (!context || !snapshot || !configSnapshot) {
      return;
    }
    if (!isWorkboardEnabledInConfigSnapshot(configSnapshot)) {
      this.disposeSidebarWorkboard();
      return;
    }
    const runtime = this.sidebarWorkboardRuntime;
    if (runtime) {
      if (this.sidebarWorkboardHost !== context.workboard) {
        this.disposeSidebarWorkboard();
        this.syncSidebarWorkboard();
        return;
      }
      runtime.sync(snapshot.client, snapshot.phase === "connected");
      return;
    }
    if (this.sidebarWorkboardRuntimeLoad) {
      return;
    }
    const epoch = this.sidebarWorkboardEpoch;
    const load = import("../components/app-sidebar-workboard.runtime.ts");
    this.sidebarWorkboardRuntimeLoad = load;
    void load
      .then((module) => {
        if (this.sidebarWorkboardEpoch !== epoch || this.sidebarWorkboardRuntime) {
          return;
        }
        const current = this.context;
        if (!current) {
          return;
        }
        const loadedRuntime = module.createSidebarWorkboardRuntime((nextSnapshot) => {
          if (this.sidebarWorkboardRuntime === loadedRuntime) {
            this.sidebarWorkboardSnapshot = nextSnapshot;
            this.requestUpdate();
          }
        }, current.workboard);
        this.sidebarWorkboardRuntime = loadedRuntime;
        this.sidebarWorkboardHost = current.workboard;
        this.sidebarWorkboardRenderers = {
          renderEntry: module.renderSidebarWorkboardEntry,
          renderCustomize: module.renderSidebarWorkboardCustomize,
        };
        const gateway = current?.gateway.snapshot;
        if (
          current &&
          gateway &&
          isWorkboardEnabledInConfigSnapshot(current.runtimeConfig.state.configSnapshot)
        ) {
          loadedRuntime.sync(gateway.client, gateway.phase === "connected");
        }
      })
      .catch(() => {
        if (this.sidebarWorkboardEpoch === epoch && this.sidebarWorkboardRuntimeLoad === load) {
          this.sidebarWorkboardRuntimeLoad = null;
        }
      });
  }

  private disposeSidebarWorkboard() {
    this.sidebarWorkboardEpoch += 1;
    const runtime = this.sidebarWorkboardRuntime;
    runtime?.dispose();
    if (!runtime) {
      this.context?.workboard.clearBoards();
    }
    this.sidebarWorkboardRuntime = null;
    this.sidebarWorkboardHost = null;
    this.sidebarWorkboardRenderers = undefined;
    this.sidebarWorkboardRuntimeLoad = null;
    if (this.sidebarWorkboardSnapshot !== EMPTY_SIDEBAR_WORKBOARD_SNAPSHOT) {
      this.sidebarWorkboardSnapshot = EMPTY_SIDEBAR_WORKBOARD_SNAPSHOT;
      this.requestUpdate();
    }
  }

  private ensureRuntimeConfig(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    runtimeConfig = this.context?.runtimeConfig,
  ) {
    // The sidebar hides config-gated routes (Workboard), so the snapshot must
    // load eagerly instead of waiting for a page that happens to fetch it.
    if (snapshot.phase !== "connected" || !snapshot.client || !runtimeConfig) {
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

  /** Sidebar draft-row hint while the new-session page is open, keyed off its ?agent param. */
  private draftSessionAgentId(): string {
    if (this.routeState.routeId !== "new-session") {
      return "";
    }
    return new URLSearchParams(this.routeState.location?.search ?? "").get("agent")?.trim() ?? "";
  }

  private ensureAgentsList(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    agents = this.context?.agents,
  ) {
    if (snapshot.phase !== "connected" || !snapshot.client) {
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
    const committedRouteId = routeState.committedRouteId;
    const committedSearch = routeState.committedLocation?.search ?? "";
    // Restoration and persistence both wait for a live context: consuming the
    // one-shot restore without a router to call, or persisting the bootstrap
    // route first, would clobber the stored route.
    const routeContext = this.context;
    if (committedRouteId && routeContext) {
      // A rendered/pending match that differs from the committed route is an
      // in-flight navigation: it wins over the one-shot restore, and the stale
      // committed route must not be persisted over the remembered destination.
      const pendingDiffers =
        routeState.routeId !== committedRouteId ||
        (routeState.location?.search ?? "") !== committedSearch;
      if (!this.didConsiderNativeRouteRestore) {
        this.didConsiderNativeRouteRestore = true;
        const storedRoute = pendingDiffers
          ? null
          : considerRouteRestore(committedRouteId, committedSearch);
        if (storedRoute) {
          // Replace instead of push so a fresh window does not start with a
          // Back entry pointing at the bootstrap chat route.
          routeContext.replace(storedRoute.routeId, { search: storedRoute.search });
          return;
        }
      }
      if (!pendingDiffers) {
        persistRoute(committedRouteId, committedSearch);
      }
    }
    const context = this.context;
    if (context) {
      this.ensureAgentsList(context.gateway.snapshot);
    }
    if (routeState.routeId && !isSettingsNavigationRoute(routeState.routeId)) {
      this.settingsSearchQuery = "";
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
    const gatewayConnected = gatewaySnapshot.phase === "connected";
    const outboxScopeHost = this.storedOutboxScopeHost(context);
    const outboxStoreRuntime = this.outboxStoreRuntime;
    const storedOutboxes = outboxStoreRuntime
      ? outboxStoreRuntime.summarizeStoredChatOutboxes(outboxScopeHost)
      : null;
    const outboxCountForSession = outboxStoreRuntime
      ? (sessionKey: string) => {
          const scope = outboxStoreRuntime.resolveStoredChatOutboxScope(
            outboxScopeHost,
            sessionKey,
          );
          return (
            storedOutboxes?.countsByScope.get(outboxStoreRuntime.storedChatOutboxScopeKey(scope)) ??
            0
          );
        }
      : EMPTY_OUTBOX_COUNT_FOR_SESSION;
    const navigationSnapshot = context.navigation.snapshot;
    const overlaySnapshot = context.overlays.snapshot;
    const terminalAvailable = isTerminalAvailable(
      gatewaySnapshot,
      context.config.current.terminalEnabled ?? false,
    );
    const browserPanelAvailable = isBrowserPanelAvailable(gatewaySnapshot);
    const activeRoute = this.routeState.routeId ?? "chat";
    // Plugin tabs share one route; the search picks the active item.
    const activePluginRef =
      activeRoute === "plugin"
        ? pluginTabRefFromSearch(this.routeState.location?.search ?? "")
        : null;
    const activePluginTabId = activePluginRef ? pluginTabKey(activePluginRef) : "";
    const settingsTakeover = isSettingsNavigationRoute(activeRoute);
    const runtimeConfig = context.runtimeConfig.state;
    const settingsSearchBlocks = findSettingsSearchBlocks({
      query: this.settingsSearchQuery,
      schema: runtimeConfig.configSchema,
      value: runtimeConfig.configForm ?? runtimeConfig.configSnapshot?.config ?? null,
      uiHints: runtimeConfig.configUiHints,
      identityAvailable: Boolean(gatewaySnapshot.selfUser),
    });
    const onboarding = this.onboardingMode;
    const navDrawerOpen = this.navDrawerOpen && !onboarding;
    const mobileNavLayout = isMobileNavLayout();
    const mergedChatChrome = shouldMergeChatChrome({
      mobileNavLayout,
      routeId: activeRoute,
      onboarding,
    });
    // Drawer navigation always opens expanded; the desktop collapse preference
    // stays persisted for when the viewport returns to the desktop layout.
    // The settings sidebar has a fixed width, so the collapse state pauses too.
    const navCollapsed = navigationSnapshot.navCollapsed && !navDrawerOpen && !settingsTakeover;
    const navigationSurfaceHidden = navigationSurfaceIsHidden({
      navCollapsed,
      navDrawerOpen,
      mobileNavLayout,
    });
    const shellWidth = Math.max(globalThis.innerWidth || 0, NAV_WIDTH_MAX);
    // Mirror the sidebar brand action: an open new-session draft wins over the
    // persisted selection so the collapsed cluster "+" targets the same agent.
    const selectedAgentId = normalizeAgentId(
      this.draftSessionAgentId() ||
        (context.agentSelection.state.selectedId ?? gatewaySnapshot.assistantAgentId),
    );
    // One storage read per render; theme.refresh() re-renders on pref changes.
    const uiSettings = loadSettings();
    // The new-session draft shares the chat layout: full-height pane that owns
    // its scrolling and pins the composer dock to the bottom.
    const chatLikeRoute =
      activeRoute === "chat" || activeRoute === "custodian" || activeRoute === "new-session";
    const inlineApproval =
      activeRoute === "chat"
        ? findInlineApproval(overlaySnapshot.approvalQueue, this.activeSessionKey)
        : null;
    // Optional tags stay mounted before definition. Lit replays their properties on upgrade,
    // and the upgraded panels catch the first toggle instead of dropping the event.
    return html`
      ${isOptionalElementDefined(this.commandPaletteElement)
        ? html`<openclaw-command-palette
            .onNavigate=${(routeId: RouteId) => this.navigate(routeId)}
            .onSelectSession=${(sessionKey: string) => {
              context.gateway.setSessionKey(sessionKey);
              this.navigate("chat", { search: searchForSession(sessionKey) });
            }}
            .onSlashCommand=${this.handleCommandPaletteSlashCommand}
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
        @keydown=${this.handleShellKeydown}
        @theme-change=${this.handleThemeChange}
      >
        <a class="shell-skip-link" href="#control-ui-main"> ${t("common.skipToMainContent")} </a>
        <button
          type="button"
          class="shell-nav-backdrop"
          aria-label=${t("nav.close")}
          @click=${() => this.closeNavDrawer({ restoreFocus: true })}
        ></button>
        ${isNativeWebChromeHost() && !onboarding
          ? html`
              <openclaw-macos-titlebar-controls
                .navCollapsed=${this.nativeNavCollapsed()}
                .historyOnly=${settingsTakeover}
                .canGoBack=${this.nativeHistoryState.canGoBack}
                .canGoForward=${this.nativeHistoryState.canGoForward}
                .onToggleSidebar=${() => this.toggleNavigationSurface()}
                .onOpenPalette=${this.openPalette}
                .onOpenNewSession=${this.handleNativeNewSession}
              ></openclaw-macos-titlebar-controls>
            `
          : nothing}
        <openclaw-app-topbar
          .basePath=${context.basePath}
          .searchDisabled=${false}
          .navDrawerOpen=${navDrawerOpen}
          .onboarding=${onboarding}
          .onOpenPalette=${this.openPalette}
          .onToggleDrawer=${(trigger: HTMLElement) => this.toggleNavigationSurface(trigger)}
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
                    @click=${() => this.toggleNavigationSurface()}
                  >
                    ${navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}
                  </button>
                </openclaw-tooltip>
                ${navCollapsed
                  ? html`<openclaw-tooltip
                      .content=${gatewaySnapshot.phase === "connected"
                        ? t("chat.runControls.newSession")
                        : t("chat.runControls.newSessionDisconnected")}
                    >
                      <button
                        type="button"
                        class="shell-chrome-controls__button shell-chrome-controls__new-thread"
                        aria-label=${t("chat.runControls.newSession")}
                        ?disabled=${gatewaySnapshot.phase !== "connected"}
                        @click=${() => this.openNewSession(selectedAgentId)}
                      >
                        ${icons.plus}
                      </button>
                    </openclaw-tooltip>`
                  : nothing}
                <openclaw-tooltip
                  .content=${`${t("chat.openCommandPalette")} (${PALETTE_SHORTCUT})`}
                >
                  <button
                    type="button"
                    class="shell-chrome-controls__button shell-chrome-controls__search"
                    aria-label=${t("chat.openCommandPalette")}
                    @click=${this.openPalette}
                  >
                    ${icons.search}
                  </button>
                </openclaw-tooltip>
              </div>
            `
          : nothing}
        <div class="shell-nav">
          ${settingsTakeover
            ? renderSettingsSidebar({
                basePath: context.basePath,
                activeRouteId: activeRoute,
                activeSearch: this.routeState.location?.search ?? "",
                activeHash: this.routeState.location?.hash ?? "",
                offline: gatewaySnapshot.offlineStable,
                queuedOutboxCount: storedOutboxes?.total ?? 0,
                lastError: gatewaySnapshot.lastError,
                version:
                  context.config.current.serverVersion ??
                  gatewaySnapshot.hello?.server?.version ??
                  "",
                updateAvailable: navigationSurfaceHidden ? null : overlaySnapshot.updateAvailable,
                updateRunning: overlaySnapshot.updateRunning,
                onUpdate: () => void context.overlays.runUpdate(),
                searchQuery: this.settingsSearchQuery,
                searchBlockMatches: settingsSearchBlocks,
                onExit: () => this.exitSettings(),
                onRetryConnect: () => context.gateway.connect(),
                onNavigate: (routeId, options) => this.navigate(routeId, options),
                onPreload: (routeId) => context.preload(routeId),
                onSearchQueryChange: (nextQuery) => {
                  void this.handleSettingsSearchQueryChange(nextQuery);
                },
                preloadTimers: this.settingsPreloadTimers,
              })
            : html`<openclaw-app-sidebar
                .basePath=${context.basePath}
                .activeRouteId=${activeRoute}
                .activePluginTabId=${activePluginTabId}
                .enabledRouteIds=${this.enabledRouteIds()}
                .activeWorkboardBoardId=${workboardBoardIdFromPath(
                  this.routeState.location?.pathname ?? "",
                  context.basePath,
                ) ?? ""}
                .sessionKey=${this.activeSessionKey}
                .connected=${gatewayConnected}
                .offline=${gatewaySnapshot.offlineStable}
                .outboxCountForSession=${outboxCountForSession}
                .terminalAvailable=${terminalAvailable}
                .catalogOpenTarget=${normalizeCatalogOpenTarget(uiSettings.catalogOpenTarget)}
                .canPairDevice=${gatewayConnected &&
                hasOperatorAdminAccess(gatewaySnapshot.hello?.auth ?? null)}
                .sidebarEntries=${navigationSnapshot.sidebarEntries}
                .workboardBoards=${this.sidebarWorkboardSnapshot.boards}
                .workboardBoardsReady=${this.sidebarWorkboardSnapshot.ready}
                .workboardRenderers=${this.sidebarWorkboardRenderers}
                .sidebarLiveActivity=${uiSettings.sidebarLiveActivity !== false}
                .pinnedAgentIds=${navigationSnapshot.pinnedAgentIds}
                .themeMode=${context.theme.mode}
                .lobsterPetVisits=${uiSettings.lobsterPetVisits !== false}
                .lobsterPetSounds=${uiSettings.lobsterPetSounds === true}
                .gatewayVersion=${context.config.current.serverVersion ??
                gatewaySnapshot.hello?.server?.version ??
                null}
                .devGitBranch=${context.config.current.devGitBranch}
                .updateAvailable=${navigationSurfaceHidden ? null : overlaySnapshot.updateAvailable}
                .updateRunning=${overlaySnapshot.updateRunning}
                .onUpdate=${() => void context.overlays.runUpdate()}
                .onOpenApprovals=${this.openApprovals}
                .onRetryConnect=${() => context.gateway.connect()}
                .onOpenNewSession=${(agentId: string, target?: NewSessionTarget) =>
                  this.openNewSession(agentId, target)}
                .draftSessionAgentId=${this.draftSessionAgentId()}
                .onUpdateSidebarEntries=${(entries: string[]) =>
                  context.navigation.update({ sidebarEntries: entries })}
                .onPairMobile=${() => void context.overlays.openDevicePairSetup()}
                .onNavigate=${(routeId: string, options?: ApplicationNavigationOptions) =>
                  this.navigate(routeId, options)}
                .onPreloadRoute=${(routeId: string) =>
                  isRouteId(routeId) ? context.preload(routeId) : Promise.resolve()}
              ></openclaw-app-sidebar>`}
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
                  this.resizeNavigation(event.detail.splitRatio)}
              ></resizable-divider>
            `
          : nothing}
        <main
          id="control-ui-main"
          class="content ${chatLikeRoute ? "content--chat" : ""} ${activeRoute === "workboard"
            ? "content--workboard"
            : ""}"
          .tabIndex=${-1}
        >
          ${gatewaySnapshot.hello?.deviceAuthMigration?.pending === true
            ? customElements.get("openclaw-device-auth-migration-banner")
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
            : html`<openclaw-update-banner
                .props=${{
                  statusBanner: overlaySnapshot.controlUiRefreshRequired
                    ? {
                        tone: "info",
                        text: "Server updated — refresh for full capabilities",
                      }
                    : null,
                  action: overlaySnapshot.controlUiRefreshRequired
                    ? { label: t("common.refresh"), onClick: this.refreshControlUi }
                    : undefined,
                }}
              ></openclaw-update-banner>`}
          <openclaw-update-banner
            .props=${{
              statusBanner: overlaySnapshot.updateStatusBanner,
            }}
          ></openclaw-update-banner>
          ${renderFloatingUpdateCard({
            navigationSurfaceHidden,
            onboarding,
            updateAvailable: overlaySnapshot.updateAvailable,
            updateRunning: overlaySnapshot.updateRunning,
            onUpdate: () => void context.overlays.runUpdate(),
          })}
          <openclaw-router-outlet
            .router=${runtime.router}
            .retryContext=${context}
            .onNotFound=${() => this.replaceChatWithCurrentSession()}
          ></openclaw-router-outlet>
        </main>
        <openclaw-terminal-panel
          .client=${gatewayConnected ? gatewaySnapshot.client : null}
          .available=${terminalAvailable}
          .themeMode=${resolveTerminalThemeMode()}
        ></openclaw-terminal-panel>
        <openclaw-browser-panel
          .client=${gatewayConnected ? gatewaySnapshot.client : null}
          .available=${browserPanelAvailable}
          .basePath=${context.basePath}
          .authToken=${resolveControlUiAuthToken({
            hello: gatewaySnapshot.hello,
            settings: { token: context.gateway.connection.token },
            password: context.gateway.connection.password,
          })}
        ></openclaw-browser-panel>
        ${isOptionalElementDefined(this.execApprovalElement)
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
          onCopy: (setupCode) => void copyToClipboard(setupCode),
          onManageDevices: () => {
            context.overlays.closeDevicePairSetup();
            this.navigate("nodes");
          },
          onGetApps: () => {
            context.overlays.closeDevicePairSetup();
            this.navigate("apps");
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
}
if (!customElements.get("openclaw-app")) {
  customElements.define("openclaw-app", OpenClawApp);
}
if (!customElements.get("openclaw-app-shell")) {
  customElements.define("openclaw-app-shell", OpenClawShell);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
