import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import {
  groupSidebarSessionRows,
  type SidebarSessionSection,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import {
  SIDEBAR_SESSION_PAGE_SIZE,
  type SidebarRecentSession,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { resolveSidebarSessionSubtitle } from "./session-row-subtitle.ts";

const SIDEBAR_CREATED_ORDER_CAP = 1_000;

type SidebarExpansionMode = "collapsed-by-user" | "expanded" | "expanded-fully";
type SidebarSubtitleParams = Parameters<typeof resolveSidebarSessionSubtitle>[0];
type SidebarSubtitleValue = ReturnType<typeof resolveSidebarSessionSubtitle>;

type SidebarProjectionInput = {
  rows: SidebarRecentSession[];
  grouping: SidebarSessionsGrouping;
  knownGroups: string[] | undefined;
  selfOwnerId?: string | null;
  catalogIds?: readonly string[];
  sectionOrder?: readonly string[];
  collapsedSections: ReadonlySet<string>;
  hideEmptyOwnerFilteredGroup: (category: string | undefined, rowCount: number) => boolean;
  visibleSessionLimits: ReadonlyMap<string, number>;
  sortMode: SidebarSessionSortMode;
  statusFilter: SidebarSessionStatusFilter;
  agentId: string;
  connectionIdentity: object | null;
  listSource: object | null;
  subtitle: {
    sidebarLiveActivity: boolean;
    showPreview: boolean;
    narrationLines: ReadonlyMap<string, string>;
    observerDigests: ReadonlyMap<string, SessionObserverDigest>;
  };
};

export type SidebarVisibleSections = {
  sections: (SidebarSessionSection<SidebarRecentSession> & {
    totalRowCount: number;
    visibleRowCount: number;
    visibleLimit: number;
    collapsedVisibleRowCount: number;
    renderHeader: boolean;
  })[];
  expandedRows: SidebarRecentSession[];
  visibleRows: SidebarRecentSession[];
};

function baselineSessionRows(rows: readonly SidebarRecentSession[], limit: number) {
  const requiredCount = rows.filter((row) => row.active || row.pinned).length;
  let optionalSlots = Math.max(0, limit - requiredCount);
  return rows.filter((row) => {
    if (row.active || row.pinned) {
      return true;
    }
    if (optionalSlots === 0) {
      return false;
    }
    optionalSlots -= 1;
    return true;
  });
}

function sidebarRunIdentity(session: SidebarRecentSession): string {
  return `${session.sessionId ?? ""}\u0000${session.activeRunIds?.join("\u0000") ?? ""}`;
}

export class SidebarSessionProjection {
  private readonly observedOrder = new Map<string, number>();
  private nextCreatedOrder = 0;
  private readonly stickySections = new Map<string, Set<string>>();
  private readonly childModes = new Map<string, SidebarExpansionMode>();
  private readonly heldSubtitles = new Map<
    string,
    { identity: string; value: SidebarSubtitleValue; catalogValue?: SidebarSubtitleValue }
  >();
  private previousInput: Pick<
    SidebarProjectionInput,
    "sortMode" | "statusFilter" | "agentId" | "connectionIdentity" | "listSource"
  > | null = null;
  private previousCollapsedSections = new Set<string>();

  get createdOrder(): ReadonlyMap<string, number> {
    return this.observedOrder;
  }

  observeRows(results: readonly { sessions: readonly { key: string }[] }[]): void {
    const retainedKeys = new Set<string>();
    for (const result of results) {
      for (const { key } of result.sessions) {
        if (!key) {
          continue;
        }
        retainedKeys.add(key);
        if (!this.observedOrder.has(key)) {
          this.observedOrder.set(key, this.nextCreatedOrder++);
        }
      }
    }
    // Paging gaps must retain their tie-break index; evict absent keys only
    // when the sidebar-lifetime registry actually exceeds its memory bound.
    if (this.observedOrder.size > SIDEBAR_CREATED_ORDER_CAP) {
      for (const key of this.observedOrder.keys()) {
        if (this.observedOrder.size <= SIDEBAR_CREATED_ORDER_CAP) {
          break;
        }
        if (!retainedKeys.has(key)) {
          this.observedOrder.delete(key);
        }
      }
    }
  }

  promoteCreatedSession(key: string): boolean {
    const currentOrder = this.observedOrder.get(key);
    if (currentOrder === 0) {
      return false;
    }
    for (const [existingKey, order] of this.observedOrder) {
      if (existingKey !== key && (currentOrder === undefined || order < currentOrder)) {
        this.observedOrder.set(existingKey, order + 1);
        this.nextCreatedOrder = Math.max(this.nextCreatedOrder, order + 2);
      }
    }
    this.observedOrder.set(key, 0);
    this.nextCreatedOrder = Math.max(this.nextCreatedOrder, 1);
    return true;
  }

  project(input: SidebarProjectionInput): SidebarVisibleSections {
    const previous = this.previousInput;
    const scopeChanged =
      previous !== null &&
      (previous.agentId !== input.agentId ||
        previous.connectionIdentity !== input.connectionIdentity ||
        previous.listSource !== input.listSource);
    if (
      scopeChanged ||
      (previous !== null &&
        (previous.sortMode !== input.sortMode || previous.statusFilter !== input.statusFilter))
    ) {
      this.resetMembership();
    }
    if (
      previous !== null &&
      (previous.agentId !== input.agentId ||
        previous.connectionIdentity !== input.connectionIdentity)
    ) {
      this.childModes.clear();
    }
    if (scopeChanged) {
      this.heldSubtitles.clear();
    }
    for (const sectionId of input.collapsedSections) {
      if (!this.previousCollapsedSections.has(sectionId)) {
        this.resetMembership(sectionId);
      }
    }
    this.previousInput = {
      sortMode: input.sortMode,
      statusFilter: input.statusFilter,
      agentId: input.agentId,
      connectionIdentity: input.connectionIdentity,
      listSource: input.listSource,
    };
    this.previousCollapsedSections = new Set(input.collapsedSections);

    const retainedKeys = new Set<string>();
    const observeTree = (session: SidebarRecentSession) => {
      retainedKeys.add(session.key);
      if (session.containsActiveDescendant && !this.childModes.has(session.key)) {
        this.childModes.set(session.key, "expanded");
      }
      this.observeSubtitle(session, input.subtitle);
      for (const child of session.children) {
        observeTree(child);
      }
    };
    input.rows.forEach(observeTree);
    for (const key of this.childModes.keys()) {
      if (!retainedKeys.has(key)) {
        this.childModes.delete(key);
      }
    }
    for (const key of this.heldSubtitles.keys()) {
      if (!retainedKeys.has(key)) {
        this.heldSubtitles.delete(key);
      }
    }

    const { grouping, knownGroups, selfOwnerId, sectionOrder, catalogIds } = input;
    const sections = groupSidebarSessionRows(input.rows, {
      grouping,
      knownGroups,
      selfOwnerId,
      sectionOrder,
      catalogIds,
    }).filter(
      (section) =>
        section.id !== "pinned" &&
        !input.hideEmptyOwnerFilteredGroup(section.category, section.rows.length),
    );
    const sectionIds = new Set<string>(sections.map((section) => section.id));
    for (const sectionId of this.stickySections.keys()) {
      if (!sectionIds.has(sectionId)) {
        this.stickySections.delete(sectionId);
      }
    }
    // A lone catch-all sits directly under the global Sessions toolbar. Empty
    // Coding does not render, while empty custom/Groups sections remain targets.
    // Headerless means no collapse control, so a stored ungrouped-collapsed
    // preference is deliberately inert here; it re-applies once a peer returns.
    const ungroupedHasPeerHeader = sections.some(
      (section) => section.id !== "ungrouped" && (section.id !== "work" || section.rows.length > 0),
    );
    const expandedRows: SidebarRecentSession[] = [];
    const visibleRows: SidebarRecentSession[] = [];
    const limitedSections: SidebarVisibleSections["sections"] = [];
    for (const section of sections) {
      // totalRowCount is the pre-pagination size: headers and empty-zone
      // checks must not mistake a page-filtered section for an empty one.
      const totalRowCount = section.rows.length;
      const renderHeader = section.id !== "ungrouped" || ungroupedHasPeerHeader;
      const collapsed = renderHeader && input.collapsedSections.has(section.id);
      const visibleLimit = input.visibleSessionLimits.get(section.id) ?? SIDEBAR_SESSION_PAGE_SIZE;
      const collapsedVisibleRowCount = baselineSessionRows(
        section.rows,
        SIDEBAR_SESSION_PAGE_SIZE,
      ).length;
      let visibleRowCount = 0;
      if (!collapsed) {
        expandedRows.push(...section.rows);
        const baselineKeys = new Set(
          baselineSessionRows(section.rows, visibleLimit).map((row) => row.key),
        );
        const sticky = this.stickySections.get(section.id) ?? new Set<string>();
        const sectionKeys = new Set(section.rows.map((row) => row.key));
        for (const key of sticky) {
          if (!sectionKeys.has(key)) {
            sticky.delete(key);
          }
        }
        // Union after normal paging keeps newly sorted rows visible without
        // evicting rows the operator already saw before a run-state transition.
        section.rows = section.rows.filter(
          (row) => baselineKeys.has(row.key) || sticky.has(row.key),
        );
        for (const row of section.rows) {
          sticky.add(row.key);
        }
        this.stickySections.set(section.id, sticky);
        visibleRows.push(...section.rows);
        visibleRowCount = section.rows.length;
      }
      limitedSections.push(
        Object.assign(section, {
          totalRowCount,
          visibleRowCount,
          visibleLimit,
          collapsedVisibleRowCount,
          renderHeader,
        }),
      );
    }
    return { sections: limitedSections, expandedRows, visibleRows };
  }

  resetMembership(sectionId?: string): void {
    if (sectionId === undefined) {
      this.stickySections.clear();
    } else {
      this.stickySections.delete(sectionId);
    }
  }

  isChildrenExpanded(key: string): boolean {
    const mode = this.childModes.get(key);
    return mode === "expanded" || mode === "expanded-fully";
  }

  isChildrenFullyShown(key: string): boolean {
    return this.childModes.get(key) === "expanded-fully";
  }

  toggleChildren(session: SidebarRecentSession): { expanded: boolean } {
    if (this.isChildrenExpanded(session.key)) {
      // The explicit closed mode prevents a still-active descendant from
      // immediately undoing the user's collapse on the next update pass.
      this.childModes.set(session.key, "collapsed-by-user");
      return { expanded: false };
    }
    this.childModes.set(session.key, "expanded");
    return { expanded: true };
  }

  showMoreChildren(key: string): void {
    if (this.isChildrenExpanded(key)) {
      this.childModes.set(key, "expanded-fully");
    }
  }

  resolveSubtitle(params: SidebarSubtitleParams): SidebarSubtitleValue {
    const fresh = resolveSidebarSessionSubtitle(params);
    if (fresh.subtitle || !params.session.hasActiveRun || !params.showPreview) {
      return fresh;
    }
    const held = this.heldSubtitles.get(params.session.key);
    if (held?.identity !== sidebarRunIdentity(params.session)) {
      return fresh;
    }
    return params.hasDisplay ? (held.catalogValue ?? fresh) : held.value;
  }

  private observeSubtitle(
    session: SidebarRecentSession,
    environment: SidebarProjectionInput["subtitle"],
  ): void {
    if (!session.hasActiveRun || !environment.showPreview) {
      this.heldSubtitles.delete(session.key);
      return;
    }
    const identity = sidebarRunIdentity(session);
    if (this.heldSubtitles.get(session.key)?.identity !== identity) {
      this.heldSubtitles.delete(session.key);
    }
    if (!environment.sidebarLiveActivity && this.heldSubtitles.get(session.key)?.value.narration) {
      this.heldSubtitles.delete(session.key);
    }
    const params = {
      session,
      hasDisplay: false,
      displaySubtitle: undefined,
      sidebarLiveActivity: environment.sidebarLiveActivity,
      showPreview: environment.showPreview,
      narrationLine: environment.narrationLines.get(session.key),
      observerDigest: environment.observerDigests.get(session.key) ?? null,
    } satisfies SidebarSubtitleParams;
    const value = resolveSidebarSessionSubtitle(params);
    if (value.subtitle) {
      const catalogValue = resolveSidebarSessionSubtitle({ ...params, hasDisplay: true });
      this.heldSubtitles.set(session.key, {
        identity,
        value,
        ...(catalogValue.subtitle ? { catalogValue } : {}),
      });
    }
  }
}
