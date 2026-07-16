import { state } from "lit/decorators.js";
import type { SessionsListResult } from "../api/types.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import {
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkSubtitle,
} from "../lib/session-display.ts";
import { groupSidebarSessionRows, type SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import {
  compareSessionRowsByUpdatedAt,
  filterVisibleSessionRows,
  resolveSessionNavigation,
  searchForSession,
} from "../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import {
  adoptedCatalogSessionKeys,
  formatSidebarTimestamp,
} from "./app-sidebar-session-catalogs.ts";
import { AppSidebarSessionDataElement } from "./app-sidebar-session-data.ts";
import {
  limitSidebarSessionRows,
  loadStoredSidebarSessionsGrouping,
  loadStoredSidebarSessionsShowCron,
  SIDEBAR_AGENT_SESSION_LIST_LIMIT,
  SIDEBAR_SESSION_PAGE_SIZE,
  type SidebarRecentSession,
  type SidebarSessionSortMode,
} from "./app-sidebar-session-types.ts";
import { isStoppableCloudWorkerPlacement } from "./session-row-badges.ts";

/** Session-row projection, selection, sorting, and agent scope navigation. */
export abstract class AppSidebarSessionNavigationElement extends AppSidebarSessionDataElement {
  @state() protected selectedSessionKeys: ReadonlySet<string> = new Set();
  @state() protected sessionSortMode: SidebarSessionSortMode = "created";
  @state() protected sessionsGrouping: SidebarSessionsGrouping =
    loadStoredSidebarSessionsGrouping();
  @state() protected sessionsShowCron = loadStoredSidebarSessionsShowCron();

  private sessionSelectionAnchor: string | null = null;

  protected getRouteSessionKey(): string {
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

  protected promoteCreatedSession(sessionKey: string) {
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

  protected getSessionNavigationState() {
    const context = this.context;
    const routeSessionKey = this.getRouteSessionKey();
    const navigation = resolveSessionNavigation({
      result: this.sessionsResult,
      resultAgentId: this.sessionsAgentId,
      sessionKey: routeSessionKey,
      assistantAgentId:
        context?.agentSelection.state.selectedId ?? context?.gateway.snapshot.assistantAgentId,
      hello: context?.gateway.snapshot.hello,
      showCron: this.sessionsShowCron,
      compareSessions: this.compareSidebarSessionRows,
    });
    const highlightCurrentSession = this.activeRouteId === "chat";
    const toSidebarSession = (row: SessionsListResult["sessions"][number]) => {
      const channelInfo = resolveChannelSessionInfo(row.key, row.channel);
      return {
        key: row.key,
        label: resolveSessionDisplayName(row.key, row),
        meta: formatSidebarTimestamp(row.updatedAt),
        subtitle: resolveSessionWorkSubtitle(row),
        href: `${pathForRoute("chat", context?.basePath ?? "")}${searchForSession(row.key)}`,
        active: row.key === navigation.activeRowKey,
        visuallyActive: highlightCurrentSession && row.key === navigation.currentSessionKey,
        hasActiveRun: Boolean(row.hasActiveRun),
        modelSelectionLocked: row.modelSelectionLocked === true,
        kind: row.kind,
        pinned: row.pinned === true,
        category: normalizeOptionalString(row.category),
        channel: channelInfo.channel,
        channelSession: channelInfo.channelSession,
        workSession: Boolean(row.worktree || row.execNode),
        worktreeId: row.worktree?.id,
        placementState: row.placement?.state,
        cloudWorkerActive: isStoppableCloudWorkerPlacement(row.placement),
        hasAutomation: row.hasAutomation === true,
        unread: row.unread === true,
      } satisfies SidebarRecentSession;
    };
    const visibleSessions = navigation.visibleSessions.map(toSidebarSession);
    return {
      routeSessionKey: navigation.currentSessionKey,
      selectedAgentId: navigation.selectedAgentId,
      visibleSessions,
      toSidebarSession,
      newSessionDisabled: !this.connected,
      newSessionTitle: this.connected
        ? t("chat.runControls.newSession")
        : t("chat.runControls.newSessionDisconnected"),
    };
  }

  protected selectedAgentIdForSessions(): string {
    return this.getSessionNavigationState().selectedAgentId;
  }

  protected readonly selectSession = (sessionKey: string) => {
    this.context?.gateway.setSessionKey(sessionKey);
    this.onNavigate?.("chat", {
      search: searchForSession(sessionKey),
    });
  };

  /** Rows in on-screen order; shift ranges and batch actions share this ordering. */
  protected visibleSessionRowsInOrder(): SidebarRecentSession[] {
    const navigationState = this.getSessionNavigationState();
    const sections = groupSidebarSessionRows(
      limitSidebarSessionRows(
        this.selectedAgentSessionRows(navigationState),
        this.visibleSessionLimit,
      ),
      {
        grouping: this.sessionsGrouping,
        knownGroups: this.sessionsGrouping === "category" ? this.knownSessionGroups() : undefined,
      },
    );
    return sections.flatMap((section) => {
      // Mirrors renderSessionSection: only headered sections can collapse.
      const showHeader = section.id === "pinned" || this.sessionsGrouping === "category";
      return showHeader && this.collapsedSessionSections.has(section.id) ? [] : section.rows;
    });
  }

  protected selectedVisibleSessions(): SidebarRecentSession[] {
    if (this.selectedSessionKeys.size === 0) {
      return [];
    }
    return this.visibleSessionRowsInOrder().filter((row) => this.selectedSessionKeys.has(row.key));
  }

  protected handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession) {
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }
    // Cmd/Ctrl and Shift clicks build the multi-select instead of the browser's
    // open-in-new-tab default; middle-click still opens the row in a new tab.
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      this.toggleSessionSelected(session.key);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      this.extendSessionSelection(session.key);
      return;
    }
    if (event.altKey) {
      return;
    }
    event.preventDefault();
    this.clearSessionSelection();
    this.selectSession(session.key);
  }

  private toggleSessionSelected(key: string) {
    const next = new Set(this.selectedSessionKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.sessionSelectionAnchor = next.has(key) ? key : null;
    this.selectedSessionKeys = next;
  }

  private extendSessionSelection(key: string) {
    const rows = this.visibleSessionRowsInOrder();
    const anchor =
      this.sessionSelectionAnchor ??
      rows.find((row) => row.visuallyActive || row.active)?.key ??
      key;
    const anchorIndex = rows.findIndex((row) => row.key === anchor);
    const targetIndex = rows.findIndex((row) => row.key === key);
    if (anchorIndex === -1 || targetIndex === -1) {
      this.sessionSelectionAnchor = key;
      this.selectedSessionKeys = new Set([key]);
      return;
    }
    const [start, end] =
      anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    this.sessionSelectionAnchor = anchor;
    this.selectedSessionKeys = new Set(rows.slice(start, end + 1).map((row) => row.key));
  }

  protected clearSessionSelection() {
    this.sessionSelectionAnchor = null;
    if (this.selectedSessionKeys.size > 0) {
      this.selectedSessionKeys = new Set();
    }
  }

  protected readonly replaceCurrentSession = (sessionKey: string) => {
    this.context?.gateway.setSessionKey(sessionKey);
    if (this.activeRouteId === "chat") {
      this.onNavigate?.("chat", {
        search: searchForSession(sessionKey),
      });
    }
  };

  /** Chip switching selects the agent and refreshes its session list. */
  protected readonly expandAgent = (agentId: string) => {
    const context = this.context;
    if (!context) {
      return;
    }
    const nextAgentId = normalizeAgentId(agentId);
    if (nextAgentId === normalizeAgentId(this.expandedAgentId())) {
      context.agentSelection.setScope(nextAgentId);
      return;
    }
    this.clearSessionSelection();
    this.visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
    context.agentSelection.set(nextAgentId);
    void context.sessions.refresh({
      agentId: nextAgentId,
      limit: SIDEBAR_AGENT_SESSION_LIST_LIMIT,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      force: true,
    });
  };

  protected expandedAgentId(): string {
    const selected = normalizeOptionalString(this.context?.agentSelection.state.selectedId);
    return selected
      ? normalizeAgentId(selected)
      : normalizeAgentId(this.getSessionNavigationState().selectedAgentId);
  }

  protected activeChipAgent() {
    const agents = this.context?.agents.state.agentsList?.agents ?? [];
    const activeId = this.expandedAgentId();
    const agent = agents.find((entry) => normalizeAgentId(entry.id) === activeId);
    return { activeId, agent, agents };
  }

  /** Newest visible session for an agent; the chip menu resumes here. */
  private latestAgentSessionRow(agentId: string): SessionsListResult["sessions"][number] | null {
    const normalized = normalizeAgentId(agentId);
    const rows =
      normalized === normalizeAgentId(this.sessionsAgentId ?? "")
        ? (this.sessionsResult?.sessions ?? [])
        : (this.sessionRowsByAgent[normalized] ?? []);
    // Unprefixed keys belong to the system default agent. Keeping them for
    // another agent would resume the wrong conversation with the raw key.
    const visible = filterVisibleSessionRows(rows, {
      agentId: normalized,
      defaultAgentId: resolveUiDefaultAgentId({
        agentsList: this.context?.agents.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      }),
      filterByAgent: true,
    });
    return visible.toSorted(compareSessionRowsByUpdatedAt)[0] ?? null;
  }

  private agentResumeKey(agentId: string): string {
    const latest = this.latestAgentSessionRow(agentId);
    if (latest) {
      return latest.key;
    }
    return buildAgentMainSessionKey({
      agentId,
      mainKey: resolveUiConfiguredMainKey({
        agentsList: this.context?.agents.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      }),
    });
  }

  /** Offline routes to Settings instead of a dead chat load. */
  private openAgentConversation(agentId: string) {
    if (!this.connected) {
      this.onNavigate?.("config");
      return;
    }
    this.selectSession(this.agentResumeKey(agentId));
  }

  protected agentChipSubtitle(agentId: string): string {
    if (!this.connected) {
      return t("common.offline");
    }
    const latest = this.latestAgentSessionRow(agentId);
    if (latest?.hasActiveRun) {
      return t("agentChip.working");
    }
    if (latest) {
      const label = resolveSessionDisplayName(latest.key, latest);
      const meta = formatSidebarTimestamp(latest.updatedAt);
      return meta ? `${label} · ${meta}` : label;
    }
    return t("agentChip.ready");
  }

  protected switchChipAgent(agentId: string) {
    this.closeAgentMenu();
    this.expandAgent(agentId);
    this.openAgentConversation(agentId);
  }

  protected askAgentCapabilities(agentId: string) {
    this.closeAgentMenu();
    if (!this.connected) {
      return;
    }
    const key = this.agentResumeKey(agentId);
    const draft = encodeURIComponent(t("chat.welcome.suggestions.whatCanYouDo"));
    this.context?.gateway.setSessionKey(key);
    this.onNavigate?.("chat", { search: `${searchForSession(key)}&draft=${draft}` });
  }

  protected knownSessionGroups(): string[] {
    const catalog = this.context?.sessions.state.groups ?? [];
    const catalogSet = new Set(catalog);
    const discovered = (this.sessionsResult?.sessions ?? [])
      .map((row) => normalizeOptionalString(row.category))
      .filter((name): name is string => typeof name === "string" && !catalogSet.has(name))
      .toSorted((a, b) => a.localeCompare(b));
    return [...catalog, ...new Set(discovered)];
  }

  /** The list follows the chip-selected agent without flashing stale rows mid-switch. */
  protected selectedAgentSessionRows(
    navigationState: ReturnType<AppSidebarSessionNavigationElement["getSessionNavigationState"]>,
  ): SidebarRecentSession[] {
    const adopted = adoptedCatalogSessionKeys(this.sessionCatalogs);
    const selected = this.expandedAgentId();
    const loadedAgentId = normalizeAgentId(this.sessionsAgentId ?? "");
    const routeAgentId = normalizeAgentId(navigationState.selectedAgentId);
    if (selected === routeAgentId && selected === loadedAgentId) {
      return navigationState.visibleSessions.filter((row) => !adopted.has(row.key));
    }
    const rows =
      selected === loadedAgentId
        ? (this.sessionsResult?.sessions ?? [])
        : (this.sessionRowsByAgent[selected] ?? []);
    return filterVisibleSessionRows(rows, {
      agentId: selected,
      defaultAgentId: resolveUiDefaultAgentId({
        agentsList: this.context?.agents.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      }),
      filterByAgent: true,
      showCron: this.sessionsShowCron,
    })
      .toSorted(this.compareSidebarSessionRows)
      .filter((row) => !adopted.has(row.key))
      .map(navigationState.toSidebarSession);
  }

  protected agentUnreadCount(agentId: string): number {
    const rows = this.sessionRowsByAgent[normalizeAgentId(agentId)] ?? [];
    return rows.filter((row) => row.unread === true && row.archived !== true).length;
  }

  protected abstract closeAgentMenu(options?: { restoreFocus?: boolean }): void;
  protected abstract readonly collapsedSessionSections: ReadonlySet<string>;
}
