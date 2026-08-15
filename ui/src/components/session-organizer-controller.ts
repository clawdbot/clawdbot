import type { ReactiveControllerHost } from "lit";
import type { FsListDirResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  parseSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  serializeSidebarEntry,
  type SidebarNavRoute,
} from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import {
  readSessionDragData,
  readSidebarSectionDragData,
  readSidebarRouteDragData,
  sessionDragActive,
  sidebarSectionDragActive,
  sidebarRouteDragActive,
  writeSidebarRouteDragData,
} from "../lib/sessions/drag.ts";
import {
  categoryClearReturnsToGroups,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import {
  loadStoredCollapsedSessionSections,
  storeSidebarSessionStatusFilter,
  storeCollapsedSessionSections,
  storeSidebarSessionsGrouping,
  storeSidebarSessionsShowCron,
  storeSidebarSessionsShowSystem,
  type SidebarRecentSession,
  type SidebarSectionDropTarget,
  type SidebarSessionMutationResult,
  type SidebarSessionMutationScope,
  type SidebarSessionPatch,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import type { SessionMenuAction } from "./session-menu.ts";

type SessionOrganizerOperations = typeof import("./session-organizer-operations.runtime.ts");
type InputDialogOpener = (typeof import("./input-dialog.ts"))["showInputDialog"];
type SessionGroupDefaultsDialogOpener =
  (typeof import("./session-group-defaults-dialog.ts"))["showSessionGroupDefaultsDialog"];

export interface SessionOrganizerControllerHost extends ReactiveControllerHost {
  readonly sessionData: Pick<
    SessionDataController,
    | "beginSessionMutation"
    | "isSessionMutationScopeCurrent"
    | "publishSessionMutationError"
    | "refreshSidebarSessions"
    | "resetForStatusFilter"
    | "sessionMutationError"
  >;
  readonly onUpdateSidebarEntries?: (entries: string[]) => void;
  sessionsGrouping: SidebarSessionsGrouping;
  sessionsShowCron: boolean;
  sessionsShowSystem: boolean;
  sessionsStatusFilter: SidebarSessionStatusFilter;
  clearSessionSelection(): void;
  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined;
  knownSessionGroups(): string[];
  listSessionGroupFolders(path?: string): Promise<FsListDirResult>;
  sessionGroupDefaults(name: string): { cwd: string; worktree: boolean } | null;
  knownSessionCatalogIds(): string[];
  knownSectionOrder(): string[];
  pruneSidebarSessionEntry(key: string): void;
  reconciledSidebarZone(): { sidebarEntries: readonly string[] };
  replaceCurrentSession(sessionKey: string): void;
  selectSession(sessionKey: string): void;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
}

/** Custom session groups, collapse state, and drag-and-drop assignment. */
export class SessionOrganizerController {
  collapsedSessionSections = loadStoredCollapsedSessionSections();
  draggingSessionKey: string | null = null;
  draggingSidebarSection: string | null = null;
  sessionDropTarget: string | null = null;
  sidebarSectionDropTarget: SidebarSectionDropTarget | null = null;
  draggingSidebarEntry: string | null = null;
  sidebarZoneDropTarget: {
    entry: string;
    position: "before" | "after";
  } | null = null;
  sessionListRemovalDrop = false;
  private operationsLoad: Promise<SessionOrganizerOperations> | null = null;

  constructor(private readonly host: SessionOrganizerControllerHost) {}

  private async loadOperations(
    scope: SidebarSessionMutationScope,
  ): Promise<SessionOrganizerOperations | null> {
    const load = (this.operationsLoad ??= import("./session-organizer-operations.runtime.ts"));
    try {
      return await load;
    } catch (error) {
      if (this.operationsLoad === load) {
        this.operationsLoad = null;
      }
      if (this.host.sessionData.isSessionMutationScopeCurrent(scope)) {
        this.host.sessionData.publishSessionMutationError(scope, error);
      }
      return null;
    }
  }

  readonly patchSession = async (
    session: SidebarRecentSession,
    patch: SidebarSessionPatch,
    scope: SidebarSessionMutationScope | null = this.host.sessionData.beginSessionMutation(),
  ): Promise<SidebarSessionMutationResult> => {
    if (!scope) {
      return "stale";
    }
    const operations = await this.loadOperations(scope);
    if (!operations) {
      return this.host.sessionData.isSessionMutationScopeCurrent(scope) ? "failed" : "stale";
    }
    return operations.patchSession(this.host, session, patch, scope);
  };

  async patchSessions(
    rows: readonly SidebarRecentSession[],
    patch: SidebarSessionPatch,
    scope: SidebarSessionMutationScope | null = this.host.sessionData.beginSessionMutation(),
  ): Promise<SidebarSessionMutationResult> {
    if (!scope) {
      return "stale";
    }
    const operations = await this.loadOperations(scope);
    if (!operations) {
      return this.host.sessionData.isSessionMutationScopeCurrent(scope) ? "failed" : "stale";
    }
    return operations.patchSessions(this.host, rows, patch, scope);
  }

  async archiveSessionWithUndo(session: SidebarRecentSession): Promise<void> {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    await operations?.archiveSessionWithUndo(this.host, session, scope);
  }

  async deleteSessionsBatch(rows: readonly SidebarRecentSession[]): Promise<void> {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    await operations?.deleteSessionsBatch(this.host, rows, scope);
  }

  async runBatchSessionAction(
    action: SessionMenuAction,
    rows: SidebarRecentSession[],
    allUnread: boolean,
  ): Promise<void> {
    if (action.kind === "new-group") {
      await this.createSessionGroup(rows);
      return;
    }
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    await operations?.runBatchSessionAction(this.host, action, rows, allUnread, scope);
  }

  async forkSession(session: SidebarRecentSession): Promise<void> {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    await operations?.forkSession(this.host, session, scope);
  }

  async stopCloudWorker(session: SidebarRecentSession): Promise<void> {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    await operations?.stopCloudWorker(this.host, session, scope);
  }

  async deleteSession(session: SidebarRecentSession): Promise<void> {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    // Sidebar is the surface the delete-confirm setting names, so it is the one
    // caller allowed to offer the opt-out.
    await operations?.deleteSession(this.host, session, scope, { offerSkip: true });
  }

  startSidebarRouteDrag(event: DragEvent, route: SidebarNavRoute) {
    if (!event.dataTransfer) {
      return;
    }
    writeSidebarRouteDragData(event.dataTransfer, route);
    this.draggingSidebarEntry = serializeSidebarEntry({ type: "route", route });
    this.host.requestUpdate();
  }

  startSidebarWorkboardDrag(event: DragEvent, boardId: string) {
    if (!event.dataTransfer) {
      return;
    }
    const entry = serializeSidebarEntry({ type: "workboard", boardId });
    writeSidebarRouteDragData(event.dataTransfer, entry);
    this.draggingSidebarEntry = entry;
    this.host.requestUpdate();
  }

  finishSidebarEntryDrag() {
    this.draggingSidebarEntry = null;
    this.host.requestUpdate();
    this.draggingSessionKey = null;
    this.host.requestUpdate();
    this.sidebarZoneDropTarget = null;
    this.host.requestUpdate();
    this.sessionListRemovalDrop = false;
    this.host.requestUpdate();
  }

  startSessionDrag(session: SidebarRecentSession): void {
    this.draggingSessionKey = session.key;
    this.host.requestUpdate();
    this.draggingSidebarEntry = session.pinned ? `session:${session.key}` : null;
    this.host.requestUpdate();
  }

  finishSessionDrag(): void {
    this.finishSidebarEntryDrag();
    this.sessionDropTarget = null;
    this.host.requestUpdate();
  }

  startSidebarSectionDrag(sectionId: string): void {
    this.draggingSidebarSection = sectionId;
    this.host.requestUpdate();
  }

  finishSidebarSectionDrag(): void {
    this.draggingSidebarSection = null;
    this.host.requestUpdate();
    this.sidebarSectionDropTarget = null;
    this.host.requestUpdate();
  }

  private draggedSidebarEntry(dataTransfer: DataTransfer | null): string | null {
    const route = readSidebarRouteDragData(dataTransfer);
    if (route && SIDEBAR_NAV_ROUTES.includes(route as SidebarNavRoute)) {
      return serializeSidebarEntry({ type: "route", route: route as SidebarNavRoute });
    }
    const dynamicEntry = parseSidebarEntry(route);
    if (dynamicEntry?.type === "workboard") {
      return serializeSidebarEntry(dynamicEntry);
    }
    const sessionKey = readSessionDragData(dataTransfer);
    return sessionKey ? serializeSidebarEntry({ type: "session", key: sessionKey }) : null;
  }

  handleSidebarZoneDragOver(event: DragEvent, targetEntry?: string) {
    if (!sidebarRouteDragActive(event.dataTransfer) && !sessionDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    if (!targetEntry) {
      this.sidebarZoneDropTarget = null;
      this.host.requestUpdate();
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const bounds = target.getBoundingClientRect();
    this.sidebarZoneDropTarget = {
      entry: targetEntry,
      position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    };
    this.host.requestUpdate();
  }

  handleSidebarZoneDragLeave(event: DragEvent) {
    const current = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
      return;
    }
    this.sidebarZoneDropTarget = null;
    this.host.requestUpdate();
  }

  /** Insert `entry` into the freshest canonical order at the captured drop slot. */
  private writeSidebarEntryAt(
    entry: string,
    targetEntry: string | undefined,
    position: "before" | "after" | undefined,
  ) {
    const next = this.host
      .reconciledSidebarZone()
      .sidebarEntries.filter((candidate) => candidate !== entry);
    const targetIndex = targetEntry ? next.indexOf(targetEntry) : -1;
    const offset = position === "after" ? 1 : 0;
    next.splice(targetIndex < 0 ? next.length : targetIndex + offset, 0, entry);
    this.host.onUpdateSidebarEntries?.(next);
  }

  handleSidebarZoneDrop(event: DragEvent, targetEntry?: string) {
    const entry = this.draggedSidebarEntry(event.dataTransfer);
    if (!entry) {
      return;
    }
    // Consume before the self-drop bailout: an unhandled drop would bubble to
    // the zone container and append the entry at the end.
    event.preventDefault();
    event.stopPropagation();
    if (targetEntry === entry) {
      this.finishSidebarEntryDrag();
      return;
    }
    const position = this.sidebarZoneDropTarget?.position;
    const sessionKey = readSessionDragData(event.dataTransfer);
    const session = sessionKey ? this.host.findSidebarSessionByKey(sessionKey) : undefined;
    if (session && !session.pinned) {
      // Persist the dropped slot only once the pin lands, and recompute
      // against the then-current order: a failed patch must not leave an
      // unpinned slot behind, and a stale snapshot must not undo zone edits
      // that raced the request.
      void this.patchSession(session, { pinned: true }).then((result) => {
        if (result === "completed") {
          this.writeSidebarEntryAt(entry, targetEntry, position);
        }
      });
    } else {
      this.writeSidebarEntryAt(entry, targetEntry, position);
    }
    this.finishSidebarEntryDrag();
  }

  private removeSidebarEntry(entry: string) {
    const next = this.host
      .reconciledSidebarZone()
      .sidebarEntries.filter((candidate) => candidate !== entry);
    this.host.onUpdateSidebarEntries?.(next);
  }

  handleSessionListDragOver(event: DragEvent) {
    const routeDrag = sidebarRouteDragActive(event.dataTransfer);
    const sessionKey = readSessionDragData(event.dataTransfer);
    const session = sessionKey ? this.host.findSidebarSessionByKey(sessionKey) : undefined;
    if (!routeDrag && !session?.pinned) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    this.sessionListRemovalDrop = true;
    this.host.requestUpdate();
  }

  handleSessionListDragLeave(event: DragEvent) {
    const current = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))) {
      this.sessionListRemovalDrop = false;
      this.host.requestUpdate();
    }
  }

  handleSessionListDrop(event: DragEvent) {
    const draggedNavigation = readSidebarRouteDragData(event.dataTransfer);
    const dynamicEntry = parseSidebarEntry(draggedNavigation);
    const entry =
      draggedNavigation && SIDEBAR_NAV_ROUTES.includes(draggedNavigation as SidebarNavRoute)
        ? ({ type: "route", route: draggedNavigation as SidebarNavRoute } as const)
        : dynamicEntry?.type === "workboard"
          ? dynamicEntry
          : null;
    if (entry) {
      event.preventDefault();
      this.removeSidebarEntry(serializeSidebarEntry(entry));
      this.finishSidebarEntryDrag();
      return;
    }
    const sessionKey = readSessionDragData(event.dataTransfer);
    const session = sessionKey ? this.host.findSidebarSessionByKey(sessionKey) : undefined;
    if (session?.pinned) {
      event.preventDefault();
      // patchSession prunes the persisted zone entry once the unpin lands.
      void this.patchSession(session, { pinned: false });
    }
    this.finishSidebarEntryDrag();
  }

  /** A dialog that never opens still owes the operator a visible outcome. */
  private async loadInputDialog(): Promise<InputDialogOpener | null> {
    try {
      return (await import("./input-dialog.ts")).showInputDialog;
    } catch (error) {
      const scope = this.host.sessionData.beginSessionMutation();
      if (scope) {
        this.host.sessionData.publishSessionMutationError(scope, error);
      }
      return null;
    }
  }

  async renameSession(session: SidebarRecentSession): Promise<void> {
    const showInputDialog = await this.loadInputDialog();
    const nextLabel =
      (await showInputDialog?.({
        title: t("sessionsView.renameSessionPrompt"),
        defaultValue: session.label,
      })) ?? null;
    if (nextLabel === null) {
      return;
    }
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    await operations?.renameSession(this.host, session, nextLabel, scope);
  }

  async createSessionGroup(sessions: readonly SidebarRecentSession[] = []): Promise<void> {
    const showInputDialog = await this.loadInputDialog();
    await showInputDialog?.({
      title: t("sessionsView.newGroupTitle"),
      label: t("sessionsView.newGroupPrompt"),
      submitLabel: t("sessionsView.newGroupCreate"),
      requireValue: true,
      submit: (name) => this.writeSessionGroup(name, sessions),
    });
  }

  /**
   * Replays the failure the mutation already recorded so the dialog can keep the
   * typed name for a retry. A replaced connection confirmed neither the group nor
   * the move, so it reports a retryable message too rather than closing on an
   * outcome that never landed; resubmitting runs against the new connection.
   */
  private async writeSessionGroup(
    name: string,
    sessions: readonly SidebarRecentSession[],
  ): Promise<string | null> {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return t("sessionsView.newGroupFailed");
    }
    const operations = await this.loadOperations(scope);
    if (!operations) {
      return this.host.sessionData.isSessionMutationScopeCurrent(scope)
        ? this.sessionGroupFailure()
        : t("sessionsView.newGroupStale");
    }
    const result = await operations.createSessionGroup(this.host, name, sessions, scope);
    if (result === "failed") {
      return this.sessionGroupFailure();
    }
    return result === "stale" ? t("sessionsView.newGroupStale") : null;
  }

  private sessionGroupFailure(): string {
    return this.host.sessionData.sessionMutationError ?? t("sessionsView.newGroupFailed");
  }

  async renameSessionGroupFromMenu(group: string): Promise<void> {
    const showInputDialog = await this.loadInputDialog();
    // requireChange holds the submit closed on the name the group already has,
    // so the only rename that reaches the Gateway is one that changes something.
    const next = await showInputDialog?.({
      title: t("sessionsView.renameGroupTitle", { group }),
      label: t("sessionsView.groupNameLabel"),
      defaultValue: group,
      requireValue: true,
      requireChange: true,
    });
    if (!next) {
      return;
    }
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    if (!operations || !(await operations.renameSessionGroup(this.host, group, next, scope))) {
      return;
    }
    // Collapse keys follow only a confirmed Gateway rename. A stale completion
    // must not rewrite storage owned by the replacement connection.
    const from = `category:${group}`;
    if (this.collapsedSessionSections.has(from)) {
      const collapsed = new Set(this.collapsedSessionSections);
      collapsed.delete(from);
      collapsed.add(`category:${next}`);
      this.saveCollapsedSessionSections(collapsed);
    }
    this.host.requestUpdate();
  }

  async deleteSessionGroupFromMenu(group: string): Promise<void> {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    if (!operations || !(await operations.deleteSessionGroup(this.host, group, scope))) {
      return;
    }
    const collapsed = new Set(this.collapsedSessionSections);
    collapsed.delete(`category:${group}`);
    this.saveCollapsedSessionSections(collapsed);
    this.host.requestUpdate();
  }

  async editSessionGroupDefaults(group: string): Promise<void> {
    let showDialog: SessionGroupDefaultsDialogOpener;
    try {
      showDialog = (await import("./session-group-defaults-dialog.ts"))
        .showSessionGroupDefaultsDialog;
    } catch (error) {
      const scope = this.host.sessionData.beginSessionMutation();
      if (scope) {
        this.host.sessionData.publishSessionMutationError(scope, error);
      }
      return;
    }
    const defaults = this.host.sessionGroupDefaults(group);
    if (defaults) {
      await showDialog({
        group,
        defaults,
        listDirectory: (path) => this.host.listSessionGroupFolders(path),
        submit: async (nextDefaults) => {
          const scope = this.host.sessionData.beginSessionMutation();
          if (!scope || !this.host.sessionGroupDefaults(group)) {
            return t("sessionsView.groupDefaultsStale");
          }
          const operations = await this.loadOperations(scope);
          const result = await operations?.updateSessionGroupDefaults(
            this.host,
            group,
            { cwd: nextDefaults.cwd || null, worktree: nextDefaults.worktree },
            scope,
          );
          return result === "completed"
            ? null
            : result === "stale"
              ? t("sessionsView.groupDefaultsStale")
              : (this.host.sessionData.sessionMutationError ??
                t("sessionsView.groupDefaultsFailed"));
        },
      });
    }
  }

  saveCollapsedSessionSections(sections: ReadonlySet<string>) {
    this.collapsedSessionSections = new Set(sections);
    this.host.requestUpdate();
    try {
      storeCollapsedSessionSections(sections);
    } catch {
      // Group membership and ordering remain usable without local persistence.
    }
  }

  toggleSection(sectionId: string) {
    const collapsed = new Set(this.collapsedSessionSections);
    if (collapsed.has(sectionId)) {
      collapsed.delete(sectionId);
    } else {
      collapsed.add(sectionId);
    }
    this.saveCollapsedSessionSections(collapsed);
  }

  private async reorderSidebarSection(
    sourceSectionId: string,
    targetSectionId: string,
    position: "before" | "after",
  ): Promise<void> {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    await operations?.reorderSidebarSection(
      this.host,
      sourceSectionId,
      targetSectionId,
      position,
      scope,
    );
  }

  async assignSessionCategory(
    session: SidebarRecentSession,
    category: string | null,
    patch: { pinned?: boolean } = {},
  ): Promise<void> {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    await operations?.assignSessionCategory(this.host, session, category, scope, patch);
  }

  private sectionAcceptsSession(
    sectionId: string,
    category: string | undefined,
    session: SidebarRecentSession | undefined,
  ): boolean {
    if (sectionId === "pinned") {
      return true;
    }
    if (
      this.host.sessionsGrouping === "category" &&
      (sectionId === "ungrouped" || Boolean(category))
    ) {
      return true;
    }
    return (
      sectionId === "groups" &&
      Boolean(session && categoryClearReturnsToGroups(session, this.host.sessionsGrouping))
    );
  }

  sectionDragOver(event: DragEvent, sectionId: string, category?: string) {
    const dataTransfer = event.dataTransfer;
    if (sidebarSectionDragActive(dataTransfer) && this.draggingSidebarSection !== sectionId) {
      event.preventDefault();
      if (dataTransfer) {
        dataTransfer.dropEffect = "move";
      }
      const target = event.currentTarget as HTMLElement;
      const header = target.querySelector<HTMLElement>(":scope > .sidebar-recent-sessions__head");
      const bounds = (header ?? target).getBoundingClientRect();
      const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      this.sidebarSectionDropTarget = { sectionId, position };
      this.host.requestUpdate();
      this.sessionDropTarget = null;
      this.host.requestUpdate();
      return;
    }
    if (!sessionDragActive(dataTransfer)) {
      return;
    }
    // Browsers protect transferred data during dragover. Use the key recorded
    // at dragstart for hover eligibility; sectionDrop reads the payload itself.
    const session = this.draggingSessionKey
      ? this.host.findSidebarSessionByKey(this.draggingSessionKey)
      : undefined;
    if (!this.sectionAcceptsSession(sectionId, category, session)) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    if (dataTransfer) {
      dataTransfer.dropEffect = "move";
    }
    this.sessionDropTarget = sectionId;
    this.host.requestUpdate();
    this.sidebarSectionDropTarget = null;
    this.host.requestUpdate();
  }

  sectionDragLeave(event: DragEvent, sectionId: string, _category?: string) {
    const current = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
      return;
    }
    if (this.sessionDropTarget === sectionId) {
      this.sessionDropTarget = null;
      this.host.requestUpdate();
    }
    if (this.sidebarSectionDropTarget?.sectionId === sectionId) {
      this.sidebarSectionDropTarget = null;
      this.host.requestUpdate();
    }
  }

  sectionDrop(event: DragEvent, sectionId: string, category?: string) {
    const sourceSectionId = readSidebarSectionDragData(event.dataTransfer);
    const sessionKey = readSessionDragData(event.dataTransfer);
    if (!sourceSectionId && !sessionKey) {
      return;
    }
    // Rows can be dragged from a browsed agent section, so search all caches.
    const session = sessionKey ? this.host.findSidebarSessionByKey(sessionKey) : undefined;
    if (!sourceSectionId && !this.sectionAcceptsSession(sectionId, category, session)) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (sourceSectionId && sourceSectionId !== sectionId) {
      const position =
        this.sidebarSectionDropTarget?.sectionId === sectionId
          ? this.sidebarSectionDropTarget.position
          : "before";
      void this.reorderSidebarSection(sourceSectionId, sectionId, position);
    } else if (session && sectionId === "pinned") {
      if (!session.pinned) {
        void this.patchSession(session, { pinned: true });
      }
    } else if (session) {
      const nextCategory = category ?? null;
      if (session.category !== nextCategory || session.pinned) {
        // The pinned:false leg prunes the persisted zone entry via patchSession.
        void this.assignSessionCategory(
          session,
          nextCategory,
          session.pinned ? { pinned: false } : {},
        );
      }
    }
    this.finishSidebarEntryDrag();
    this.draggingSidebarSection = null;
    this.host.requestUpdate();
    this.sessionDropTarget = null;
    this.host.requestUpdate();
    this.sidebarSectionDropTarget = null;
    this.host.requestUpdate();
  }

  setSessionsGrouping(grouping: SidebarSessionsGrouping) {
    this.host.sessionsGrouping = grouping;
    try {
      storeSidebarSessionsGrouping(grouping);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }

  setSessionsShowCron(show: boolean) {
    this.host.sessionsShowCron = show;
    try {
      storeSidebarSessionsShowCron(show);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }

  setSessionsShowSystem(show: boolean) {
    this.host.sessionsShowSystem = show;
    try {
      storeSidebarSessionsShowSystem(show);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }

  setSessionsStatusFilter(statusFilter: SidebarSessionStatusFilter) {
    if (statusFilter === this.host.sessionsStatusFilter) {
      return;
    }
    this.host.sessionsStatusFilter = statusFilter;
    this.host.clearSessionSelection();
    this.host.sessionData.resetForStatusFilter(statusFilter);
    try {
      storeSidebarSessionStatusFilter(statusFilter);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
    void this.host.sessionData.refreshSidebarSessions();
  }
}
