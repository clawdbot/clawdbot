import { consume } from "@lit/context";
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import {
  cancelRoutePreload,
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  isSettingsNavigationRoute,
  navigationIconForRoute,
  scheduleRoutePreload,
  type NavigationRouteId,
  SIDEBAR_NAV_ROUTES,
  type SidebarNavRoute,
  sidebarMoreRoutes,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationNavigationOptions,
} from "../app/context.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { startHoverMarquee, stopHoverMarquee } from "../lib/hover-marquee.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  dissolveSessionGroup,
  loadStoredSessionCustomGroups,
  renameSessionGroup,
  saveStoredSessionCustomGroups,
} from "../lib/sessions/custom-groups.ts";
import { writeSessionDragData } from "../lib/sessions/drag.ts";
import {
  groupSidebarSessionRows,
  normalizeSidebarSessionsGrouping,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import {
  compareSessionRowsByUpdatedAt,
  resolveSessionNavigation,
  searchForSession,
} from "../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  canArchiveSessionRow,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import {
  resolvePreferredSessionForAgent,
  resolveSessionAgentFilterOptions,
} from "../lib/sessions/session-options.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { pluginTabKey, pluginTabSearch } from "../pages/plugin/route.ts";
import { icons, type IconName } from "./icons.ts";

type SidebarRecentSession = {
  key: string;
  label: string;
  meta: string;
  href: string;
  active: boolean;
  visuallyActive: boolean;
  hasActiveRun: boolean;
  kind?: string;
  pinned: boolean;
  category?: string;
  unread: boolean;
};

type SidebarSessionMenuState = {
  session: SidebarRecentSession;
  x: number;
  y: number;
  submenuLeft: boolean;
};

type SidebarSessionGroupMenuState = {
  group: string;
  x: number;
  y: number;
};

type SidebarSessionSortMode = "created" | "updated";

const SIDEBAR_SESSION_GROUPING_STORAGE_KEY = "openclaw:sidebar:sessions:grouping";

const PALETTE_SHORTCUT = /Mac|iP(hone|ad|od)/i.test(globalThis.navigator?.platform ?? "")
  ? "⌘K"
  : "Ctrl K";

function loadStoredSidebarSessionsGrouping(): SidebarSessionsGrouping {
  return normalizeSidebarSessionsGrouping(
    getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_GROUPING_STORAGE_KEY),
  );
}

const SIDEBAR_SESSION_SORT_OPTIONS = [
  { mode: "created", labelKey: "chat.sidebar.sortCreated" },
  { mode: "updated", labelKey: "chat.sidebar.sortUpdated" },
] as const satisfies ReadonlyArray<{
  mode: SidebarSessionSortMode;
  labelKey: "chat.sidebar.sortCreated" | "chat.sidebar.sortUpdated";
}>;

function formatSidebarTimestamp(timestampMs: number | null | undefined): string {
  const value = formatRelativeTimestamp(timestampMs, { fallback: "" });
  if (value === "just now") {
    return "now";
  }
  return value.endsWith(" ago") ? value.slice(0, -" ago".length) : value;
}

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

class AppSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) activePluginTabId = "";
  @property({ attribute: false }) enabledRouteIds?: readonly NavigationRouteId[];
  @property({ attribute: false }) collapsed = false;
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) canPairDevice = false;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) sidebarPinnedRoutes: readonly SidebarNavRoute[] =
    DEFAULT_SIDEBAR_PINNED_ROUTES;
  @property({ attribute: false }) sidebarMoreExpanded = false;
  @property({ attribute: false }) themeMode: ThemeMode = "system";
  @property({ attribute: false }) onOpenPalette?: () => void;
  @property({ attribute: false }) onToggleSidebar?: () => void;
  @property({ attribute: false }) onToggleMore?: () => void;
  @property({ attribute: false }) onUpdatePinnedRoutes?: (routes: SidebarNavRoute[]) => void;
  @property({ attribute: false }) onPairMobile?: () => void;
  @property({ attribute: false })
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  @property({ attribute: false }) onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;

  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext<RouteId>;
  @state() private customizeMenuPosition: { x: number; y: number } | null = null;
  @state() private sessionMenu: SidebarSessionMenuState | null = null;
  @state() private sessionGroupSubmenuOpen = false;
  @state() private sessionGroupMenu: SidebarSessionGroupMenuState | null = null;
  @state() private draggingSessionKey: string | null = null;
  @state() private sessionSortMode: SidebarSessionSortMode = "created";
  @state() private sessionsGrouping: SidebarSessionsGrouping = loadStoredSidebarSessionsGrouping();
  @state() private sessionSortMenuPosition: { x: number; y: number } | null = null;
  @state() private sessionsResult: SessionsListResult | null = null;
  @state() private sessionsAgentId: string | null = null;
  @state() private sessionsLoading = false;

  private stopSessionsSubscription: (() => void) | undefined;
  private stopSessionCreatedSubscription: (() => void) | undefined;
  private stopAgentsSubscription: (() => void) | undefined;
  private stopAgentSelectionSubscription: (() => void) | undefined;
  private stopGatewaySubscription: (() => void) | undefined;
  private customizeMenuTrigger: HTMLElement | null = null;
  private sessionMenuTrigger: HTMLElement | null = null;
  private sessionGroupMenuTrigger: HTMLElement | null = null;
  private sessionSortMenuTrigger: HTMLElement | null = null;
  private sessionRowsByAgent: Record<string, SessionsListResult["sessions"]> = {};
  private sessionCreatedOrder = new Map<string, number>();
  private gatewayClient: GatewayBrowserClient | null = null;
  private readonly routePreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
    this.startSubscriptions();
  }

  override disconnectedCallback() {
    this.closeCustomizeMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.stopSessionsSubscription?.();
    this.stopSessionsSubscription = undefined;
    this.stopSessionCreatedSubscription?.();
    this.stopSessionCreatedSubscription = undefined;
    this.stopAgentsSubscription?.();
    this.stopAgentsSubscription = undefined;
    this.stopAgentSelectionSubscription?.();
    this.stopAgentSelectionSubscription = undefined;
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.gatewayClient = null;
    for (const timer of this.routePreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.routePreloadTimers.clear();
    super.disconnectedCallback();
  }

  private startSubscriptions() {
    const context = this.context;
    if (
      !context ||
      this.stopSessionsSubscription ||
      this.stopSessionCreatedSubscription ||
      this.stopAgentsSubscription ||
      this.stopAgentSelectionSubscription ||
      this.stopGatewaySubscription
    ) {
      return;
    }
    this.updateGatewayClient(context.gateway.snapshot);
    this.updateSessions(context.sessions.state);
    this.stopSessionsSubscription = context.sessions.subscribe((snapshot) => {
      this.updateSessions(snapshot);
    });
    this.stopSessionCreatedSubscription = context.sessions.subscribeCreated((key) => {
      this.promoteCreatedSession(key);
    });
    this.stopAgentsSubscription = context.agents.subscribe(() => {
      this.requestUpdate();
    });
    this.stopAgentSelectionSubscription = context.agentSelection.subscribe(() => {
      this.requestUpdate();
    });
    this.stopGatewaySubscription = context.gateway.subscribe((snapshot) => {
      this.updateGatewayClient(snapshot);
      this.requestUpdate();
    });
  }

  override updated() {
    this.startSubscriptions();
  }

  private readonly updateSessions = (snapshot: {
    result: SessionsListResult | null;
    agentId: string | null;
    loading: boolean;
  }) => {
    this.sessionsResult = snapshot.result;
    this.sessionsAgentId = snapshot.agentId;
    this.sessionsLoading = snapshot.loading;
    if (snapshot.result) {
      for (const row of snapshot.result.sessions) {
        if (row.key && !this.sessionCreatedOrder.has(row.key)) {
          this.sessionCreatedOrder.set(row.key, this.sessionCreatedOrder.size);
        }
      }
    }
    if (snapshot.result && snapshot.agentId) {
      this.sessionRowsByAgent[normalizeAgentId(snapshot.agentId)] = snapshot.result.sessions;
    }
  };

  private updateGatewayClient(snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
  }) {
    const client = snapshot.connected ? snapshot.client : null;
    if (client === this.gatewayClient) {
      return;
    }
    this.sessionRowsByAgent = {};
    this.sessionCreatedOrder.clear();
    this.gatewayClient = client;
  }

  private renderBrand() {
    const collapseLabel = this.collapsed ? t("nav.expand") : t("nav.collapse");
    const collapseTooltip = `${collapseLabel} (⌘B)`;
    return html`
      <div class="sidebar-brand">
        <div class="sidebar-brand__identity">
          <img
            class="sidebar-brand__logo"
            src=${controlUiPublicAssetPath("apple-touch-icon.png", this.basePath)}
            alt=""
            aria-hidden="true"
          />
          ${this.collapsed ? nothing : html`<span class="sidebar-brand__title">OpenClaw</span>`}
        </div>
        <div class="sidebar-brand__actions">
          ${this.renderSearch()}
          <openclaw-tooltip .content=${collapseTooltip}>
            <button
              class="sidebar-brand__icon"
              type="button"
              @click=${() => this.onToggleSidebar?.()}
              aria-label=${collapseLabel}
              aria-expanded=${String(!this.collapsed)}
            >
              ${this.collapsed ? icons.panelLeftOpen : icons.panelLeftClose}
            </button>
          </openclaw-tooltip>
        </div>
      </div>
    `;
  }

  private getRouteSessionKey(): string {
    return this.sessionKey.trim() || this.context?.gateway.snapshot.sessionKey.trim() || "";
  }

  private readonly compareSidebarSessionRows = (
    a: SessionsListResult["sessions"][number],
    b: SessionsListResult["sessions"][number],
  ) => {
    if (this.sessionSortMode === "updated") {
      return compareSessionRowsByUpdatedAt(a, b);
    }
    return (
      (this.sessionCreatedOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
      (this.sessionCreatedOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    );
  };

  private promoteCreatedSession(sessionKey: string) {
    const currentOrder = this.sessionCreatedOrder.get(sessionKey);
    if (currentOrder === 0) {
      return;
    }
    for (const [key, order] of this.sessionCreatedOrder) {
      if (key !== sessionKey && (currentOrder === undefined || order < currentOrder)) {
        this.sessionCreatedOrder.set(key, order + 1);
      }
    }
    this.sessionCreatedOrder.set(sessionKey, 0);
    this.requestUpdate();
  }

  private getSessionNavigationState() {
    const context = this.context;
    const routeSessionKey = this.getRouteSessionKey();
    const navigation = resolveSessionNavigation({
      result: this.sessionsResult,
      resultAgentId: this.sessionsAgentId,
      sessionKey: routeSessionKey,
      assistantAgentId:
        context?.agentSelection.state.selectedId ?? context?.gateway.snapshot.assistantAgentId,
      hello: context?.gateway.snapshot.hello,
      compareSessions: this.compareSidebarSessionRows,
    });
    const highlightCurrentSession = this.activeRouteId === "chat";
    const toSidebarSession = (row: SessionsListResult["sessions"][number]) => ({
      key: row.key,
      label: resolveSessionDisplayName(row.key, row),
      meta: formatSidebarTimestamp(row.updatedAt),
      href: `${pathForRoute("chat", context?.basePath ?? "")}${searchForSession(row.key)}`,
      active: row.key === navigation.activeRowKey,
      visuallyActive: highlightCurrentSession && row.key === navigation.currentSessionKey,
      hasActiveRun: Boolean(row.hasActiveRun),
      kind: row.kind,
      pinned: row.pinned === true,
      category: normalizeOptionalString(row.category),
      unread: row.unread === true,
    });
    const recentSessions = navigation.recentSessions.map(toSidebarSession);
    const newSessionDisabled =
      !this.connected || this.sessionsLoading || Boolean(navigation.selectedSession?.hasActiveRun);
    return {
      routeSessionKey: navigation.currentSessionKey,
      selectedAgentId: navigation.selectedAgentId,
      recentSessions,
      newSessionDisabled,
      newSessionTitle: !this.connected
        ? "Connect to create a new session"
        : navigation.selectedSession?.hasActiveRun
          ? "Finish the active run before creating a new session"
          : "New session",
    };
  }

  private readonly selectSession = (sessionKey: string) => {
    this.context?.gateway.setSessionKey(sessionKey);
    this.onNavigate?.("chat", {
      search: searchForSession(sessionKey),
    });
  };

  private readonly replaceCurrentSession = (sessionKey: string) => {
    this.context?.gateway.setSessionKey(sessionKey);
    if (this.activeRouteId === "chat") {
      this.onNavigate?.("chat", {
        search: searchForSession(sessionKey),
      });
    }
  };

  private readonly selectAgent = (agentId: string) => {
    const context = this.context;
    if (!context) {
      return;
    }
    const { routeSessionKey, selectedAgentId } = this.getSessionNavigationState();
    const nextAgentId = normalizeAgentId(agentId);
    if (nextAgentId === normalizeAgentId(selectedAgentId)) {
      return;
    }
    const nextSessionKey = resolvePreferredSessionForAgent(
      {
        agentsList: context.agents.state.agentsList,
        chatAgentSessionRowsByAgent: this.sessionRowsByAgent,
        sessionsResult: this.sessionsResult,
        sessionKey: routeSessionKey,
      },
      nextAgentId,
    );
    context.agentSelection.set(nextAgentId);
    this.selectSession(nextSessionKey);
  };

  private readonly createSession = async (worktree = false) => {
    const context = this.context;
    if (!context) {
      return;
    }
    const { routeSessionKey, selectedAgentId, newSessionDisabled } =
      this.getSessionNavigationState();
    if (newSessionDisabled) {
      return;
    }
    const nextSessionKey = await context.sessions.create({
      currentSessionKey: routeSessionKey,
      agentId: selectedAgentId,
      ...(worktree ? { worktree: true } : {}),
    });
    if (nextSessionKey) {
      this.selectSession(nextSessionKey);
    }
  };

  private readonly patchSession = async (
    session: SidebarRecentSession,
    patch: {
      archived?: boolean;
      pinned?: boolean;
      unread?: boolean;
      label?: string | null;
      category?: string | null;
    },
  ) => {
    const context = this.context;
    if (!context || !this.connected) {
      return;
    }
    const { selectedAgentId } = this.getSessionNavigationState();
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? selectedAgentId;
    try {
      const patched = await context.sessions.patch(session.key, patch, { agentId });
      if (!patched || patch.archived !== true || !session.active) {
        return;
      }
      this.replaceCurrentSession(
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: context.agents.state.agentsList,
            hello: context.gateway.snapshot.hello,
          }),
        }),
      );
    } catch {
      // Session capability publishes the actionable error for the owning page.
    }
  };

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

  private isRouteEnabled(routeId: NavigationRouteId): boolean {
    return this.enabledRouteIds?.includes(routeId) ?? true;
  }

  private readonly openCustomizeMenuFromContext = (event: MouseEvent) => {
    if (this.collapsed) {
      return;
    }
    event.preventDefault();
    this.openCustomizeMenu(event.clientX, event.clientY);
  };

  private openCustomizeMenu(x: number, y: number, trigger: HTMLElement | null = null) {
    // Clamp so the fixed-position menu never overflows the viewport.
    const menuWidth = 240;
    const menuMaxHeight = 420;
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
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
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  private openSessionMenu(
    session: SidebarRecentSession,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ) {
    const menuWidth = 240;
    const menuMaxHeight = 460;
    this.closeCustomizeMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.sessionMenuTrigger = trigger;
    this.sessionGroupSubmenuOpen = false;
    const clampedX = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
    this.sessionMenu = {
      session,
      x: clampedX,
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
      submenuLeft: clampedX + menuWidth * 2 + 4 > window.innerWidth - 8,
    };
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(".sidebar-session-menu__item")?.focus();
    });
  }

  private closeSessionMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.sessionMenuTrigger;
    this.sessionMenuTrigger = null;
    this.sessionMenu = null;
    this.sessionGroupSubmenuOpen = false;
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  private openSessionGroupMenu(group: string, x: number, y: number, trigger: HTMLElement | null) {
    const menuWidth = 224;
    const menuMaxHeight = 160;
    this.closeCustomizeMenu();
    this.closeSessionMenu();
    this.closeSessionSortMenu();
    this.sessionGroupMenuTrigger = trigger;
    this.sessionGroupMenu = {
      group,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
    };
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(
        ".sidebar-session-group-menu .sidebar-session-menu__item",
      )?.focus();
    });
  }

  private closeSessionGroupMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.sessionGroupMenuTrigger;
    this.sessionGroupMenuTrigger = null;
    this.sessionGroupMenu = null;
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  private openSessionSortMenu(x: number, y: number, trigger: HTMLElement | null = null) {
    const menuWidth = 200;
    const menuMaxHeight = 280;
    this.closeCustomizeMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.sessionSortMenuTrigger = trigger;
    this.sessionSortMenuPosition = {
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
    };
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(".sidebar-session-sort-menu__item")?.focus();
    });
  }

  private closeSessionSortMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.sessionSortMenuTrigger;
    this.sessionSortMenuTrigger = null;
    this.sessionSortMenuPosition = null;
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  private knownSessionGroups(): string[] {
    const loaded = (this.sessionsResult?.sessions ?? [])
      .map((row) => normalizeOptionalString(row.category))
      .filter((name): name is string => Boolean(name));
    return [...new Set([...loadStoredSessionCustomGroups(), ...loaded])].toSorted((a, b) =>
      a.localeCompare(b),
    );
  }

  private rememberSessionGroup(name: string) {
    const groups = this.knownSessionGroups();
    if (!groups.includes(name)) {
      saveStoredSessionCustomGroups([...groups, name]);
    }
  }

  private renameSession(session: SidebarRecentSession) {
    const nextLabel = window.prompt(t("sessionsView.renameSessionPrompt"), session.label);
    if (nextLabel === null) {
      return;
    }
    void this.patchSession(session, { label: normalizeOptionalString(nextLabel) ?? null });
  }

  private createSessionGroup(session?: SidebarRecentSession) {
    const name = window.prompt(t("sessionsView.newGroupPrompt"))?.trim();
    if (!name) {
      return;
    }
    this.rememberSessionGroup(name);
    if (session) {
      void this.patchSession(session, { category: name });
    } else {
      // Header-created groups start empty; re-render so the section shows up.
      this.requestUpdate();
    }
  }

  private renameSessionGroupFromMenu(group: string) {
    const context = this.context;
    if (!context || !this.connected) {
      return;
    }
    const next = window.prompt(t("sessionsView.renameGroupPrompt"), group)?.trim();
    if (!next || next === group) {
      return;
    }
    void renameSessionGroup(context.sessions, group, next).finally(() => this.requestUpdate());
  }

  private deleteSessionGroupFromMenu(group: string) {
    const context = this.context;
    if (!context || !this.connected) {
      return;
    }
    if (!window.confirm(t("sessionsView.deleteGroupConfirm", { group }))) {
      return;
    }
    void dissolveSessionGroup(context.sessions, group).finally(() => this.requestUpdate());
  }

  private setSessionsGrouping(grouping: SidebarSessionsGrouping) {
    this.sessionsGrouping = grouping;
    try {
      getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_GROUPING_STORAGE_KEY, grouping);
    } catch {
      // ignore storage failures
    }
  }

  private async forkSession(session: SidebarRecentSession) {
    const context = this.context;
    if (!context) {
      return;
    }
    const { selectedAgentId } = this.getSessionNavigationState();
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? selectedAgentId;
    const key = await context.sessions.create({
      parentSessionKey: session.key,
      fork: true,
      agentId,
    });
    if (key) {
      this.selectSession(key);
    }
  }

  private async deleteSession(session: SidebarRecentSession) {
    const context = this.context;
    if (!context || !context.hostPolicy.canInvokeAction("sessions.delete")) {
      return;
    }
    if (!window.confirm(t("sessionsView.deleteSessionConfirm", { session: session.label }))) {
      return;
    }
    const { selectedAgentId } = this.getSessionNavigationState();
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? selectedAgentId;
    try {
      const deleted = await context.sessions.delete(session.key, {
        agentId,
        deleteTranscript: true,
      });
      if (!deleted || !session.active) {
        return;
      }
      this.replaceCurrentSession(
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: context.agents.state.agentsList,
            hello: context.gateway.snapshot.hello,
          }),
        }),
      );
    } catch {
      // Session capability publishes the actionable error for the owning page.
    }
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent) => {
    const path = event.composedPath();
    const menu = this.querySelector(
      ".sidebar-customize-menu, .sidebar-session-menu, .sidebar-session-sort-menu",
    );
    if (menu && path.includes(menu)) {
      return;
    }
    this.closeCustomizeMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.closeCustomizeMenu({ restoreFocus: true });
      this.closeSessionMenu({ restoreFocus: true });
      this.closeSessionGroupMenu({ restoreFocus: true });
      this.closeSessionSortMenu({ restoreFocus: true });
    }
  };

  private togglePinnedRoute(routeId: SidebarNavRoute) {
    const pinned = this.sidebarPinnedRoutes;
    const next = pinned.includes(routeId)
      ? pinned.filter((route) => route !== routeId)
      : [...pinned, routeId];
    this.onUpdatePinnedRoutes?.(next);
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
          const pinned = this.sidebarPinnedRoutes.includes(routeId);
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

  private renderSessionMenu() {
    const menu = this.sessionMenu;
    if (!menu) {
      return nothing;
    }
    const { session } = menu;
    const context = this.context;
    // Guards both Archive and Delete: agent main sessions and active runs are
    // protected from casual retirement in this menu.
    const archiveAllowed = canArchiveSessionRow(
      session,
      resolveUiConfiguredMainKey({
        agentsList: context?.agents.state.agentsList,
        hello: context?.gateway.snapshot.hello,
      }),
    );
    const deleteAllowed = context?.hostPolicy.canInvokeAction("sessions.delete") ?? true;
    const groups = this.knownSessionGroups();
    return html`
      <div
        class="sidebar-session-menu"
        role="menu"
        aria-label=${t("chat.sidebar.sessionMenu", { session: session.label })}
        style="left: ${menu.x}px; top: ${menu.y}px;"
      >
        <button
          type="button"
          class="sidebar-session-menu__item"
          role="menuitem"
          ?disabled=${!this.connected}
          @click=${() => {
            this.closeSessionMenu();
            void this.patchSession(session, { pinned: !session.pinned });
          }}
        >
          <span class="sidebar-session-menu__icon" aria-hidden="true">${icons.pin}</span>
          <span class="sidebar-session-menu__text"
            >${session.pinned ? t("sessionsView.unpinSession") : t("sessionsView.pinSession")}</span
          >
        </button>
        <button
          type="button"
          class="sidebar-session-menu__item"
          role="menuitem"
          ?disabled=${!this.connected}
          @click=${() => {
            this.closeSessionMenu();
            void this.patchSession(session, { unread: !session.unread });
          }}
        >
          <span class="sidebar-session-menu__icon" aria-hidden="true"
            >${session.unread ? icons.eye : icons.circle}</span
          >
          <span class="sidebar-session-menu__text"
            >${session.unread ? t("sessionsView.markRead") : t("sessionsView.markUnread")}</span
          >
        </button>
        <button
          type="button"
          class="sidebar-session-menu__item"
          role="menuitem"
          ?disabled=${!this.connected}
          @click=${() => {
            this.closeSessionMenu();
            this.renameSession(session);
          }}
        >
          <span class="sidebar-session-menu__icon" aria-hidden="true">${icons.edit}</span>
          <span class="sidebar-session-menu__text">${t("sessionsView.renameSessionMenu")}</span>
        </button>
        <button
          type="button"
          class="sidebar-session-menu__item"
          role="menuitem"
          ?disabled=${!this.connected || this.sessionsLoading}
          @click=${() => {
            this.closeSessionMenu();
            void this.forkSession(session);
          }}
        >
          <span class="sidebar-session-menu__icon" aria-hidden="true">${icons.copy}</span>
          <span class="sidebar-session-menu__text">${t("sessionsView.forkSession")}</span>
        </button>
        <div
          class="sidebar-session-menu__submenu-host"
          @pointerenter=${() => {
            this.sessionGroupSubmenuOpen = true;
          }}
          @pointerleave=${() => {
            this.sessionGroupSubmenuOpen = false;
          }}
        >
          <button
            type="button"
            class="sidebar-session-menu__item"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded=${String(this.sessionGroupSubmenuOpen)}
            ?disabled=${!this.connected}
            @click=${() => {
              this.sessionGroupSubmenuOpen = !this.sessionGroupSubmenuOpen;
            }}
          >
            <span class="sidebar-session-menu__icon" aria-hidden="true">${icons.folder}</span>
            <span class="sidebar-session-menu__text">${t("sessionsView.moveToGroupMenu")}</span>
            <span class="sidebar-session-menu__chevron" aria-hidden="true"
              >${icons.chevronRight}</span
            >
          </button>
          ${this.sessionGroupSubmenuOpen
            ? html`
                <div
                  class="sidebar-session-menu sidebar-session-menu__submenu ${menu.submenuLeft
                    ? "sidebar-session-menu__submenu--left"
                    : ""}"
                  role="menu"
                  aria-label=${t("sessionsView.moveToGroupMenu")}
                >
                  ${groups.map(
                    (group) => html`
                      <button
                        type="button"
                        class="sidebar-session-menu__item"
                        role="menuitem"
                        @click=${() => {
                          this.closeSessionMenu();
                          if (session.category !== group) {
                            void this.patchSession(session, { category: group });
                          }
                        }}
                      >
                        <span class="sidebar-session-menu__check" aria-hidden="true"
                          >${session.category === group ? icons.check : nothing}</span
                        >
                        <span class="sidebar-session-menu__text">${group}</span>
                      </button>
                    `,
                  )}
                  <button
                    type="button"
                    class="sidebar-session-menu__item"
                    role="menuitem"
                    @click=${() => {
                      this.closeSessionMenu();
                      this.createSessionGroup(session);
                    }}
                  >
                    <span class="sidebar-session-menu__check" aria-hidden="true"></span>
                    <span class="sidebar-session-menu__text">${t("sessionsView.newGroup")}</span>
                  </button>
                  ${session.category
                    ? html`
                        <div class="sidebar-session-menu__separator" role="separator"></div>
                        <button
                          type="button"
                          class="sidebar-session-menu__item"
                          role="menuitem"
                          @click=${() => {
                            this.closeSessionMenu();
                            void this.patchSession(session, { category: null });
                          }}
                        >
                          <span class="sidebar-session-menu__check" aria-hidden="true"></span>
                          <span class="sidebar-session-menu__text"
                            >${t("sessionsView.removeFromGroup")}</span
                          >
                        </button>
                      `
                    : nothing}
                </div>
              `
            : nothing}
        </div>
        <div class="sidebar-session-menu__separator" role="separator"></div>
        <button
          type="button"
          class="sidebar-session-menu__item"
          role="menuitem"
          ?disabled=${!this.connected || !archiveAllowed}
          @click=${() => {
            this.closeSessionMenu();
            void this.patchSession(session, { archived: true });
          }}
        >
          <span class="sidebar-session-menu__icon" aria-hidden="true">${icons.archive}</span>
          <span class="sidebar-session-menu__text">${t("sessionsView.archiveSession")}</span>
        </button>
        <button
          type="button"
          class="sidebar-session-menu__item sidebar-session-menu__item--destructive"
          role="menuitem"
          ?disabled=${!this.connected || !archiveAllowed || !deleteAllowed}
          @click=${() => {
            this.closeSessionMenu();
            void this.deleteSession(session);
          }}
        >
          <span class="sidebar-session-menu__icon" aria-hidden="true">${icons.trash}</span>
          <span class="sidebar-session-menu__text">${t("sessionsView.deleteSessionMenu")}</span>
        </button>
      </div>
    `;
  }

  private renderSessionGroupMenu() {
    const menu = this.sessionGroupMenu;
    if (!menu) {
      return nothing;
    }
    return html`
      <div
        class="sidebar-session-menu sidebar-session-group-menu"
        role="menu"
        aria-label=${t("sessionsView.groupMenu", { group: menu.group })}
        style="left: ${menu.x}px; top: ${menu.y}px;"
      >
        <button
          type="button"
          class="sidebar-session-menu__item"
          role="menuitem"
          ?disabled=${!this.connected}
          @click=${() => {
            this.closeSessionGroupMenu();
            this.renameSessionGroupFromMenu(menu.group);
          }}
        >
          <span class="sidebar-session-menu__icon" aria-hidden="true">${icons.edit}</span>
          <span class="sidebar-session-menu__text">${t("sessionsView.renameGroupMenu")}</span>
        </button>
        <button
          type="button"
          class="sidebar-session-menu__item"
          role="menuitem"
          @click=${() => {
            this.closeSessionGroupMenu();
            this.createSessionGroup();
          }}
        >
          <span class="sidebar-session-menu__icon" aria-hidden="true">${icons.folder}</span>
          <span class="sidebar-session-menu__text">${t("sessionsView.newGroup")}</span>
        </button>
        <div class="sidebar-session-menu__separator" role="separator"></div>
        <button
          type="button"
          class="sidebar-session-menu__item sidebar-session-menu__item--destructive"
          role="menuitem"
          ?disabled=${!this.connected}
          @click=${() => {
            this.closeSessionGroupMenu();
            this.deleteSessionGroupFromMenu(menu.group);
          }}
        >
          <span class="sidebar-session-menu__icon" aria-hidden="true">${icons.trash}</span>
          <span class="sidebar-session-menu__text">${t("sessionsView.deleteGroupMenu")}</span>
        </button>
      </div>
    `;
  }

  private renderSessionSortMenu() {
    const position = this.sessionSortMenuPosition;
    if (!position) {
      return nothing;
    }
    const groupingOptions = [
      { grouping: "category", label: t("sessionsView.groupByCategory") },
      { grouping: "none", label: t("sessionsView.groupByNone") },
    ] as const satisfies ReadonlyArray<{ grouping: SidebarSessionsGrouping; label: string }>;
    return html`
      <div
        class="sidebar-session-sort-menu"
        role="menu"
        aria-label=${t("chat.sidebar.sortSessions")}
        style="left: ${position.x}px; top: ${position.y}px;"
      >
        <div class="sidebar-session-sort-menu__title">${t("sessionsView.groupBy")}</div>
        ${groupingOptions.map(
          (option) => html`
            <button
              type="button"
              class="sidebar-session-sort-menu__item"
              role="menuitemradio"
              aria-checked=${String(this.sessionsGrouping === option.grouping)}
              @click=${() => {
                this.setSessionsGrouping(option.grouping);
                this.closeSessionSortMenu({ restoreFocus: true });
              }}
            >
              <span class="sidebar-session-menu__check" aria-hidden="true">
                ${this.sessionsGrouping === option.grouping ? icons.check : nothing}
              </span>
              <span class="sidebar-session-menu__text">${option.label}</span>
            </button>
          `,
        )}
        <div class="sidebar-session-menu__separator" role="separator"></div>
        <div class="sidebar-session-sort-menu__title">${t("chat.sidebar.sortBy")}</div>
        ${SIDEBAR_SESSION_SORT_OPTIONS.map(
          (option) => html`
            <button
              type="button"
              class="sidebar-session-sort-menu__item"
              role="menuitemradio"
              aria-checked=${String(this.sessionSortMode === option.mode)}
              @click=${() => {
                this.sessionSortMode = option.mode;
                this.closeSessionSortMenu({ restoreFocus: true });
              }}
            >
              <span class="sidebar-session-menu__check" aria-hidden="true">
                ${this.sessionSortMode === option.mode ? icons.check : nothing}
              </span>
              <span class="sidebar-session-menu__text">${t(option.labelKey)}</span>
            </button>
          `,
        )}
      </div>
    `;
  }

  private renderRoute(routeId: NavigationRouteId) {
    const active =
      routeId === "config"
        ? this.activeRouteId !== undefined && isSettingsNavigationRoute(this.activeRouteId)
        : this.activeRouteId === routeId;
    // Disabled routes (e.g. Workboard with the plugin off) stay hidden rather
    // than rendering an inert nav item.
    if (!this.isRouteEnabled(routeId)) {
      return nothing;
    }
    const routeSessionKey = routeId === "chat" ? this.getRouteSessionKey() : "";
    const href =
      routeSessionKey && routeId === "chat"
        ? `${pathForRoute("chat", this.basePath)}${searchForSession(routeSessionKey)}`
        : pathForRoute(routeId, this.basePath);
    const label = titleForRoute(routeId);
    const link = html`
      <a
        href=${href}
        class="nav-item ${active ? "nav-item--active" : ""}"
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
          this.onNavigate?.(
            routeId,
            routeId === "chat" && routeSessionKey
              ? {
                  search: searchForSession(routeSessionKey),
                }
              : undefined,
          );
        }}
      >
        <span class="nav-item__icon" aria-hidden="true"
          >${icons[navigationIconForRoute(routeId)]}</span
        >
        ${!this.collapsed ? html`<span class="nav-item__text">${label}</span>` : nothing}
      </a>
    `;
    return this.collapsed
      ? html`<openclaw-tooltip .content=${label}>${link}</openclaw-tooltip>`
      : link;
  }

  /** Dynamic plugin tabs stay in More; only stable static route ids can be persisted as pins. */
  private pluginTabs(): GatewayControlUiPluginTab[] {
    const tabs = this.context?.gateway.snapshot.hello?.controlUiTabs ?? [];
    return ["chat", "control", "agent", "settings"].flatMap((group) =>
      tabs.filter((tab) => (tab.group ?? "control") === group),
    );
  }

  private renderPluginTab(tab: GatewayControlUiPluginTab) {
    const ref = { pluginId: tab.pluginId, id: tab.id };
    const search = pluginTabSearch(ref);
    const href = `${pathForRoute("plugin", this.basePath)}${search}`;
    const active = this.activeRouteId === "plugin" && this.activePluginTabId === pluginTabKey(ref);
    const iconName = tab.icon && Object.hasOwn(icons, tab.icon) ? (tab.icon as IconName) : "puzzle";
    const link = html`
      <a
        href=${href}
        class="nav-item ${active ? "nav-item--active" : ""}"
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          this.onNavigate?.("plugin", { search });
        }}
      >
        <span class="nav-item__icon" aria-hidden="true">${icons[iconName]}</span>
        ${!this.collapsed ? html`<span class="nav-item__text">${tab.label}</span>` : nothing}
      </a>
    `;
    return this.collapsed
      ? html`<openclaw-tooltip .content=${tab.label}>${link}</openclaw-tooltip>`
      : link;
  }

  private renderRecentSession(session: SidebarRecentSession) {
    const rowClass = [
      "sidebar-recent-session",
      "session-row-host",
      session.visuallyActive ? "sidebar-recent-session--active" : "",
      session.pinned ? "session-row-host--pinned" : "",
      session.hasActiveRun ? "session-row-host--running" : "",
      this.draggingSessionKey === session.key ? "sidebar-recent-session--dragging" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const row = html`
      <div
        class=${rowClass}
        data-session-key=${session.key}
        draggable="true"
        @dragstart=${(event: DragEvent) => {
          if (event.dataTransfer) {
            writeSessionDragData(event.dataTransfer, session.key);
            this.draggingSessionKey = session.key;
          }
        }}
        @dragend=${() => {
          this.draggingSessionKey = null;
        }}
        @contextmenu=${(event: MouseEvent) => {
          event.preventDefault();
          this.openSessionMenu(session, event.clientX, event.clientY);
        }}
        @mouseenter=${(event: MouseEvent) => startHoverMarquee(event.currentTarget as HTMLElement)}
        @mouseleave=${(event: MouseEvent) => stopHoverMarquee(event.currentTarget as HTMLElement)}
      >
        <a
          href=${session.href}
          class="sidebar-recent-session__link"
          draggable="false"
          title=${`${session.label} · ${session.key}`}
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.selectSession(session.key);
          }}
        >
          ${session.unread
            ? html`<span
                class="session-unread-dot sidebar-recent-session__unread"
                role="img"
                aria-label=${t("sessionsView.unread")}
              ></span>`
            : nothing}
          <span class="sidebar-recent-session__name hover-marquee">${session.label}</span>
        </a>
        <span class="sidebar-recent-session__aside session-row-aside">
          <span class="session-row-trail">
            ${session.hasActiveRun
              ? html`<span
                  class="session-run-spinner"
                  role="img"
                  aria-label=${t("sessionsView.activeRun")}
                  title=${t("sessionsView.activeRun")}
                ></span>`
              : session.meta}
          </span>
          <span class="session-row-actions">
            <button
              class="session-action session-action--pin"
              data-sidebar-session-pin="true"
              type="button"
              title=${session.pinned
                ? t("sessionsView.unpinSession")
                : t("sessionsView.pinSession")}
              aria-label=${session.pinned
                ? t("sessionsView.unpinSession")
                : t("sessionsView.pinSession")}
              ?disabled=${!this.connected}
              @click=${() => void this.patchSession(session, { pinned: !session.pinned })}
            >
              ${icons.pin}
            </button>
            <button
              class="session-action"
              data-sidebar-session-menu="true"
              type="button"
              title=${t("chat.sidebar.openSessionMenu")}
              aria-label=${t("chat.sidebar.openSessionMenu")}
              aria-haspopup="menu"
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                const trigger = event.currentTarget as HTMLElement;
                const rect = trigger.getBoundingClientRect();
                this.openSessionMenu(session, rect.right, rect.bottom + 4, trigger);
              }}
            >
              ${icons.moreHorizontal}
            </button>
          </span>
        </span>
      </div>
    `;
    // Hover marquee state mutates the row DOM. Keying prevents that state from
    // leaking when Lit reuses this slot for another session after navigation.
    return keyed(session.key, row);
  }

  private renderSessions() {
    const context = this.context;
    const {
      routeSessionKey,
      selectedAgentId,
      recentSessions,
      newSessionDisabled,
      newSessionTitle,
    } = this.getSessionNavigationState();
    const workspaceGit =
      context?.agents.state.agentsList?.agents.find(
        (agent) => normalizeAgentId(agent.id) === normalizeAgentId(selectedAgentId),
      )?.workspaceGit === true;
    const newSessionButton = html`
      <button
        type="button"
        class="sidebar-new-session"
        aria-label=${t("chat.runControls.newSession")}
        ?disabled=${newSessionDisabled}
        @click=${() => void this.createSession()}
      >
        <span class="sidebar-new-session__icon" aria-hidden="true">${icons.plus}</span>
        ${this.collapsed
          ? nothing
          : html`<span class="sidebar-new-session__label"
              >${t("chat.runControls.newSession")}</span
            >`}
      </button>
    `;
    const newSessionControl = workspaceGit
      ? html`
          <div class="sidebar-new-session-group">
            ${newSessionButton}
            <button
              type="button"
              class="sidebar-new-session sidebar-new-session--worktree"
              title=${t("chat.runControls.newSessionWorktree")}
              aria-label=${t("chat.runControls.newSessionWorktree")}
              ?disabled=${newSessionDisabled}
              @click=${() => void this.createSession(true)}
            >
              <span class="sidebar-new-session__icon" aria-hidden="true">${icons.gitBranch}</span>
            </button>
          </div>
        `
      : newSessionButton;
    // Stable navigation ordering carries through each pinned/category bucket;
    // selecting a visible row only moves the active highlight.
    const sections = groupSidebarSessionRows(recentSessions, {
      grouping: this.sessionsGrouping,
      // Stored-but-empty groups stay visible as sections so a freshly created
      // group is usable as a move target before its first session arrives.
      knownGroups: this.sessionsGrouping === "category" ? this.knownSessionGroups() : undefined,
    });
    const hasCategorySections = sections.some((section) => section.category !== undefined);
    return html`
      <section class="sidebar-sessions ${this.collapsed ? "sidebar-sessions--collapsed" : ""}">
        ${this.collapsed
          ? html`<openclaw-tooltip .content=${newSessionTitle}
              >${newSessionControl}</openclaw-tooltip
            >`
          : newSessionControl}
        ${this.collapsed
          ? nothing
          : html`
              <div class="sidebar-recent-sessions" aria-label=${titleForRoute("sessions")}>
                ${sections.map((section) => {
                  if (section.id === "pinned" || section.category !== undefined) {
                    const group = section.category;
                    return html`
                      <div class="sidebar-recent-sessions__group">
                        <div
                          class="sidebar-recent-sessions__head"
                          @contextmenu=${group
                            ? (event: MouseEvent) => {
                                event.preventDefault();
                                this.openSessionGroupMenu(
                                  group,
                                  event.clientX,
                                  event.clientY,
                                  null,
                                );
                              }
                            : nothing}
                        >
                          <span class="sidebar-recent-sessions__label-text"
                            >${section.id === "pinned"
                              ? t("sessionsView.pinned")
                              : section.category}</span
                          >
                          ${group
                            ? html`
                                <button
                                  type="button"
                                  class="sidebar-session-group-actions"
                                  title=${t("sessionsView.groupMenu", { group })}
                                  aria-label=${t("sessionsView.groupMenu", { group })}
                                  aria-haspopup="menu"
                                  aria-expanded=${String(this.sessionGroupMenu?.group === group)}
                                  @click=${(event: MouseEvent) => {
                                    event.stopPropagation();
                                    const trigger = event.currentTarget as HTMLElement;
                                    const rect = trigger.getBoundingClientRect();
                                    this.openSessionGroupMenu(
                                      group,
                                      rect.right,
                                      rect.bottom + 4,
                                      trigger,
                                    );
                                  }}
                                >
                                  ${icons.moreHorizontal}
                                </button>
                              `
                            : nothing}
                        </div>
                        <div class="sidebar-recent-sessions__list">
                          ${section.rows.map((session) => this.renderRecentSession(session))}
                        </div>
                      </div>
                    `;
                  }
                  return html`
                    <div class="sidebar-recent-sessions__group">
                      <div class="sidebar-recent-sessions__head">
                        <span class="sidebar-recent-sessions__label-text"
                          >${hasCategorySections && section.rows.length > 0
                            ? t("sessionsView.ungrouped")
                            : t("sessionsView.title")}</span
                        >
                        ${this.renderAgentScope(routeSessionKey, selectedAgentId)}
                        <button
                          type="button"
                          class="sidebar-session-sort"
                          title=${t("chat.sidebar.sortSessions")}
                          aria-label=${t("chat.sidebar.sortSessions")}
                          aria-haspopup="menu"
                          aria-expanded=${String(this.sessionSortMenuPosition !== null)}
                          @click=${(event: MouseEvent) => {
                            const trigger = event.currentTarget as HTMLElement;
                            const rect = trigger.getBoundingClientRect();
                            this.openSessionSortMenu(rect.right, rect.bottom + 4, trigger);
                          }}
                        >
                          ${icons.listFilter}
                        </button>
                      </div>
                      <div class="sidebar-recent-sessions__list">
                        ${recentSessions.length === 0
                          ? this.renderChatFallback()
                          : section.rows.map((session) => this.renderRecentSession(session))}
                      </div>
                      <a
                        href=${pathForRoute("sessions", this.basePath)}
                        class="sidebar-recent-sessions__all"
                        @click=${(event: MouseEvent) => {
                          if (!shouldHandleNavigationClick(event)) {
                            return;
                          }
                          event.preventDefault();
                          this.onNavigate?.("sessions");
                        }}
                      >
                        <span>${t("chat.sidebar.allSessions")}</span>
                        <span class="sidebar-recent-sessions__all-icon" aria-hidden="true"
                          >${icons.chevronRight}</span
                        >
                      </a>
                    </div>
                  `;
                })}
              </div>
            `}
      </section>
    `;
  }

  /** Compact agent scope switcher for the ungrouped session header. */
  private renderAgentScope(sessionKey: string, selectedAgentId: string) {
    const options = resolveSessionAgentFilterOptions({
      agentsList: this.context?.agents.state.agentsList,
      sessionsResult: this.sessionsResult,
      sessionKey,
    });
    if (options.length <= 1) {
      return nothing;
    }
    const selectedLabel =
      options.find((option) => option.id === selectedAgentId)?.label ?? selectedAgentId;
    return html`
      <label class="sidebar-agent-scope" title=${selectedLabel}>
        <select
          data-chat-agent-filter="true"
          aria-label=${t("chat.selectors.agentFilter")}
          .value=${selectedAgentId}
          ?disabled=${!this.connected}
          @change=${(event: Event) => this.selectAgent((event.target as HTMLSelectElement).value)}
        >
          ${options.map(
            (option) =>
              html`<option value=${option.id} ?selected=${option.id === selectedAgentId}>
                ${option.label}
              </option>`,
          )}
        </select>
        <span class="sidebar-agent-scope__chevron" aria-hidden="true">${icons.chevronDown}</span>
      </label>
    `;
  }

  /** Command palette entry point; the palette itself is owned by the shell. */
  private renderSearch() {
    const tooltip = `${t("chat.openCommandPalette")} (${PALETTE_SHORTCUT})`;
    return html`
      <openclaw-tooltip .content=${tooltip}>
        <button
          type="button"
          class="sidebar-brand__icon sidebar-search"
          ?disabled=${!this.onOpenPalette}
          aria-label=${t("chat.openCommandPalette")}
          @click=${() => this.onOpenPalette?.()}
        >
          ${icons.search}
        </button>
      </openclaw-tooltip>
    `;
  }

  private renderMoreSection() {
    if (this.collapsed) {
      return nothing;
    }
    const moreRoutes = sidebarMoreRoutes(this.sidebarPinnedRoutes);
    const expanded = this.sidebarMoreExpanded;
    return html`
      <section class="nav-section nav-section--more ${expanded ? "" : "nav-section--collapsed"}">
        <button
          class="nav-section__label"
          @click=${() => this.onToggleMore?.()}
          aria-expanded=${String(expanded)}
        >
          <span class="nav-section__label-text">${t("nav.more")}</span>
          <span class="nav-section__chevron"> ${icons.chevronDown} </span>
        </button>
        <div class="nav-section__items">
          ${moreRoutes.map((routeId) => this.renderRoute(routeId))}
          ${this.pluginTabs().map((tab) => this.renderPluginTab(tab))}
          <button
            type="button"
            class="nav-item nav-item--action"
            @click=${(event: MouseEvent) => {
              const trigger = event.currentTarget as HTMLElement;
              const rect = trigger.getBoundingClientRect();
              this.openCustomizeMenu(rect.left, rect.bottom + 4, trigger);
            }}
          >
            <span class="nav-item__icon" aria-hidden="true">${icons.penLine}</span>
            <span class="nav-item__text">${t("nav.customize")}</span>
          </button>
        </div>
      </section>
    `;
  }

  private renderChatFallback() {
    return html`
      <a
        href=${pathForRoute("chat", this.basePath)}
        class="sidebar-recent-session ${this.activeRouteId === "chat"
          ? "sidebar-recent-session--active"
          : ""}"
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          this.onNavigate?.("chat");
        }}
      >
        <span class="sidebar-recent-session__body">
          <span class="sidebar-recent-session__name">${t("nav.chat")}</span>
        </span>
      </a>
    `;
  }

  override render() {
    const gatewayStatus = t("chat.gatewayStatus", {
      status: this.connected ? t("common.online") : t("common.offline"),
    });
    const settingsActive =
      this.activeRouteId !== undefined && isSettingsNavigationRoute(this.activeRouteId);
    const settingsEnabled = this.isRouteEnabled("config");
    return html`
      <aside class="sidebar ${this.collapsed ? "sidebar--collapsed" : ""}">
        <!-- macOS app only (CSS-gated on html.openclaw-native-macos): use the
             otherwise-empty native titlebar strip instead of a sidebar row. -->
        <img
          class="sidebar-native-brand"
          src="${controlUiPublicAssetPath("favicon.svg", this.basePath)}"
          alt="OpenClaw"
        />
        <div class="sidebar-shell">
          ${this.renderBrand()}
          <div class="sidebar-shell__body">
            <nav class="sidebar-nav" @contextmenu=${this.openCustomizeMenuFromContext}>
              ${this.collapsed ? this.renderRoute("chat") : nothing}
              <div class="nav-section__items">
                ${this.sidebarPinnedRoutes.map((routeId) => this.renderRoute(routeId))}
              </div>
              ${this.renderMoreSection()}
            </nav>
            ${this.renderSessions()}
          </div>
          <div class="sidebar-shell__footer">
            <div class="sidebar-footer-bar">
              <openclaw-tooltip .content=${gatewayStatus}>
                <span
                  class="sidebar-status__dot ${this.connected
                    ? "sidebar-connection-status--online"
                    : "sidebar-connection-status--offline"}"
                  role="img"
                  aria-live="polite"
                  aria-label=${gatewayStatus}
                ></span>
              </openclaw-tooltip>
              <span class="sidebar-footer-bar__spacer"></span>
              ${settingsEnabled
                ? html`
                    <openclaw-tooltip .content=${titleForRoute("config")}>
                      <a
                        href=${pathForRoute("config", this.basePath)}
                        class="sidebar-footer-icon ${settingsActive
                          ? "sidebar-footer-icon--active"
                          : ""}"
                        aria-label=${titleForRoute("config")}
                        aria-current=${settingsActive ? "page" : nothing}
                        @focus=${(event: Event) => this.preloadRoute("config", event)}
                        @blur=${this.cancelPreload}
                        @pointerenter=${(event: Event) => this.preloadRoute("config", event)}
                        @pointerleave=${this.cancelPreload}
                        @touchstart=${(event: TouchEvent) =>
                          this.preloadRoute("config", event, true)}
                        @click=${(event: MouseEvent) => {
                          if (!shouldHandleNavigationClick(event)) {
                            return;
                          }
                          event.preventDefault();
                          this.onNavigate?.("config");
                        }}
                      >
                        ${icons.settings}
                      </a>
                    </openclaw-tooltip>
                  `
                : nothing}
              <openclaw-tooltip
                .content=${t("chat.docsOpensInNewTab", { label: t("common.docs") })}
              >
                <a
                  class="sidebar-footer-icon"
                  href="https://docs.openclaw.ai"
                  target=${EXTERNAL_LINK_TARGET}
                  rel=${buildExternalLinkRel()}
                  aria-label=${t("common.docs")}
                >
                  ${icons.book}
                </a>
              </openclaw-tooltip>
              <openclaw-tooltip
                .content=${this.canPairDevice
                  ? t("nodes.pairing.button")
                  : t("nodes.pairing.adminRequired")}
              >
                <button
                  class="sidebar-footer-icon sidebar-pair-mobile"
                  type="button"
                  aria-label=${t("nodes.pairing.button")}
                  ?disabled=${!this.canPairDevice}
                  @click=${() => this.onPairMobile?.()}
                >
                  ${icons.smartphone}
                </button>
              </openclaw-tooltip>
              <span class="sidebar-mode-switch">
                <openclaw-theme-mode-toggle .mode=${this.themeMode}></openclaw-theme-mode-toggle>
              </span>
            </div>
          </div>
        </div>
        ${this.renderCustomizeMenu()} ${this.renderSessionMenu()} ${this.renderSessionGroupMenu()}
        ${this.renderSessionSortMenu()}
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-app-sidebar")) {
  customElements.define("openclaw-app-sidebar", AppSidebar);
}
