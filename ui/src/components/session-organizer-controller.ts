import type { ReactiveController } from "lit";
import {
  parseSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  serializeSidebarEntry,
  type SidebarNavRoute,
} from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import {
  readSessionDragData,
  readSessionGroupDragData,
  readSidebarRouteDragData,
  sessionDragActive,
  sessionGroupDragActive,
  sidebarRouteDragActive,
  writeSidebarRouteDragData,
} from "../lib/sessions/drag.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import {
  loadStoredCollapsedSessionSections,
  storeSidebarSessionStatusFilter,
  storeCollapsedSessionSections,
  storeSidebarSessionsGrouping,
  storeSidebarSessionsShowCron,
  type SidebarRecentSession,
  type SidebarSessionGroupDropTarget,
  type SidebarSessionMutationResult,
  type SidebarSessionMutationScope,
  type SidebarSessionPatch,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionMenuAction } from "./session-menu.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-operations.runtime.ts";

type SessionOrganizerOperations = typeof import("./session-organizer-operations.runtime.ts");

/** Custom session groups, collapse state, and drag-and-drop assignment. */
export class SessionOrganizerController implements ReactiveController {
  collapsedSessionSections = loadStoredCollapsedSessionSections();
  draggingSessionKey: string | null = null;
  draggingSessionGroup: string | null = null;
  sessionDropTarget: string | null = null;
  sessionGroupDropTarget: SidebarSessionGroupDropTarget | null = null;
  draggingSidebarEntry: string | null = null;
  sidebarZoneDropTarget: {
    entry: string;
    position: "before" | "after";
  } | null = null;
  sessionListRemovalDrop = false;
  private operationsLoad: Promise<SessionOrganizerOperations> | null = null;

  constructor(private readonly host: SessionOrganizerControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {}

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
    await operations?.deleteSession(this.host, session, scope);
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

  startSessionGroupDrag(group: string): void {
    this.draggingSessionGroup = group;
    this.host.requestUpdate();
  }

  finishSessionGroupDrag(): void {
    this.draggingSessionGroup = null;
    this.host.requestUpdate();
    this.sessionGroupDropTarget = null;
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

  async renameSession(session: SidebarRecentSession): Promise<void> {
    const nextLabel = window.prompt(t("sessionsView.renameSessionPrompt"), session.label);
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
    const name = window.prompt(t("sessionsView.newGroupPrompt"))?.trim();
    if (!name) {
      return;
    }
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    await operations?.createSessionGroup(this.host, name, sessions, scope);
  }

  async renameSessionGroupFromMenu(group: string): Promise<void> {
    const next = window.prompt(t("sessionsView.renameGroupPrompt"), group)?.trim();
    if (!next || next === group) {
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
    if (!window.confirm(t("sessionsView.deleteGroupConfirm", { group }))) {
      return;
    }
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

  private async reorderSessionGroup(
    source: string,
    target: string,
    position: "before" | "after",
  ): Promise<void> {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    await operations?.reorderSessionGroup(this.host, source, target, position, scope);
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

  sectionDragOver(event: DragEvent, sectionId: string, category?: string) {
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
      this.host.requestUpdate();
      this.sessionDropTarget = null;
      this.host.requestUpdate();
      return;
    }
    if (!sessionDragActive(dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (dataTransfer) {
      dataTransfer.dropEffect = "move";
    }
    this.sessionDropTarget = sectionId;
    this.host.requestUpdate();
    this.sessionGroupDropTarget = null;
    this.host.requestUpdate();
  }

  sectionDragLeave(event: DragEvent, sectionId: string, category?: string) {
    const current = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
      return;
    }
    if (this.sessionDropTarget === sectionId) {
      this.sessionDropTarget = null;
      this.host.requestUpdate();
    }
    if (category && this.sessionGroupDropTarget?.group === category) {
      this.sessionGroupDropTarget = null;
      this.host.requestUpdate();
    }
  }

  sectionDrop(event: DragEvent, sectionId: string, category?: string) {
    const sourceGroup = readSessionGroupDragData(event.dataTransfer);
    const sessionKey = readSessionDragData(event.dataTransfer);
    if (!sourceGroup && !sessionKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (sourceGroup && category && sourceGroup !== category) {
      const position =
        this.sessionGroupDropTarget?.group === category
          ? this.sessionGroupDropTarget.position
          : "before";
      void this.reorderSessionGroup(sourceGroup, category, position);
    } else {
      // Rows can be dragged from a browsed agent section, so search all caches.
      const session = sessionKey ? this.host.findSidebarSessionByKey(sessionKey) : undefined;
      if (session && sectionId === "pinned") {
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
    }
    this.finishSidebarEntryDrag();
    this.draggingSessionGroup = null;
    this.host.requestUpdate();
    this.sessionDropTarget = null;
    this.host.requestUpdate();
    this.sessionGroupDropTarget = null;
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
