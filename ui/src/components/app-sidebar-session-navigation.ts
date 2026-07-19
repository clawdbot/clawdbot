import { state } from "lit/decorators.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { SIDEBAR_NAV_ROUTES, serializeSidebarEntry } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import {
  isCronSessionKey,
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkSubtitle,
} from "../lib/session-display.ts";
import {
  groupSidebarSessionRows,
  sidebarSectionHasHeader,
  type SidebarSessionSection,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import {
  compareSessionRowsByUpdatedAt,
  filterVisibleSessionRows,
  resolveSessionNavigation,
  searchForSession,
} from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  isAcpSessionKey,
  isUiGlobalScopeConfigured,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiCanonicalMainSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { reconcileSidebarZone } from "../lib/sidebar-zone.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { AppSidebarSessionAttentionElement } from "./app-sidebar-session-attention.ts";
import {
  adoptedCatalogSessionKeys,
  formatSidebarTimestamp,
} from "./app-sidebar-session-catalogs.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
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
export abstract class AppSidebarSessionNavigationElement extends AppSidebarSessionAttentionElement {
  @state() protected selectedSessionKeys: ReadonlySet<string> = new Set();
  @state() protected expandedChildSessionKeys: ReadonlySet<string> = new Set();
  @state() protected collapsedActiveChildSessionKeys: ReadonlySet<string> = new Set();
  @state() protected fullyShownChildSessionKeys: ReadonlySet<string> = new Set();
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
    // The main session hides behind the identity card, so nothing in the list
    // triggers its child fetch; load eagerly or its threads never surface.
    const mainRow = this.mainSessionRow();
    if (
      mainRow &&
      (mainRow.childSessions?.length ?? 0) > 0 &&
      !this.loadedChildSessionKeys.has(mainRow.key) &&
      !this.failedChildSessionKeys.has(mainRow.key) &&
      !this.loadingChildSessionKeys.has(mainRow.key)
    ) {
      void this.loadChildSessions(mainRow.key);
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
        // The sidebar's zone structure already says what forked from what;
        // a "Subagent:" prefix on named threads is noise (other surfaces keep it).
        label: resolveSessionDisplayName(row.key, row, {
          includeSubagentPrefix: false,
        }),
        meta: formatSidebarTimestamp(row.updatedAt),
        subtitle: resolveSessionWorkSubtitle(row),
        href: `${pathForRoute("chat", context?.basePath ?? "")}${searchForSession(row.key)}`,
        active: row.key === navigation.activeRowKey,
        visuallyActive: highlightCurrentSession && row.key === navigation.currentSessionKey,
        hasActiveRun: Boolean(row.hasActiveRun),
        modelSelectionLocked: row.modelSelectionLocked === true,
        kind: row.kind,
        pinned: row.pinned === true,
        icon: row.icon,
        category: normalizeOptionalString(row.category),
        channel: channelInfo.channel,
        channelSession: channelInfo.channelSession,
        workSession: Boolean(row.worktree || row.execNode),
        acpSession: isAcpSessionKey(row.key),
        worktreeId: row.worktree?.id,
        placementState: row.placement?.state,
        cloudWorkerActive: isStoppableCloudWorkerPlacement(row.placement),
        hasAutomation: row.hasAutomation === true,
        unread: row.unread === true,
        attention: this.resolveSessionAttention(row),
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

  protected isSessionSectionCollapsed(sectionId: string): boolean {
    return (
      sidebarSectionHasHeader(sectionId, this.sessionsGrouping) &&
      this.collapsedSessionSections.has(sectionId)
    );
  }

  /**
   * Zone partition with the visible-page limit applied only to expanded
   * sections: collapsed zones keep full rows (true header counts) but do not
   * consume the page budget, so a collapsed Coding zone cannot crowd threads
   * out of the first page.
   */
  protected zonedVisibleSections(rows: SidebarRecentSession[]): {
    sections: (SidebarSessionSection<SidebarRecentSession> & { totalRowCount: number })[];
    expandedRows: SidebarRecentSession[];
    visibleRows: SidebarRecentSession[];
  } {
    const sections = groupSidebarSessionRows(rows, {
      grouping: this.sessionsGrouping,
      knownGroups: this.sessionsGrouping === "category" ? this.knownSessionGroups() : undefined,
    }).filter((section) => section.id !== "pinned");
    const expandedRows = sections.flatMap((section) =>
      this.isSessionSectionCollapsed(section.id) ? [] : section.rows,
    );
    const visibleRows = limitSidebarSessionRows(expandedRows, this.visibleSessionLimit);
    const keep = new Set(visibleRows.map((row) => row.key));
    // totalRowCount is the pre-pagination size: headers and empty-zone
    // checks must not mistake a page-filtered section for an empty one.
    const limitedSections: (SidebarSessionSection<SidebarRecentSession> & {
      totalRowCount: number;
    })[] = [];
    for (const section of sections) {
      const totalRowCount = section.rows.length;
      if (!this.isSessionSectionCollapsed(section.id)) {
        section.rows = section.rows.filter((row) => keep.has(row.key));
      }
      limitedSections.push(Object.assign(section, { totalRowCount }));
    }
    return { sections: limitedSections, expandedRows, visibleRows };
  }

  protected reconciledSidebarZone() {
    const navigationState = this.getSessionNavigationState();
    const rows = this.selectedAgentSessionRows(navigationState);
    const pinnedRows = rows.filter((row) => row.pinned);
    // Only loaded rows count as authoritative unpinned state; entries for
    // other agents' sessions must survive canonical writes untouched.
    const knownUnpinnedKeys = new Set(rows.filter((row) => !row.pinned).map((row) => row.key));
    const reconciled = reconcileSidebarZone(
      this.sidebarEntries,
      pinnedRows,
      SIDEBAR_NAV_ROUTES,
      knownUnpinnedKeys,
    );
    return {
      ...reconciled,
      sessionRows: new Map(pinnedRows.map((row) => [row.key, row])),
    };
  }

  /**
   * Drop one session entry from the persisted zone order (raw list, no
   * reconcile-pruning). Only sidebar-driven unpins call this; other surfaces
   * (e.g. the Sessions page) rely on reconcileSidebarZone's known-unpinned
   * pruning at the next canonical write, which keeps the slot hidden meanwhile.
   */
  protected pruneSidebarSessionEntry(key: string) {
    const serialized = serializeSidebarEntry({ type: "session", key });
    if (!this.sidebarEntries.includes(serialized)) {
      return;
    }
    this.onUpdateSidebarEntries?.(this.sidebarEntries.filter((entry) => entry !== serialized));
  }

  /** Rows in on-screen order; shift ranges and batch actions share this ordering. */
  protected visibleSessionRowsInOrder(): SidebarRecentSession[] {
    const navigationState = this.getSessionNavigationState();
    const rows = this.selectedAgentSessionRows(navigationState);
    const { visibleRows } = this.zonedVisibleSections(rows);
    const pinnedByKey = new Map(rows.filter((row) => row.pinned).map((row) => [row.key, row]));
    const pinnedRows = this.reconciledSidebarZone().entries.flatMap((entry) =>
      entry.type === "session"
        ? pinnedByKey.get(entry.key)
          ? [pinnedByKey.get(entry.key)!]
          : []
        : [],
    );
    return [...pinnedRows, ...visibleRows];
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
      return resolveSessionDisplayName(latest.key, latest);
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
    // The identity card is the main session's entry point; its row leaves the
    // list and its spawned children surface as top-level threads instead.
    // Children index under the gateway row's literal key, which may be an
    // equivalent alias (e.g. "main"), so promotion tracks every removed key.
    const mainSessionKey = this.selectedAgentMainSessionKey(selected);
    const mainSessionKeys = new Set<string>([mainSessionKey]);
    const scopedRootRows = rootRows.filter((row) => {
      if (areUiSessionKeysEquivalent(row.key, mainSessionKey)) {
        mainSessionKeys.add(row.key);
        return false;
      }
      return true;
    });
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
      !areUiSessionKeysEquivalent(lineageRoot.key, mainSessionKey) &&
      !scopedRootRows.some((row) => row.key === lineageRoot.key)
    ) {
      scopedRootRows.push(lineageRoot);
    }
    // Promote the hidden main session's children to top-level threads, with
    // the same visibility rules and sort order as ordinary roots so archived
    // or cron children cannot sneak in and pagination stays deterministic.
    const scopedRootKeys = new Set(scopedRootRows.map((row) => row.key));
    const promotedRows = [...rows, ...Object.values(this.childSessionRowsByParent).flat()].filter(
      (row) => {
        const parentKey = row.spawnedBy ?? row.parentSessionKey;
        return (
          parentKey != null &&
          mainSessionKeys.has(parentKey) &&
          !scopedRootKeys.has(row.key) &&
          !row.archived &&
          (this.sessionsShowCron || (row.kind !== "cron" && !isCronSessionKey(row.key)))
        );
      },
    );
    for (const row of promotedRows) {
      if (!scopedRootKeys.has(row.key)) {
        scopedRootKeys.add(row.key);
        scopedRootRows.push(row);
      }
    }
    const orderedRootRows =
      promotedRows.length > 0
        ? scopedRootRows.toSorted(this.compareSidebarSessionRows)
        : scopedRootRows;
    // `adopted` holds only catalog-bound keys (adoptedCatalogSessionKeys), not
    // fetched child rows: a catalog-adopted promoted child intentionally
    // renders as its live row inside the Coding catalog, never as a thread.
    return projectSessionTree({
      roots: orderedRootRows.filter((row) => !adopted.has(row.key)),
      agentRows: rows,
      childRowsByParent: this.childSessionRowsByParent,
      loadingChildKeys: this.loadingChildSessionKeys,
      knownSessionAttention: this.knownSessionAttention(),
      toSidebarSession: navigationState.toSidebarSession,
    });
  }

  /** Canonical main-session key for the selected (or given) agent. */
  protected selectedAgentMainSessionKey(agentId?: string): string {
    const host = {
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    };
    // Global-scope gateways advertise the canonical main session as the
    // literal "global" key; a synthesized agent key would never match it.
    if (isUiGlobalScopeConfigured(host)) {
      return resolveUiCanonicalMainSessionKey(host);
    }
    return buildAgentMainSessionKey({
      agentId: agentId ?? this.expandedAgentId(),
      mainKey: resolveUiConfiguredMainKey(host),
    });
  }

  /** Gateway row backing the identity card (unread/running state), if loaded. */
  protected mainSessionRow(agentId?: string): GatewaySessionRow | null {
    const normalized = normalizeAgentId(agentId ?? this.expandedAgentId());
    const mainKey = this.selectedAgentMainSessionKey(normalized);
    const rows =
      normalized === normalizeAgentId(this.sessionsAgentId ?? "")
        ? (this.sessionsResult?.sessions ?? [])
        : (this.sessionRowsByAgent[normalized] ?? []);
    return rows.find((row) => areUiSessionKeysEquivalent(row.key, mainKey)) ?? null;
  }

  /** Identity-card click: the agent's rolling main session, or Settings offline. */
  protected readonly openMainSession = (agentId: string) => {
    if (!this.connected) {
      this.onNavigate?.("config");
      return;
    }
    this.clearSessionSelection();
    this.selectSession(this.selectedAgentMainSessionKey(normalizeAgentId(agentId)));
  };

  protected isSessionChildrenExpanded(session: SidebarRecentSession): boolean {
    return (
      this.expandedChildSessionKeys.has(session.key) ||
      (session.containsActiveDescendant && !this.collapsedActiveChildSessionKeys.has(session.key))
    );
  }

  protected toggleSessionChildren(session: SidebarRecentSession) {
    const next = new Set(this.expandedChildSessionKeys);
    const collapsedActive = new Set(this.collapsedActiveChildSessionKeys);
    const fullyShown = new Set(this.fullyShownChildSessionKeys);
    if (this.isSessionChildrenExpanded(session)) {
      next.delete(session.key);
      fullyShown.delete(session.key);
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
    this.fullyShownChildSessionKeys = fullyShown;
  }

  protected showAllSessionChildren(sessionKey: string) {
    this.fullyShownChildSessionKeys = new Set(this.fullyShownChildSessionKeys).add(sessionKey);
  }

  protected agentUnreadCount(agentId: string): number {
    const rows = this.sessionRowsByAgent[normalizeAgentId(agentId)] ?? [];
    return rows.filter((row) => row.unread === true && row.archived !== true).length;
  }

  protected abstract closeAgentMenu(options?: { restoreFocus?: boolean }): void;
  protected abstract readonly collapsedSessionSections: ReadonlySet<string>;
}
