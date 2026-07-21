import { state } from "lit/decorators.js";
import {
  parseSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  serializeSidebarEntry,
  type SidebarNavRoute,
} from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import { reorderSessionCustomGroups } from "../lib/sessions/custom-groups.ts";
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
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { AppSidebarSessionMutationsElement } from "./app-sidebar-session-mutations.ts";
import {
  loadStoredCollapsedSessionSections,
  storeCollapsedSessionSections,
  storeSidebarSessionsGrouping,
  storeSidebarSessionsShowCron,
  type SidebarRecentSession,
  type SidebarSessionGroupDropTarget,
  type SidebarSessionMutationResult,
  type SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";

/** Custom session groups, collapse state, and drag-and-drop assignment. */
export abstract class AppSidebarSessionGroupsElement extends AppSidebarSessionMutationsElement {
  @state() protected collapsedSessionSections = loadStoredCollapsedSessionSections();
  @state() protected draggingSessionKey: string | null = null;
  @state() protected draggingSessionGroup: string | null = null;
  @state() protected sessionDropTarget: string | null = null;
  @state() protected sessionGroupDropTarget: SidebarSessionGroupDropTarget | null = null;
  @state() protected draggingSidebarEntry: string | null = null;
  @state() protected sidebarZoneDropTarget: {
    entry: string;
    position: "before" | "after";
  } | null = null;
  @state() protected sessionListRemovalDrop = false;

  protected startSidebarRouteDrag(event: DragEvent, route: SidebarNavRoute) {
    if (!event.dataTransfer) {
      return;
    }
    writeSidebarRouteDragData(event.dataTransfer, route);
    this.draggingSidebarEntry = serializeSidebarEntry({ type: "route", route });
  }

  protected startSidebarWorkboardDrag(event: DragEvent, boardId: string) {
    if (!event.dataTransfer) {
      return;
    }
    const entry = serializeSidebarEntry({ type: "workboard", boardId });
    writeSidebarRouteDragData(event.dataTransfer, entry);
    this.draggingSidebarEntry = entry;
  }

  protected finishSidebarEntryDrag() {
    this.draggingSidebarEntry = null;
    this.draggingSessionKey = null;
    this.sidebarZoneDropTarget = null;
    this.sessionListRemovalDrop = false;
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

  protected handleSidebarZoneDragOver(event: DragEvent, targetEntry?: string) {
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
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const bounds = target.getBoundingClientRect();
    this.sidebarZoneDropTarget = {
      entry: targetEntry,
      position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    };
  }

  protected handleSidebarZoneDragLeave(event: DragEvent) {
    const current = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
      return;
    }
    this.sidebarZoneDropTarget = null;
  }

  /** Insert `entry` into the freshest canonical order at the captured drop slot. */
  private writeSidebarEntryAt(
    entry: string,
    targetEntry: string | undefined,
    position: "before" | "after" | undefined,
  ) {
    const next = this.reconciledSidebarZone().sidebarEntries.filter(
      (candidate) => candidate !== entry,
    );
    const targetIndex = targetEntry ? next.indexOf(targetEntry) : -1;
    const offset = position === "after" ? 1 : 0;
    next.splice(targetIndex < 0 ? next.length : targetIndex + offset, 0, entry);
    this.onUpdateSidebarEntries?.(next);
  }

  protected handleSidebarZoneDrop(event: DragEvent, targetEntry?: string) {
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
    const session = sessionKey ? this.findSidebarSessionByKey(sessionKey) : undefined;
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
    const next = this.reconciledSidebarZone().sidebarEntries.filter(
      (candidate) => candidate !== entry,
    );
    this.onUpdateSidebarEntries?.(next);
  }

  protected handleSessionListDragOver(event: DragEvent) {
    const routeDrag = sidebarRouteDragActive(event.dataTransfer);
    const sessionKey = readSessionDragData(event.dataTransfer);
    const session = sessionKey ? this.findSidebarSessionByKey(sessionKey) : undefined;
    if (!routeDrag && !session?.pinned) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    this.sessionListRemovalDrop = true;
  }

  protected handleSessionListDragLeave(event: DragEvent) {
    const current = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))) {
      this.sessionListRemovalDrop = false;
    }
  }

  protected handleSessionListDrop(event: DragEvent) {
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
    const session = sessionKey ? this.findSidebarSessionByKey(sessionKey) : undefined;
    if (session?.pinned) {
      event.preventDefault();
      // patchSession prunes the persisted zone entry once the unpin lands.
      void this.patchSession(session, { pinned: false });
    }
    this.finishSidebarEntryDrag();
  }

  private async rememberSessionGroup(
    name: string,
    scope: SidebarSessionMutationScope,
  ): Promise<SidebarSessionMutationResult> {
    const groups = this.knownSessionGroups();
    if (groups.includes(name)) {
      return "completed";
    }
    try {
      await scope.sessions.groupsPut([...groups, name]);
      return this.isSessionMutationScopeCurrent(scope) ? "completed" : "stale";
    } catch (error) {
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      this.publishSessionMutationError(scope, error);
      return "failed";
    }
  }

  protected renameSession(session: SidebarRecentSession) {
    const nextLabel = window.prompt(t("sessionsView.renameSessionPrompt"), session.label);
    if (nextLabel === null) {
      return;
    }
    void this.patchSession(session, { label: normalizeOptionalString(nextLabel) ?? null });
  }

  protected createSessionGroup(sessions: readonly SidebarRecentSession[] = []) {
    const name = window.prompt(t("sessionsView.newGroupPrompt"))?.trim();
    if (!name) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      if ((await this.rememberSessionGroup(name, scope)) !== "completed") {
        return;
      }
      if (sessions.length > 0) {
        await this.patchSessions(sessions, { category: name }, scope);
      } else if (this.isSessionMutationScopeCurrent(scope)) {
        // Header-created groups start empty; re-render so the section shows up.
        this.requestUpdate();
      }
    })();
  }

  protected renameSessionGroupFromMenu(group: string) {
    const next = window.prompt(t("sessionsView.renameGroupPrompt"), group)?.trim();
    if (!next || next === group) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    // Collapse keys follow only a confirmed Gateway rename. A stale completion
    // must not rewrite storage owned by the replacement connection.
    void (async () => {
      try {
        const outcome = await scope.sessions.groupsRename(group, next);
        if (outcome !== "completed" || !this.isSessionMutationScopeCurrent(scope)) {
          return;
        }
        const from = `category:${group}`;
        if (this.collapsedSessionSections.has(from)) {
          const collapsed = new Set(this.collapsedSessionSections);
          collapsed.delete(from);
          collapsed.add(`category:${next}`);
          this.saveCollapsedSessionSections(collapsed);
        }
        this.requestUpdate();
      } catch (error) {
        this.publishSessionMutationError(scope, error);
      }
    })();
  }

  protected deleteSessionGroupFromMenu(group: string) {
    if (!window.confirm(t("sessionsView.deleteGroupConfirm", { group }))) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      try {
        const outcome = await scope.sessions.groupsDelete(group);
        if (outcome !== "completed" || !this.isSessionMutationScopeCurrent(scope)) {
          return;
        }
        const collapsed = new Set(this.collapsedSessionSections);
        collapsed.delete(`category:${group}`);
        this.saveCollapsedSessionSections(collapsed);
        this.requestUpdate();
      } catch (error) {
        this.publishSessionMutationError(scope, error);
      }
    })();
  }

  protected saveCollapsedSessionSections(sections: ReadonlySet<string>) {
    this.collapsedSessionSections = new Set(sections);
    try {
      storeCollapsedSessionSections(sections);
    } catch {
      // Group membership and ordering remain usable without local persistence.
    }
  }

  protected toggleSessionSection(sectionId: string) {
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
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      try {
        await scope.sessions.groupsPut(groups);
        if (this.isSessionMutationScopeCurrent(scope)) {
          this.requestUpdate();
        }
      } catch (error) {
        this.publishSessionMutationError(scope, error);
      }
    })();
  }

  protected assignSessionCategory(
    session: SidebarRecentSession,
    category: string | null,
    patch: { pinned?: boolean } = {},
  ) {
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      if (category && (await this.rememberSessionGroup(category, scope)) !== "completed") {
        return;
      }
      await this.patchSession(session, { category, ...patch }, scope);
    })();
  }

  protected handleSessionSectionDragOver(event: DragEvent, sectionId: string, category?: string) {
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
    if (!sessionDragActive(dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (dataTransfer) {
      dataTransfer.dropEffect = "move";
    }
    this.sessionDropTarget = sectionId;
    this.sessionGroupDropTarget = null;
  }

  protected handleSessionSectionDragLeave(event: DragEvent, sectionId: string, category?: string) {
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

  protected findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined {
    const navigationState = this.getSessionNavigationState();
    const active = navigationState.visibleSessions.find(
      (candidate) => candidate.key === sessionKey,
    );
    if (active) {
      return active;
    }
    for (const rows of Object.values(this.sessionRowsByAgent)) {
      const row = rows.find((candidate) => candidate.key === sessionKey);
      if (row) {
        return navigationState.toSidebarSession(row);
      }
    }
    return undefined;
  }

  protected handleSessionSectionDrop(event: DragEvent, sectionId: string, category?: string) {
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
      this.reorderSessionGroup(sourceGroup, category, position);
    } else {
      // Rows can be dragged from a browsed agent section, so search all caches.
      const session = sessionKey ? this.findSidebarSessionByKey(sessionKey) : undefined;
      if (session && sectionId === "pinned") {
        if (!session.pinned) {
          void this.patchSession(session, { pinned: true });
        }
      } else if (session) {
        const nextCategory = category ?? null;
        if (session.category !== nextCategory || session.pinned) {
          // The pinned:false leg prunes the persisted zone entry via patchSession.
          this.assignSessionCategory(
            session,
            nextCategory,
            session.pinned ? { pinned: false } : {},
          );
        }
      }
    }
    this.finishSidebarEntryDrag();
    this.draggingSessionGroup = null;
    this.sessionDropTarget = null;
    this.sessionGroupDropTarget = null;
  }

  protected setSessionsGrouping(grouping: SidebarSessionsGrouping) {
    this.sessionsGrouping = grouping;
    try {
      storeSidebarSessionsGrouping(grouping);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }

  protected setSessionsShowCron(show: boolean) {
    this.sessionsShowCron = show;
    try {
      storeSidebarSessionsShowCron(show);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }
}
