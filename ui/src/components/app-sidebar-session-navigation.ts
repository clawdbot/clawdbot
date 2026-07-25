import type { PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { serializeSidebarEntry } from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import { listSelectableAgents } from "../lib/agents/display.ts";
import { isCronSessionKey, resolveSessionDisplayName } from "../lib/session-display.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import {
  compareSessionRowsByUpdatedAt,
  filterVisibleSessionRows,
  searchForSession,
  sessionMatchesArchivedFilter,
} from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { AppSidebarBase } from "./app-sidebar-base.ts";
import { adoptedCatalogSessionKeys } from "./app-sidebar-session-catalogs.ts";
import {
  applySidebarSessionCreatorFilter,
  buildReconciledSidebarZone,
  buildSidebarSessionNavigationState,
  collectKnownSidebarSessionGroups,
  extendSidebarSessionSelection,
  findSidebarMainSessionRow,
  findProjectedSidebarSession,
  latestVisibleAgentSessionRow,
  partitionSidebarVisibleSections,
  promoteSidebarSessionCreatedOrder,
  resolveSidebarMainSessionKey,
  toggleSidebarSessionSelection,
  type SidebarSessionNavigationState,
  type SidebarVisibleSections,
} from "./app-sidebar-session-navigation-logic.ts";
import { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import {
  loadStoredSidebarSessionStatusFilter,
  loadStoredSidebarSessionsGrouping,
  loadStoredSidebarSessionsShowCron,
  type SidebarRecentSession,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { SessionAttentionController } from "./session-attention-controller.ts";
import { SessionDataController } from "./session-data-controller.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import type { SessionCreatedActor, SessionCreatorOption } from "./session-owner-chip.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";

/** Session-row projection, selection, sorting, and agent scope navigation. */
export class AppSidebarSessionNavigationElement extends AppSidebarBase {
  @state() sessionSortMode: SidebarSessionSortMode = "created";

  readonly sessionData = new SessionDataController(this);
  private readonly sessionPullRequestIndicators = new SessionPullRequestIndicatorsController(this, {
    getConnected: () => this.connected,
    getRows: () => this.visibleSessionPullRequestRows(),
    getSelectedAgentId: () => this.selectedAgentIdForSessions(),
    getSnapshot: () => this.context?.gateway.snapshot,
  });

  protected readonly compareSidebarSessionRows = (
    a: SessionsListResult["sessions"][number],
    b: SessionsListResult["sessions"][number],
  ) => {
    if (this.sessionSortMode === "updated") {
      return compareSessionRowsByUpdatedAt(a, b);
    }
    return (
      (this.sessionData.sessionCreatedOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
      (this.sessionData.sessionCreatedOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    );
  };

  @state() sessionCreatorFilterId: string | null = null;

  sessionCreatorOptions: readonly SessionCreatorOption[] = [];
  protected activeSessionCreatorId: string | null = null;
  sessionCreatorFilterActive = false;
  sessionOwnershipVisible = false;

  @state() selectedSessionKeys: ReadonlySet<string> = new Set();
  @state() protected expandedChildSessionKeys: ReadonlySet<string> = new Set();
  @state() protected collapsedActiveChildSessionKeys: ReadonlySet<string> = new Set();
  @state() fullyShownChildSessionKeys: ReadonlySet<string> = new Set();
  @state() sessionsGrouping: SidebarSessionsGrouping = loadStoredSidebarSessionsGrouping();
  @state() sessionsShowCron = loadStoredSidebarSessionsShowCron();
  @state() sessionsStatusFilter: SidebarSessionStatusFilter =
    loadStoredSidebarSessionStatusFilter();

  private sessionSelectionAnchor: string | null = null;
  private collapsedActiveRouteKey: string | null = null;
  private readonly runtimeSampledAtByRow = new WeakMap<GatewaySessionRow, number>();
  private readonly attention = new SessionAttentionController(this);

  // These controllers initialize on AppSidebar after the navigation-owned
  // controllers, matching the former inheritance-chain field order.
  declare readonly sessionOrganizer: SessionOrganizerController;
  declare readonly sidebarMenus: SidebarMenusController;

  get sessionAttentionContext() {
    return this.context;
  }

  get sessionDataContext() {
    return this.context;
  }

  get collapsedSessionSections(): ReadonlySet<string> {
    return this.sessionOrganizer.collapsedSessionSections;
  }

  dismissTransientMenus(): boolean {
    return this.sidebarMenus.dismissTransientMenus();
  }

  protected closeAgentMenu(options?: { restoreFocus?: boolean }): void {
    this.sidebarMenus.closeAgentMenu(options);
  }

  promoteCreatedSession(sessionKey: string) {
    if (promoteSidebarSessionCreatedOrder(this.sessionData.sessionCreatedOrder, sessionKey)) {
      this.requestUpdate();
    }
  }

  sessionPullRequestIndicatorState(sessionKey: string, worktreeId: string) {
    return this.sessionPullRequestIndicators.state(sessionKey, worktreeId);
  }

  private visibleSessionPullRequestRows(): SidebarRecentSession[] {
    const rows = this.visibleSessionRowsInOrder();
    const adopted = adoptedCatalogSessionKeys(this.sessionData.sessionCatalogs);
    if (adopted.size === 0) {
      return rows;
    }
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const liveRows = [
      ...(this.sessionData.sessionsResult?.sessions ?? []),
      ...Object.values(this.sessionData.sessionRowsByAgent).flat(),
    ];
    for (const row of liveRows) {
      if (adopted.has(row.key) && !byKey.has(row.key)) {
        byKey.set(row.key, this.projectSidebarSession(row));
      }
    }
    return [...byKey.values()];
  }

  override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    const selectedId = this.sessionCreatorFilterId;
    const creators = this.sessionData.sessionsResult?.creators;
    if (
      selectedId &&
      creators &&
      (creators.length < 2 || !creators.some((creator) => creator.id === selectedId))
    ) {
      this.sessionCreatorFilterId = null;
      void this.context?.sessions.setCreatorFilter(null);
    }
    const activeRouteKey = this.activeRouteId === "chat" ? this.getRouteSessionKey() : "";
    if (activeRouteKey !== this.collapsedActiveRouteKey) {
      this.collapsedActiveRouteKey = activeRouteKey;
      if (this.collapsedActiveChildSessionKeys.size > 0) {
        this.collapsedActiveChildSessionKeys = new Set();
      }
    }
    if (this.activeRouteId === "chat") {
      void this.sessionData.loadActiveSessionLineage(activeRouteKey);
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
        !this.sessionData.loadedChildSessionKeys.has(session.key) &&
        !this.sessionData.failedChildSessionKeys.has(session.key) &&
        !this.sessionData.loadingChildSessionKeys.has(session.key)
      ) {
        void this.sessionData.loadChildSessions(session.key);
      }
    }
    // The main session hides behind the identity card, so nothing in the list
    // triggers its child fetch; load eagerly or its threads never surface.
    const mainRow = this.mainSessionRow();
    if (
      mainRow &&
      (mainRow.childSessions?.length ?? 0) > 0 &&
      !this.sessionData.loadedChildSessionKeys.has(mainRow.key) &&
      !this.sessionData.failedChildSessionKeys.has(mainRow.key) &&
      !this.sessionData.loadingChildSessionKeys.has(mainRow.key)
    ) {
      void this.sessionData.loadChildSessions(mainRow.key);
    }
  }

  protected applySessionCreatorFilter(
    projected: readonly SidebarRecentSession[],
    creatorRows: readonly { createdActor?: SessionCreatedActor }[] = [],
    creatorFacet?: readonly { id: string; label?: string }[],
  ): SidebarRecentSession[] {
    const result = applySidebarSessionCreatorFilter({
      projected,
      creatorRows,
      creatorFacet: creatorFacet ?? this.sessionData.sessionsResult?.creators,
      selectedCreatorId: this.sessionCreatorFilterId,
    });
    this.sessionCreatorOptions = result.creatorOptions;
    this.sessionOwnershipVisible = result.ownershipVisible;
    this.sessionCreatorFilterActive = result.activeCreatorId !== null;
    this.activeSessionCreatorId = result.activeCreatorId;
    return result.rows;
  }

  protected hideEmptyCreatorFilteredGroup(category: string | undefined, rowCount: number): boolean {
    return this.sessionCreatorFilterActive && Boolean(category) && rowCount === 0;
  }

  protected projectSidebarSession(row: GatewaySessionRow): SidebarRecentSession {
    return this.getSessionNavigationState().toSidebarSession(row);
  }

  public getRouteSessionKey(): string {
    return this.sessionKey.trim() || this.context?.gateway.snapshot.sessionKey.trim() || "";
  }

  outboxCountForSessionKey(sessionKey: string): number {
    return this.outboxCountForSession(sessionKey);
  }

  getSessionNavigationState(): SidebarSessionNavigationState {
    return buildSidebarSessionNavigationState({
      context: this.context,
      routeSessionKey: this.getRouteSessionKey(),
      sessionsResult: this.sessionData.sessionsResult,
      sessionsAgentId: this.sessionData.sessionsAgentId,
      showCron: this.sessionsShowCron,
      statusFilter: this.sessionsStatusFilter,
      compareSessions: this.compareSidebarSessionRows,
      highlightCurrentSession: this.activeRouteId === "chat",
      runtimeSampledAtByRow: this.runtimeSampledAtByRow,
      loadingChildSessionKeys: this.sessionData.loadingChildSessionKeys,
      outboxCountForSessionKey: (sessionKey) => this.outboxCountForSessionKey(sessionKey),
      resolveAttention: (row) => this.attention.resolveSessionAttention(row),
      resolveAgentStatusNote: (row) => this.attention.resolveSessionAgentStatus(row)?.note,
    });
  }

  selectedAgentIdForSessions(): string {
    return this.getSessionNavigationState().selectedAgentId;
  }

  sidebarSessionStatusFilter(): SidebarSessionStatusFilter {
    return this.sessionsStatusFilter;
  }

  readonly selectSession = (sessionKey: string) => {
    this.context?.gateway.setSessionKey(sessionKey);
    this.onNavigate?.("chat", {
      search: searchForSession(sessionKey),
    });
  };

  /** Collapsed zones keep full rows for true header counts and status dots. */
  protected zonedVisibleSections(rows: SidebarRecentSession[]): SidebarVisibleSections {
    return partitionSidebarVisibleSections({
      rows,
      grouping: this.sessionsGrouping,
      knownGroups: this.sessionsGrouping === "category" ? this.knownSessionGroups() : undefined,
      collapsedSections: this.collapsedSessionSections,
      hideEmptyCreatorFilteredGroup: (category, rowCount) =>
        this.hideEmptyCreatorFilteredGroup(category, rowCount),
      visibleSessionLimits: this.sessionData.visibleSessionLimits,
    });
  }

  reconciledSidebarZone() {
    const navigationState = this.getSessionNavigationState();
    const rows = this.selectedAgentSessionRows(navigationState);
    return buildReconciledSidebarZone({
      sidebarEntries: this.sidebarEntries,
      rows,
      workboardBoards: this.workboardBoards,
      enabledRouteIds: this.enabledRouteIds,
      workboardBoardsReady: this.workboardBoardsReady,
    });
  }

  /**
   * Drop one session entry from the persisted zone order (raw list, no
   * reconcile-pruning). Only sidebar-driven unpins call this; other surfaces
   * (e.g. the Sessions page) rely on reconcileSidebarZone's known-unpinned
   * pruning at the next canonical write, which keeps the slot hidden meanwhile.
   */
  pruneSidebarSessionEntry(key: string) {
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

  selectedVisibleSessions(): SidebarRecentSession[] {
    if (this.selectedSessionKeys.size === 0) {
      return [];
    }
    return this.visibleSessionRowsInOrder().filter((row) => this.selectedSessionKeys.has(row.key));
  }

  handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession) {
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
    const selection = toggleSidebarSessionSelection(this.selectedSessionKeys, key);
    this.sessionSelectionAnchor = selection.anchor;
    this.selectedSessionKeys = selection.selectedKeys;
  }

  private extendSessionSelection(key: string) {
    const selection = extendSidebarSessionSelection({
      rows: this.visibleSessionRowsInOrder(),
      anchor: this.sessionSelectionAnchor,
      key,
    });
    this.sessionSelectionAnchor = selection.anchor;
    this.selectedSessionKeys = selection.selectedKeys;
  }

  clearSessionSelection() {
    this.sessionSelectionAnchor = null;
    if (this.selectedSessionKeys.size > 0) {
      this.selectedSessionKeys = new Set();
    }
  }

  readonly replaceCurrentSession = (sessionKey: string) => {
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
    this.sessionData.visibleSessionLimits.clear();
    context.agentSelection.set(nextAgentId);
    void this.sessionData.refreshSidebarSessions(nextAgentId);
  };

  expandedAgentId(): string {
    const selected = normalizeOptionalString(this.context?.agentSelection.state.selectedId);
    return selected
      ? normalizeAgentId(selected)
      : normalizeAgentId(this.getSessionNavigationState().selectedAgentId);
  }

  activeChipAgent() {
    const roster = this.context?.agents.state.agentsList?.agents ?? [];
    const activeId = this.expandedAgentId();
    const agent = roster.find((entry) => normalizeAgentId(entry.id) === activeId);
    return { activeId, agent, agents: listSelectableAgents(roster) };
  }

  /** Newest visible session for an agent; the chip menu resumes here. */
  private latestAgentSessionRow(agentId: string): SessionsListResult["sessions"][number] | null {
    return latestVisibleAgentSessionRow({
      agentId,
      sessionsAgentId: this.sessionData.sessionsAgentId,
      sessionsResult: this.sessionData.sessionsResult,
      sessionRowsByAgent: this.sessionData.sessionRowsByAgent,
      defaultAgentId: resolveUiDefaultAgentId({
        agentsList: this.context?.agents.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      }),
    });
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

  agentChipSubtitle(agentId: string): string {
    const latest = this.latestAgentSessionRow(agentId);
    if (latest?.hasActiveRun) {
      return t("agentChip.working");
    }
    if (latest) {
      return resolveSessionDisplayName(latest.key, latest);
    }
    return t("agentChip.ready");
  }

  switchChipAgent(agentId: string) {
    this.closeAgentMenu();
    this.expandAgent(agentId);
    this.openAgentConversation(agentId);
  }

  askAgentCapabilities(agentId: string) {
    this.closeAgentMenu();
    if (!this.connected) {
      return;
    }
    const key = this.agentResumeKey(agentId);
    const draft = encodeURIComponent(t("chat.welcome.suggestions.whatCanYouDo"));
    this.context?.gateway.setSessionKey(key);
    this.onNavigate?.("chat", { search: `${searchForSession(key)}&draft=${draft}` });
  }

  knownSessionGroups(): string[] {
    return collectKnownSidebarSessionGroups(
      this.context?.sessions.state.groups ?? [],
      this.sessionData.sessionsResult?.sessions ?? [],
    );
  }

  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined {
    const navigationState = this.getSessionNavigationState();
    return findProjectedSidebarSession({
      sessionKey,
      navigationState,
      sessionRowsByAgent: this.sessionData.sessionRowsByAgent,
    });
  }

  /** The list follows the chip-selected agent without flashing stale rows mid-switch. */
  protected selectedAgentSessionRows(
    navigationState: SidebarSessionNavigationState,
  ): SidebarRecentSession[] {
    const adopted = adoptedCatalogSessionKeys(this.sessionData.sessionCatalogs);
    const selected = this.expandedAgentId();
    const loadedAgentId = normalizeAgentId(this.sessionData.sessionsAgentId ?? "");
    const routeAgentId = normalizeAgentId(navigationState.selectedAgentId);
    const rows =
      selected === loadedAgentId
        ? (this.sessionData.sessionsResult?.sessions ?? [])
        : (this.sessionData.sessionRowsByAgent[selected] ?? []);
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
            archivedFilter: this.sessionsStatusFilter,
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
    const lineageRoot = this.sessionData.activeSessionLineageRoot;
    const lineageAgentId = normalizeAgentId(
      parseAgentSessionKey(lineageRoot?.key ?? "")?.agentId ?? "",
    );
    const lineageRouteAgentId = normalizeAgentId(
      parseAgentSessionKey(navigationState.routeSessionKey)?.agentId ?? "",
    );
    if (
      lineageRoot &&
      lineageRoot.archived !== true &&
      sessionMatchesArchivedFilter(lineageRoot, this.sessionsStatusFilter) &&
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
    const promotedRows = [
      ...rows,
      ...Object.values(this.sessionData.childSessionRowsByParent).flat(),
    ].filter((row) => {
      const parentKey = row.spawnedBy ?? row.parentSessionKey;
      return (
        parentKey != null &&
        mainSessionKeys.has(parentKey) &&
        !scopedRootKeys.has(row.key) &&
        !row.archived &&
        (this.sessionsShowCron || !isCronSessionKey(row.key))
      );
    });
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
    const projected = projectSessionTree({
      roots: orderedRootRows.filter((row) => !adopted.has(row.key)),
      agentRows: rows,
      childRowsByParent: this.sessionData.childSessionRowsByParent,
      loadingChildKeys: this.sessionData.loadingChildSessionKeys,
      knownSessionAttention: this.attention.knownSessionAttention(),
      toSidebarSession: navigationState.toSidebarSession,
    });
    const creatorFacet =
      rows === this.sessionData.sessionsResult?.sessions
        ? this.sessionData.sessionsResult.creators
        : undefined;
    return this.applySessionCreatorFilter(projected, rows, creatorFacet);
  }

  /** Canonical main-session key for the selected (or given) agent. */
  selectedAgentMainSessionKey(agentId?: string): string {
    return resolveSidebarMainSessionKey({
      agentId: agentId ?? this.expandedAgentId(),
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    });
  }

  /** Gateway row backing the identity card (unread/running state), if loaded. */
  mainSessionRow(agentId?: string): GatewaySessionRow | null {
    const normalized = normalizeAgentId(agentId ?? this.expandedAgentId());
    const mainKey = this.selectedAgentMainSessionKey(normalized);
    const rows =
      normalized === normalizeAgentId(this.sessionData.sessionsAgentId ?? "")
        ? (this.sessionData.sessionsResult?.sessions ?? [])
        : (this.sessionData.sessionRowsByAgent[normalized] ?? []);
    return findSidebarMainSessionRow(rows, mainKey);
  }

  /** Identity-card click: the agent's rolling main session, or Settings offline. */
  readonly openMainSession = (agentId: string) => {
    if (!this.connected) {
      this.onNavigate?.("config");
      return;
    }
    this.clearSessionSelection();
    this.selectSession(this.selectedAgentMainSessionKey(normalizeAgentId(agentId)));
  };

  isSessionChildrenExpanded(session: SidebarRecentSession): boolean {
    return (
      this.expandedChildSessionKeys.has(session.key) ||
      (session.containsActiveDescendant && !this.collapsedActiveChildSessionKeys.has(session.key))
    );
  }

  toggleSessionChildren(session: SidebarRecentSession) {
    const next = new Set(this.expandedChildSessionKeys);
    const collapsedActive = new Set(this.collapsedActiveChildSessionKeys);
    const fullyShown = new Set(this.fullyShownChildSessionKeys);
    if (this.isSessionChildrenExpanded(session)) {
      next.delete(session.key);
      fullyShown.delete(session.key);
      if (session.containsActiveDescendant) {
        collapsedActive.add(session.key);
      }
      this.sessionData.discardEmptyChildSessionSnapshot(session.key);
    } else {
      next.add(session.key);
      collapsedActive.delete(session.key);
      this.sessionData.retryChildSessions(session.key);
    }
    this.expandedChildSessionKeys = next;
    this.collapsedActiveChildSessionKeys = collapsedActive;
    this.fullyShownChildSessionKeys = fullyShown;
  }

  showMoreChildren(sessionKey: string) {
    this.fullyShownChildSessionKeys = new Set(this.fullyShownChildSessionKeys).add(sessionKey);
  }

  agentUnreadCount(agentId: string): number {
    const rows = this.sessionData.sessionRowsByAgent[normalizeAgentId(agentId)] ?? [];
    return rows.filter((row) => row.unread === true && row.archived !== true).length;
  }
}
