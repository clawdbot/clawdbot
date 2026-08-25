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
import { sessionAttentionSubtitle } from "./session-attention-presentation.ts";
import { resolveSidebarSessionSubtitle } from "./session-row-subtitle.ts";

const SIDEBAR_CREATED_ORDER_CAP = 1_000;
// Ambient subtitle sources (observer digest, narration, work path) race at
// event rate; without a floor the line swaps A->B->A within a second. Matches
// the narration throttle so replacement cadence stays consistent.
const SIDEBAR_SUBTITLE_MIN_DISPLAY_MS = 2_000;

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

/** Attention, agent-declared status, and the queued explanation are messages
 * the operator must act on; they replace a held subtitle immediately. */
function isOperatorCriticalSubtitle(session: SidebarRecentSession): boolean {
  return Boolean(
    sessionAttentionSubtitle(session.attention) ||
    session.agentStatusNote ||
    (session.hasActiveRun && session.status === "queued"),
  );
}

export class SidebarSessionProjection {
  constructor(private readonly now: () => number = () => Date.now()) {}

  private readonly observedOrder = new Map<string, number>();
  private nextCreatedOrder = 0;
  private readonly stickySections = new Map<string, Set<string>>();
  private readonly childModes = new Map<string, SidebarExpansionMode>();
  private readonly heldSubtitles = new Map<
    string,
    { value: SidebarSubtitleValue; catalogValue?: SidebarSubtitleValue; shownAt: number }
  >();
  private previousInput: Pick<
    SidebarProjectionInput,
    "grouping" | "sortMode" | "statusFilter" | "agentId" | "connectionIdentity" | "listSource"
  > | null = null;
  private previousCollapsedSections = new Set<string>();

  get createdOrder(): ReadonlyMap<string, number> {
    return this.observedOrder;
  }

  observeRows(results: readonly { sessions: readonly { key: string }[] }[]): void {
    for (const result of results) {
      for (const { key } of result.sessions) {
        if (key && !this.observedOrder.has(key)) {
          this.observedOrder.set(key, this.nextCreatedOrder++);
        }
      }
    }
    // Paging gaps must retain their tie-break index; evict absent keys only
    // when the sidebar-lifetime registry actually exceeds its memory bound.
    if (this.observedOrder.size <= SIDEBAR_CREATED_ORDER_CAP) {
      return;
    }
    const retainedKeys = new Set(
      results.flatMap((result) => result.sessions.map(({ key }) => key)),
    );
    for (const key of this.observedOrder.keys()) {
      if (this.observedOrder.size <= SIDEBAR_CREATED_ORDER_CAP) {
        break;
      }
      if (!retainedKeys.has(key)) {
        this.observedOrder.delete(key);
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
        // Grouping changes can re-emit the same section id (e.g. ungrouped)
        // with a different row population; stale sticky keys must not carry over.
        (previous.grouping !== input.grouping ||
          previous.sortMode !== input.sortMode ||
          previous.statusFilter !== input.statusFilter))
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
      grouping: input.grouping,
      sortMode: input.sortMode,
      statusFilter: input.statusFilter,
      agentId: input.agentId,
      connectionIdentity: input.connectionIdentity,
      listSource: input.listSource,
    };
    this.previousCollapsedSections = new Set(input.collapsedSections);

    const staleKeys = new Set([...this.childModes.keys(), ...this.heldSubtitles.keys()]);
    const observeTree = (session: SidebarRecentSession) => {
      staleKeys.delete(session.key);
      if (session.containsActiveDescendant && !this.childModes.has(session.key)) {
        this.childModes.set(session.key, "expanded");
      }
      this.observeSubtitle(session, input.subtitle);
      for (const child of session.children) {
        observeTree(child);
      }
    };
    input.rows.forEach(observeTree);
    for (const key of staleKeys) {
      this.childModes.delete(key);
      this.heldSubtitles.delete(key);
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
      const requiredRowCount = section.rows.reduce(
        (count, row) => count + Number(row.active || row.pinned),
        0,
      );
      const collapsedVisibleRowCount = Math.max(
        requiredRowCount,
        Math.min(totalRowCount, SIDEBAR_SESSION_PAGE_SIZE),
      );
      let visibleRowCount = 0;
      if (!collapsed) {
        expandedRows.push(...section.rows);
        let optionalSlots = Math.max(0, visibleLimit - requiredRowCount);
        const sticky = this.stickySections.get(section.id);
        // Union after normal paging keeps newly sorted rows visible without
        // evicting rows the operator already saw before a run-state transition.
        section.rows = section.rows.filter((row) => {
          if (row.active || row.pinned) {
            return true;
          }
          if (optionalSlots > 0) {
            optionalSlots -= 1;
            return true;
          }
          return sticky?.has(row.key) === true;
        });
        this.stickySections.set(section.id, new Set(section.rows.map((row) => row.key)));
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
    if (!params.session.hasActiveRun || !params.showPreview) {
      return resolveSidebarSessionSubtitle(params);
    }
    // While a run is live the held value is the display: observeSubtitle
    // refreshed it this update pass, applying the minimum-display floor.
    const held = this.heldSubtitles.get(params.session.key);
    if (!held) {
      return resolveSidebarSessionSubtitle(params);
    }
    return params.hasDisplay
      ? (held.catalogValue ?? resolveSidebarSessionSubtitle(params))
      : held.value;
  }

  private observeSubtitle(
    session: SidebarRecentSession,
    environment: SidebarProjectionInput["subtitle"],
  ): void {
    if (!session.hasActiveRun || !environment.showPreview) {
      this.heldSubtitles.delete(session.key);
      return;
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
    if (!value.subtitle) {
      // Transient gaps between event updates keep the last shown line; the
      // hold dies with the run (the hasActiveRun branch above).
      return;
    }
    const held = this.heldSubtitles.get(session.key);
    const now = this.now();
    const replacing = held !== undefined && held.value.subtitle !== value.subtitle;
    if (
      replacing &&
      now - held.shownAt < SIDEBAR_SUBTITLE_MIN_DISPLAY_MS &&
      !isOperatorCriticalSubtitle(session)
    ) {
      return;
    }
    const catalogValue = resolveSidebarSessionSubtitle({ ...params, hasDisplay: true });
    this.heldSubtitles.set(session.key, {
      value,
      ...(catalogValue.subtitle ? { catalogValue } : {}),
      shownAt: held !== undefined && !replacing ? held.shownAt : now,
    });
  }
}
