import { state } from "lit/decorators.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
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
  parseAgentSessionKey,
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
  @state() protected expandedChildSessionKeys: ReadonlySet<string> = new Set();
  @state() protected collapsedActiveChildSessionKeys: ReadonlySet<string> = new Set();
  @state() protected sessionSortMode: SidebarSessionSortMode = "created";
  @state() protected sessionsGrouping: SidebarSessionsGrouping =
    loadStoredSidebarSessionsGrouping();
  @state() protected sessionsShowCron = loadStoredSidebarSessionsShowCron();

  private sessionSelectionAnchor: string | null = null;
  private collapsedActiveRouteKey: string | null = null;
  private readonly runtimeSampledAtByRow = new WeakMap<GatewaySessionRow, number>();

  override updated() {
    super.updated();
    const activeRouteKey = this.activeRouteId === "chat" ? this.getRouteSessionKey() : "";
    if (activeRouteKey !== this.collapsedActiveRouteKey) {
      this.collapsedActiveRouteKey = activeRouteKey;
      if (this.collapsedActiveChildSessionKeys.size > 0) {
        this.collapsedActiveChildSessionKeys = new Set();
      }
    }
    if (this.activeRouteId === "chat") {
      void this.loadActiveSessionLineage(activeRouteKey);
    }
    const pending = [...this.visibleSessionRowsInOrder()];
    while (pending.length > 0) {
      const session = pending.shift();
      if (!session) {
        continue;
      }
      pending.push(...session.children);
      if (
        session.childSessionKeys.length > 0 &&
        this.isSessionChildrenExpanded(session) &&
        !this.loadedChildSessionKeys.has(session.key) &&
        !this.failedChildSessionKeys.has(session.key) &&
        !this.loadingChildSessionKeys.has(session.key)
      ) {
        void this.loadChildSessions(session.key);
      }
    }
  }

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
    const toSidebarSession = (row: SessionsListResult["sessions"][number], isChild = false) => {
      const channelInfo = resolveChannelSessionInfo(row.key, row.channel);
      let runtimeSampledAt = row.runtimeSampledAt;
      if (row.runtimeMs != null && runtimeSampledAt == null) {
        runtimeSampledAt = this.runtimeSampledAtByRow.get(row);
        if (runtimeSampledAt == null) {
          runtimeSampledAt = Date.now();
          this.runtimeSampledAtByRow.set(row, runtimeSampledAt);
        }
      }
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
        spawnedBy: row.spawnedBy,
        status: row.status,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        runtimeMs: row.runtimeMs,
        runtimeSampledAt,
        childSessionKeys: row.childSessions ?? [],
        children: [],
        isChild,
        loadingChildren: this.loadingChildSessionKeys.has(row.key),
        containsActiveDescendant: false,
        runningChildCount: 0,
        failedChildCount: 0,
      } satisfies SidebarRecentSession;
    };
    const visibleSessions = navigation.visibleSessions.map((row) => toSidebarSession(row));
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
    if (session.isChild) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      this.clearSessionSelection();
      this.selectSession(session.key);
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
    this.expandedChildSessionKeys = new Set();
    this.visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
    context.agentSelection.set(nextAgentId);
    void context.sessions.refresh({
      agentId: nextAgentId,
      limit: SIDEBAR_AGENT_SESSION_LIST_LIMIT,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      includeDerivedTitles: true,
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
    const rows =
      selected === loadedAgentId
        ? (this.sessionsResult?.sessions ?? [])
        : (this.sessionRowsByAgent[selected] ?? []);
    const rowsByKey = new Map(rows.map((row) => [row.key, row]));
    const rootRows =
      selected === routeAgentId && selected === loadedAgentId
        ? navigationState.visibleSessions.flatMap((session) => {
            const row = rowsByKey.get(session.key);
            return row ? [row] : [];
          })
        : filterVisibleSessionRows(rows, {
            agentId: selected,
            defaultAgentId: resolveUiDefaultAgentId({
              agentsList: this.context?.agents.state.agentsList,
              hello: this.context?.gateway.snapshot.hello,
            }),
            filterByAgent: true,
            showCron: this.sessionsShowCron,
          }).toSorted(this.compareSidebarSessionRows);
    const scopedRootRows = [...rootRows];
    const lineageRoot = this.activeSessionLineageRoot;
    const lineageAgentId = normalizeAgentId(
      parseAgentSessionKey(lineageRoot?.key ?? "")?.agentId ?? "",
    );
    const lineageRouteAgentId = normalizeAgentId(
      parseAgentSessionKey(navigationState.routeSessionKey)?.agentId ?? "",
    );
    if (
      lineageRoot &&
      (lineageAgentId === selected || lineageRouteAgentId === selected) &&
      !adopted.has(lineageRoot.key) &&
      !scopedRootRows.some((row) => row.key === lineageRoot.key)
    ) {
      scopedRootRows.push(lineageRoot);
    }
    return this.projectSessionTree(
      scopedRootRows.filter((row) => !adopted.has(row.key)),
      rows,
      navigationState.toSidebarSession,
    );
  }

  protected isSessionChildrenExpanded(session: SidebarRecentSession): boolean {
    return (
      this.expandedChildSessionKeys.has(session.key) ||
      (session.containsActiveDescendant && !this.collapsedActiveChildSessionKeys.has(session.key))
    );
  }

  protected toggleSessionChildren(session: SidebarRecentSession) {
    const next = new Set(this.expandedChildSessionKeys);
    const collapsedActive = new Set(this.collapsedActiveChildSessionKeys);
    if (this.isSessionChildrenExpanded(session)) {
      next.delete(session.key);
      if (session.containsActiveDescendant) {
        collapsedActive.add(session.key);
      }
      if (this.childSessionRowsByParent[session.key]?.length === 0) {
        const childRows = { ...this.childSessionRowsByParent };
        delete childRows[session.key];
        this.childSessionRowsByParent = childRows;
        const loadedKeys = new Set(this.loadedChildSessionKeys);
        loadedKeys.delete(session.key);
        this.loadedChildSessionKeys = loadedKeys;
      }
    } else {
      next.add(session.key);
      collapsedActive.delete(session.key);
      if (this.failedChildSessionKeys.has(session.key)) {
        const failedKeys = new Set(this.failedChildSessionKeys);
        failedKeys.delete(session.key);
        this.failedChildSessionKeys = failedKeys;
      }
      void this.loadChildSessions(session.key);
    }
    this.expandedChildSessionKeys = next;
    this.collapsedActiveChildSessionKeys = collapsedActive;
  }

  private projectSessionTree(
    roots: readonly GatewaySessionRow[],
    agentRows: readonly GatewaySessionRow[],
    toSidebarSession: (row: GatewaySessionRow, isChild?: boolean) => SidebarRecentSession,
  ): SidebarRecentSession[] {
    const rowsByKey = new Map<string, GatewaySessionRow>();
    for (const rows of Object.values(this.childSessionRowsByParent)) {
      for (const row of rows) {
        rowsByKey.set(row.key, row);
      }
    }
    for (const row of agentRows) {
      rowsByKey.set(row.key, row);
    }
    const childKeysByParent = new Map<string, string[]>();
    const appendChild = (parentKey: string, childKey: string) => {
      const keys = childKeysByParent.get(parentKey) ?? [];
      if (!keys.includes(childKey)) {
        keys.push(childKey);
        childKeysByParent.set(parentKey, keys);
      }
    };
    for (const row of rowsByKey.values()) {
      for (const childKey of row.childSessions ?? []) {
        appendChild(row.key, childKey);
      }
    }
    for (const row of rowsByKey.values()) {
      const parentKey = row.spawnedBy ?? row.parentSessionKey;
      if (parentKey) {
        appendChild(parentKey, row.key);
      }
    }

    const build = (
      row: GatewaySessionRow,
      isChild: boolean,
      ancestors: ReadonlySet<string>,
    ): SidebarRecentSession => {
      const childSessionKeys = childKeysByParent.get(row.key) ?? [];
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(row.key);
      const children = childSessionKeys.flatMap((key) => {
        const child = rowsByKey.get(key);
        return child && !nextAncestors.has(key) ? [build(child, true, nextAncestors)] : [];
      });
      const projected = toSidebarSession(row, isChild);
      const projectedRunningChildCount = children.reduce(
        (count, child) =>
          count +
          (child.hasActiveRun || child.status === "running" ? 1 : 0) +
          child.runningChildCount,
        0,
      );
      const runningChildCount = Math.max(
        projectedRunningChildCount,
        row.hasActiveSubagentRun ? 1 : 0,
      );
      const failedChildCount = children.reduce(
        (count, child) =>
          count +
          (child.status === "failed" || child.status === "timeout" ? 1 : 0) +
          child.failedChildCount,
        0,
      );
      return {
        ...projected,
        childSessionKeys,
        children,
        loadingChildren: this.loadingChildSessionKeys.has(row.key),
        containsActiveDescendant: children.some(
          (child) => child.active || child.visuallyActive || child.containsActiveDescendant,
        ),
        runningChildCount,
        failedChildCount,
      };
    };

    const rootKeys = new Set(roots.map((row) => row.key));
    return roots
      .filter((row) => {
        const parentKey = row.spawnedBy ?? row.parentSessionKey;
        return !parentKey || !rootKeys.has(parentKey);
      })
      .map((row) => build(row, false, new Set()));
  }

  protected agentUnreadCount(agentId: string): number {
    const rows = this.sessionRowsByAgent[normalizeAgentId(agentId)] ?? [];
    return rows.filter((row) => row.unread === true && row.archived !== true).length;
  }

  protected abstract closeAgentMenu(options?: { restoreFocus?: boolean }): void;
  protected abstract readonly collapsedSessionSections: ReadonlySet<string>;
}
