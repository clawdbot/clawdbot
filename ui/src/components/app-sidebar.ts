import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import {
  cancelRoutePreload,
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  isSettingsNavigationRoute,
  navigationIconForRoute,
  orderedControlUiPluginTabs,
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
import "./session-menu.ts";
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
  reorderSessionCustomGroups,
  renameSessionGroup,
  saveStoredSessionCustomGroups,
} from "../lib/sessions/custom-groups.ts";
import {
  readSessionDragData,
  readSessionGroupDragData,
  sessionDragActive,
  sessionGroupDragActive,
  writeSessionDragData,
  writeSessionGroupDragData,
} from "../lib/sessions/drag.ts";
import {
  groupSidebarSessionRows,
  normalizeSidebarSessionsGrouping,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import {
  compareSessionRowsByUpdatedAt,
  resolveSessionNavigation,
  searchForSession,
  type SessionCapability,
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
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { pluginTabKey, pluginTabSearch } from "../pages/plugin/route.ts";
import { icons, type IconName } from "./icons.ts";
import { lobsterPetSeed, resolveLobsterPetMode, resolveLobsterRunOutcome } from "./lobster-pet.ts";
import type { SessionMenuAction } from "./session-menu.ts";

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
};

type SidebarSessionGroupMenuState = {
  group: string;
  x: number;
  y: number;
};

type SidebarSessionSortMode = "created" | "updated";
type SidebarSessionGroupDropTarget = {
  group: string;
  position: "before" | "after";
};

const SIDEBAR_SESSION_GROUPING_STORAGE_KEY = "openclaw:sidebar:sessions:grouping";
const SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY =
  "openclaw:sidebar:sessions:collapsed-sections";

function loadStoredSidebarSessionsGrouping(): SidebarSessionsGrouping {
  return normalizeSidebarSessionsGrouping(
    getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_GROUPING_STORAGE_KEY),
  );
}

function loadStoredCollapsedSessionSections(): ReadonlySet<string> {
  try {
    const raw = getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.flatMap((value) => (typeof value === "string" && value ? [value] : []))
        : [],
    );
  } catch {
    return new Set();
  }
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

class AppSidebar extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) activePluginTabId = "";
  @property({ attribute: false }) enabledRouteIds?: readonly NavigationRouteId[];
  /** "panel" (desktop): sessions-only column below the topbar, which owns nav.
   * "drawer" (narrow viewports): full nav + sessions + footer slide-over. */
  @property({ attribute: false }) variant: "panel" | "drawer" = "panel";
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) canPairDevice = false;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) sidebarPinnedRoutes: readonly SidebarNavRoute[] =
    DEFAULT_SIDEBAR_PINNED_ROUTES;
  @property({ attribute: false }) sidebarMoreExpanded = false;
  @property({ attribute: false }) themeMode: ThemeMode = "system";
  @property({ attribute: false }) lobsterPetVisits = true;
  @property({ attribute: false }) onToggleMore?: () => void;
  @property({ attribute: false }) onUpdatePinnedRoutes?: (routes: SidebarNavRoute[]) => void;
  @property({ attribute: false }) onPairMobile?: () => void;
  @property({ attribute: false })
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  @property({ attribute: false }) onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext<RouteId>;
  @state() private customizeMenuPosition: { x: number; y: number } | null = null;
  @state() private sessionMenu: SidebarSessionMenuState | null = null;
  @state() private sessionGroupMenu: SidebarSessionGroupMenuState | null = null;
  @state() private draggingSessionKey: string | null = null;
  @state() private draggingSessionGroup: string | null = null;
  @state() private sessionDropTarget: string | null = null;
  @state() private sessionGroupDropTarget: SidebarSessionGroupDropTarget | null = null;
  @state() private collapsedSessionSections = loadStoredCollapsedSessionSections();
  @state() private sessionSortMode: SidebarSessionSortMode = "created";
  @state() private sessionsGrouping: SidebarSessionsGrouping = loadStoredSidebarSessionsGrouping();
  @state() private sessionSortMenuPosition: { x: number; y: number } | null = null;
  @state() private sessionsResult: SessionsListResult | null = null;
  @state() private sessionsAgentId: string | null = null;
  @state() private sessionsLoading = false;

  private readonly subscriptions = new SubscriptionsController(this);
  private customizeMenuTrigger: HTMLElement | null = null;
  private sessionMenuTrigger: HTMLElement | null = null;
  private sessionGroupMenuTrigger: HTMLElement | null = null;
  private sessionSortMenuTrigger: HTMLElement | null = null;
  private sessionRowsByAgent: Record<string, SessionsListResult["sessions"]> = {};
  private sessionCreatedOrder = new Map<string, number>();
  private sessionsSource: SessionCapability | null = null;
  private reconnectListRevision: number | null = null;
  private gatewaySource: ApplicationContext<RouteId>["gateway"] | null = null;
  private gatewayClient: GatewayBrowserClient | null = null;
  private readonly routePreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();

  constructor() {
    super();
    this.subscriptions
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeGateway(gateway),
      )
      .watch(
        () => this.context?.sessions,
        (sessions, notify) => sessions.subscribe(notify),
        (sessions) => this.synchronizeSessions(sessions),
      )
      .effect(
        () => this.context?.sessions,
        (sessions) => sessions.subscribeCreated((key) => this.promoteCreatedSession(key)),
      )
      .watch(
        () => this.context?.agents,
        (agents, notify) => agents.subscribe(notify),
      )
      .watch(
        () => this.context?.agentSelection,
        (agentSelection, notify) => agentSelection.subscribe(notify),
      );
  }

  override disconnectedCallback() {
    this.closeCustomizeMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.gatewaySource = null;
    this.gatewayClient = null;
    for (const timer of this.routePreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.routePreloadTimers.clear();
    super.disconnectedCallback();
  }

  private readonly updateSessions = (sessions: SessionCapability) => {
    const snapshot = sessions.state;
    const gateway = this.context?.gateway;
    const sameClientDisconnected =
      gateway !== undefined &&
      gateway === this.gatewaySource &&
      gateway.snapshot.client !== null &&
      gateway.snapshot.client === this.gatewayClient &&
      !gateway.snapshot.connected;
    if (sameClientDisconnected && this.reconnectListRevision === null) {
      this.reconnectListRevision = sessions.canonicalListRevision + 1;
    }
    const waitingForReconnectList =
      this.reconnectListRevision !== null &&
      sessions.canonicalListRevision < this.reconnectListRevision;
    if (!sameClientDisconnected && !waitingForReconnectList) {
      // Keep the result and agent scope paired until the first canonical list
      // after reconnect; chat startup may publish a partial reconciliation first.
      this.reconnectListRevision = null;
      this.sessionsResult = snapshot.result;
      this.sessionsAgentId = snapshot.agentId;
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
    }
    this.sessionsLoading = snapshot.loading;
  };

  private synchronizeSessions(sessions: SessionCapability) {
    if (sessions !== this.sessionsSource) {
      this.clearSessionCache();
      this.sessionsSource = sessions;
    }
    this.updateSessions(sessions);
  }

  private synchronizeGateway(gateway: ApplicationContext<RouteId>["gateway"]) {
    const client = gateway.snapshot.client;
    if (gateway === this.gatewaySource && client === this.gatewayClient) {
      return;
    }
    this.clearSessionCache();
    this.gatewaySource = gateway;
    this.gatewayClient = client;
  }

  private clearSessionCache() {
    this.reconnectListRevision = null;
    this.sessionsResult = null;
    this.sessionsAgentId = null;
    this.sessionRowsByAgent = {};
    this.sessionCreatedOrder.clear();
  }

  private renderBrand() {
    return html`
      <div class="sidebar-brand">
        <div class="sidebar-brand__identity">
          <img
            class="sidebar-brand__logo"
            src=${controlUiPublicAssetPath("apple-touch-icon.png", this.basePath)}
            alt=""
            aria-hidden="true"
          />
          <span class="sidebar-brand__title">OpenClaw</span>
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
    const visibleSessions = navigation.visibleSessions.map(toSidebarSession);
    const newSessionDisabled =
      !this.connected || this.sessionsLoading || Boolean(navigation.selectedSession?.hasActiveRun);
    return {
      routeSessionKey: navigation.currentSessionKey,
      selectedAgentId: navigation.selectedAgentId,
      visibleSessions,
      newSessionDisabled,
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
    this.closeCustomizeMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.sessionMenuTrigger = trigger;
    this.sessionMenu = { session, x, y };
  }

  private closeSessionMenu() {
    this.sessionMenuTrigger = null;
    this.sessionMenu = null;
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
      this.querySelector<HTMLElement>(".sidebar-session-group-menu .session-menu__item")?.focus();
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

  private toggleSessionSortMenu(trigger: HTMLElement) {
    if (this.sessionSortMenuPosition) {
      this.closeSessionSortMenu();
      return;
    }
    const menuWidth = 200;
    const menuMaxHeight = 280;
    const rect = trigger.getBoundingClientRect();
    this.closeCustomizeMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.sessionSortMenuTrigger = trigger;
    this.sessionSortMenuPosition = {
      x: Math.max(8, Math.min(rect.right, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuMaxHeight - 8)),
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
    const stored = loadStoredSessionCustomGroups();
    const storedSet = new Set(stored);
    const discovered = (this.sessionsResult?.sessions ?? [])
      .map((row) => normalizeOptionalString(row.category))
      .filter((name): name is string => typeof name === "string" && !storedSet.has(name))
      .toSorted((a, b) => a.localeCompare(b));
    return [...stored, ...new Set(discovered)];
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
    // Seed browser-local order with server-discovered groups so rename replaces
    // the existing slot instead of promoting the renamed group to the front.
    saveStoredSessionCustomGroups(this.knownSessionGroups());
    void renameSessionGroup(context.sessions, group, next).finally(() => {
      const from = `category:${group}`;
      if (this.collapsedSessionSections.has(from)) {
        const collapsed = new Set(this.collapsedSessionSections);
        collapsed.delete(from);
        collapsed.add(`category:${next}`);
        this.saveCollapsedSessionSections(collapsed);
      }
      this.requestUpdate();
    });
  }

  private deleteSessionGroupFromMenu(group: string) {
    const context = this.context;
    if (!context || !this.connected) {
      return;
    }
    if (!window.confirm(t("sessionsView.deleteGroupConfirm", { group }))) {
      return;
    }
    void dissolveSessionGroup(context.sessions, group).finally(() => {
      const collapsed = new Set(this.collapsedSessionSections);
      collapsed.delete(`category:${group}`);
      this.saveCollapsedSessionSections(collapsed);
      this.requestUpdate();
    });
  }

  private saveCollapsedSessionSections(sections: ReadonlySet<string>) {
    this.collapsedSessionSections = new Set(sections);
    try {
      getSafeLocalStorage()?.setItem(
        SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY,
        JSON.stringify([...sections]),
      );
    } catch {
      // Group membership and ordering remain usable without local persistence.
    }
  }

  private toggleSessionSection(sectionId: string) {
    const collapsed = new Set(this.collapsedSessionSections);
    if (collapsed.has(sectionId)) {
      collapsed.delete(sectionId);
    } else {
      collapsed.add(sectionId);
    }
    this.saveCollapsedSessionSections(collapsed);
  }

  private reorderSessionGroup(source: string, target: string, position: "before" | "after") {
    const groups = reorderSessionCustomGroups(this.knownSessionGroups(), source, target, position);
    saveStoredSessionCustomGroups(groups);
    this.requestUpdate();
  }

  private handleSessionSectionDragOver(event: DragEvent, sectionId: string, category?: string) {
    const dataTransfer = event.dataTransfer;
    if (
      category &&
      sessionGroupDragActive(dataTransfer) &&
      this.draggingSessionGroup !== category
    ) {
      event.preventDefault();
      if (dataTransfer) {
        dataTransfer.dropEffect = "move";
      }
      const target = event.currentTarget as HTMLElement;
      const bounds = target.getBoundingClientRect();
      const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      this.sessionGroupDropTarget = { group: category, position };
      this.sessionDropTarget = null;
      return;
    }
    if (!sessionDragActive(dataTransfer) || sectionId === "pinned") {
      return;
    }
    event.preventDefault();
    if (dataTransfer) {
      dataTransfer.dropEffect = "move";
    }
    this.sessionDropTarget = sectionId;
    this.sessionGroupDropTarget = null;
  }

  private handleSessionSectionDragLeave(event: DragEvent, sectionId: string, category?: string) {
    const current = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
      return;
    }
    if (this.sessionDropTarget === sectionId) {
      this.sessionDropTarget = null;
    }
    if (category && this.sessionGroupDropTarget?.group === category) {
      this.sessionGroupDropTarget = null;
    }
  }

  private handleSessionSectionDrop(event: DragEvent, category?: string) {
    event.preventDefault();
    const sourceGroup = readSessionGroupDragData(event.dataTransfer);
    if (sourceGroup && category && sourceGroup !== category) {
      const position =
        this.sessionGroupDropTarget?.group === category
          ? this.sessionGroupDropTarget.position
          : "before";
      this.reorderSessionGroup(sourceGroup, category, position);
    } else {
      const sessionKey = readSessionDragData(event.dataTransfer);
      const session = this.getSessionNavigationState().visibleSessions.find(
        (candidate) => candidate.key === sessionKey,
      );
      const nextCategory = category ?? null;
      if (session && (session.category !== nextCategory || session.pinned)) {
        if (category) {
          this.rememberSessionGroup(category);
        }
        void this.patchSession(session, {
          category: nextCategory,
          ...(session.pinned ? { pinned: false } : {}),
        });
      }
    }
    this.draggingSessionKey = null;
    this.draggingSessionGroup = null;
    this.sessionDropTarget = null;
    this.sessionGroupDropTarget = null;
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
    if (!window.confirm(t("sessionsView.deleteSessionConfirm", { session: session.label }))) {
      return;
    }
    const context = this.context;
    if (!context) {
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
    if (this.sessionSortMenuTrigger && path.includes(this.sessionSortMenuTrigger)) {
      return;
    }
    const menu = this.querySelector(
      ".sidebar-customize-menu, .sidebar-session-group-menu, .sidebar-session-sort-menu",
    );
    if (menu && path.includes(menu)) {
      return;
    }
    this.closeCustomizeMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.closeCustomizeMenu({ restoreFocus: true });
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
    const archiveAllowed = canArchiveSessionRow(
      session,
      resolveUiConfiguredMainKey({
        agentsList: context?.agents.state.agentsList,
        hello: context?.gateway.snapshot.hello,
      }),
    );
    return html`
      <openclaw-session-menu
        .session=${{
          key: session.key,
          label: session.label,
          pinned: session.pinned,
          unread: session.unread,
          archived: false,
          category: session.category ?? null,
        }}
        .x=${menu.x}
        .y=${menu.y}
        .trigger=${this.sessionMenuTrigger}
        .disabled=${!this.connected}
        .forkDisabled=${this.sessionsLoading}
        .archiveAllowed=${archiveAllowed}
        .groups=${this.knownSessionGroups()}
        .canOpenChat=${true}
        .workboard=${null}
        .onClose=${() => this.closeSessionMenu()}
        .onAction=${(action: SessionMenuAction) => {
          switch (action.kind) {
            case "open-chat":
              this.selectSession(session.key);
              break;
            case "toggle-pin":
              void this.patchSession(session, { pinned: !session.pinned });
              break;
            case "toggle-unread":
              void this.patchSession(session, { unread: !session.unread });
              break;
            case "rename":
              this.renameSession(session);
              break;
            case "fork":
              void this.forkSession(session);
              break;
            case "workboard":
              break;
            case "move-to-group":
              if (action.category === null || session.category !== action.category) {
                void this.patchSession(session, { category: action.category });
              }
              break;
            case "new-group":
              this.createSessionGroup(session);
              break;
            case "toggle-archived":
              void this.patchSession(session, { archived: true });
              break;
            case "delete":
              void this.deleteSession(session);
              break;
          }
        }}
      ></openclaw-session-menu>
    `;
  }

  private renderSessionGroupMenu() {
    const menu = this.sessionGroupMenu;
    if (!menu) {
      return nothing;
    }
    return html`
      <div
        class="session-menu sidebar-session-group-menu"
        role="menu"
        aria-label=${t("sessionsView.groupMenu", { group: menu.group })}
        style="left: ${menu.x}px; top: ${menu.y}px;"
      >
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          ?disabled=${!this.connected}
          @click=${() => {
            this.closeSessionGroupMenu();
            this.renameSessionGroupFromMenu(menu.group);
          }}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.edit}</span>
          <span class="session-menu__text">${t("sessionsView.renameGroupMenu")}</span>
        </button>
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          @click=${() => {
            this.closeSessionGroupMenu();
            this.createSessionGroup();
          }}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.folder}</span>
          <span class="session-menu__text">${t("sessionsView.newGroup")}</span>
        </button>
        <div class="session-menu__separator" role="separator"></div>
        <button
          type="button"
          class="session-menu__item session-menu__item--destructive"
          role="menuitem"
          ?disabled=${!this.connected}
          @click=${() => {
            this.closeSessionGroupMenu();
            this.deleteSessionGroupFromMenu(menu.group);
          }}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.trash}</span>
          <span class="session-menu__text">${t("sessionsView.deleteGroupMenu")}</span>
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
              <span class="session-menu__check" aria-hidden="true">
                ${this.sessionsGrouping === option.grouping ? icons.check : nothing}
              </span>
              <span class="session-menu__text">${option.label}</span>
            </button>
          `,
        )}
        <div class="session-menu__separator" role="separator"></div>
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
              <span class="session-menu__check" aria-hidden="true">
                ${this.sessionSortMode === option.mode ? icons.check : nothing}
              </span>
              <span class="session-menu__text">${t(option.labelKey)}</span>
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
    return html`
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
        <span class="nav-item__text">${label}</span>
      </a>
    `;
  }

  private pluginTabs(): GatewayControlUiPluginTab[] {
    return orderedControlUiPluginTabs(this.context?.gateway.snapshot.hello?.controlUiTabs ?? []);
  }

  private renderPluginTab(tab: GatewayControlUiPluginTab) {
    const ref = { pluginId: tab.pluginId, id: tab.id };
    const search = pluginTabSearch(ref);
    const href = `${pathForRoute("plugin", this.basePath)}${search}`;
    const active = this.activeRouteId === "plugin" && this.activePluginTabId === pluginTabKey(ref);
    const iconName = tab.icon && Object.hasOwn(icons, tab.icon) ? (tab.icon as IconName) : "puzzle";
    return html`
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
        <span class="nav-item__text">${tab.label}</span>
      </a>
    `;
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
          this.sessionDropTarget = null;
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
              data-session-menu="true"
              type="button"
              title=${t("chat.sidebar.openSessionMenu")}
              aria-label=${t("chat.sidebar.openSessionMenu")}
              aria-haspopup="menu"
              aria-expanded=${String(this.sessionMenu?.session.key === session.key)}
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                if (this.sessionMenu?.session.key === session.key) {
                  this.closeSessionMenu();
                  return;
                }
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

  private renderSessionSection(
    section: {
      id: string;
      category?: string;
      rows: SidebarRecentSession[];
    },
    showFallback = false,
  ) {
    const group = section.category;
    const isPinned = section.id === "pinned";
    const showHeader = isPinned || this.sessionsGrouping === "category";
    const collapsed = showHeader && this.collapsedSessionSections.has(section.id);
    const label = isPinned ? t("sessionsView.pinned") : group ? group : t("sessionsView.ungrouped");
    const acceptsSessions = !isPinned && this.sessionsGrouping === "category";
    const sectionClass = [
      "sidebar-recent-sessions__group",
      collapsed ? "sidebar-recent-sessions__group--collapsed" : "",
      this.sessionDropTarget === section.id ? "sidebar-recent-sessions__group--session-drop" : "",
      group && this.sessionGroupDropTarget?.group === group
        ? `sidebar-recent-sessions__group--group-drop-${this.sessionGroupDropTarget.position}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`
      <div
        class=${sectionClass}
        data-session-section=${section.id}
        @dragover=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDragOver(event, section.id, group)
          : nothing}
        @dragleave=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDragLeave(event, section.id, group)
          : nothing}
        @drop=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDrop(event, group)
          : nothing}
      >
        ${showHeader
          ? html`
              <div
                class="sidebar-recent-sessions__head"
                @contextmenu=${group
                  ? (event: MouseEvent) => {
                      event.preventDefault();
                      this.openSessionGroupMenu(group, event.clientX, event.clientY, null);
                    }
                  : nothing}
              >
                ${group
                  ? html`
                      <span
                        class="sidebar-session-group-drag-handle"
                        draggable="true"
                        aria-hidden="true"
                        @dragstart=${(event: DragEvent) => {
                          if (event.dataTransfer) {
                            writeSessionGroupDragData(event.dataTransfer, group);
                            this.draggingSessionGroup = group;
                          }
                        }}
                        @dragend=${() => {
                          this.draggingSessionGroup = null;
                          this.sessionGroupDropTarget = null;
                        }}
                      ></span>
                    `
                  : nothing}
                <button
                  type="button"
                  class="sidebar-session-group-toggle"
                  aria-expanded=${String(!collapsed)}
                  aria-label=${label}
                  @click=${() => this.toggleSessionSection(section.id)}
                >
                  <span class="sidebar-session-group-toggle__icon" aria-hidden="true"
                    >${collapsed ? icons.chevronRight : icons.chevronDown}</span
                  >
                  <span class="sidebar-recent-sessions__label-text">${label}</span>
                  <span class="sidebar-session-group-count">${section.rows.length}</span>
                </button>
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
                          this.openSessionGroupMenu(group, rect.right, rect.bottom + 4, trigger);
                        }}
                      >
                        ${icons.moreHorizontal}
                      </button>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        ${collapsed
          ? nothing
          : html`
              <div class="sidebar-recent-sessions__list">
                ${showFallback
                  ? this.renderChatFallback()
                  : section.rows.map((session) => this.renderRecentSession(session))}
              </div>
            `}
      </div>
    `;
  }

  private renderSessions() {
    const context = this.context;
    const { routeSessionKey, selectedAgentId, visibleSessions, newSessionDisabled } =
      this.getSessionNavigationState();
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
        <span class="sidebar-new-session__label">${t("chat.runControls.newSession")}</span>
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
    const sections = groupSidebarSessionRows(visibleSessions, {
      grouping: this.sessionsGrouping,
      // Stored-but-empty groups stay visible as sections so a freshly created
      // group is usable as a move target before its first session arrives.
      knownGroups: this.sessionsGrouping === "category" ? this.knownSessionGroups() : undefined,
    });
    return html`
      <section class="sidebar-sessions">
        ${newSessionControl}
        <div class="sidebar-recent-sessions" aria-label=${titleForRoute("sessions")}>
          <div class="sidebar-recent-sessions__head sidebar-recent-sessions__head--root">
            <span class="sidebar-recent-sessions__label-text">${t("sessionsView.title")}</span>
            ${this.renderAgentScope(routeSessionKey, selectedAgentId)}
            ${this.sessionsGrouping === "category"
              ? html`
                  <button
                    type="button"
                    class="sidebar-session-sort"
                    title=${t("sessionsView.newGroup")}
                    aria-label=${t("sessionsView.newGroup")}
                    ?disabled=${!this.connected}
                    @click=${() => this.createSessionGroup()}
                  >
                    ${icons.plus}
                  </button>
                `
              : nothing}
            <button
              type="button"
              class="sidebar-session-sort"
              title=${t("chat.sidebar.sortSessions")}
              aria-label=${t("chat.sidebar.sortSessions")}
              aria-haspopup="menu"
              aria-expanded=${String(this.sessionSortMenuPosition !== null)}
              @click=${(event: MouseEvent) => {
                const trigger = event.currentTarget as HTMLElement;
                this.toggleSessionSortMenu(trigger);
              }}
            >
              ${icons.listFilter}
            </button>
          </div>
          ${sections.map((section) =>
            this.renderSessionSection(
              section,
              visibleSessions.length === 0 && section.id === "ungrouped",
            ),
          )}
        </div>
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

  private renderMoreSection() {
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
    // Desktop sessions panel: the topbar owns brand, navigation, and global
    // actions, so the panel is just the session list plus the resident pet.
    // Its container deliberately avoids the .sidebar-shell class: the Mac app
    // injects titlebar padding onto .sidebar-shell for the drawer, which must
    // not leak into the panel that already sits below the topbar.
    if (this.variant === "panel") {
      return html`
        <aside class="sidebar sidebar--panel">
          <div class="sidebar-panel">
            ${this.renderSessions()}
            <div class="sidebar-panel__footer">
              <openclaw-lobster-pet
                .seed=${lobsterPetSeed(this.sessionKey)}
                .mode=${resolveLobsterPetMode(this.connected, this.sessionsResult?.sessions)}
                .visitsEnabled=${this.lobsterPetVisits}
              ></openclaw-lobster-pet>
            </div>
          </div>
          ${this.renderCustomizeMenu()} ${this.renderSessionMenu()} ${this.renderSessionGroupMenu()}
          ${this.renderSessionSortMenu()}
        </aside>
      `;
    }
    const gatewayStatus = t("chat.gatewayStatus", {
      status: this.connected ? t("common.online") : t("common.offline"),
    });
    const settingsActive =
      this.activeRouteId !== undefined && isSettingsNavigationRoute(this.activeRouteId);
    return html`
      <aside class="sidebar">
        <div class="sidebar-shell">
          ${this.renderBrand()}
          <div class="sidebar-shell__body">
            <nav class="sidebar-nav" @contextmenu=${this.openCustomizeMenuFromContext}>
              <div class="nav-section__items">
                ${this.sidebarPinnedRoutes.map((routeId) => this.renderRoute(routeId))}
              </div>
              ${this.renderMoreSection()}
            </nav>
            ${this.renderSessions()}
          </div>
          <div class="sidebar-shell__footer">
            <openclaw-lobster-pet
              .seed=${lobsterPetSeed(this.sessionKey)}
              .mode=${resolveLobsterPetMode(this.connected, this.sessionsResult?.sessions)}
              .runOutcome=${resolveLobsterRunOutcome(this.sessionsResult?.sessions)}
              .visitsEnabled=${this.lobsterPetVisits}
            ></openclaw-lobster-pet>
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
              <openclaw-tooltip .content=${titleForRoute("config")}>
                <a
                  href=${pathForRoute("config", this.basePath)}
                  class="sidebar-footer-icon ${settingsActive ? "sidebar-footer-icon--active" : ""}"
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
                    this.onNavigate?.("config");
                  }}
                >
                  ${icons.settings}
                </a>
              </openclaw-tooltip>
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
