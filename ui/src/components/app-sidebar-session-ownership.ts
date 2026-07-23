import { state } from "lit/decorators.js";
import { AppSidebarSessionProjectionElement } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { listSessionCreators, type SessionCreatedBy } from "./session-owner-chip.ts";

/** Creator attribution, solo dormancy, and filtering shared by sidebar session surfaces. */
export abstract class AppSidebarSessionOwnershipElement extends AppSidebarSessionProjectionElement {
  @state() protected sessionCreatorFilterId: string | null = null;

  protected sessionCreatorOptions: readonly SessionCreatedBy[] = [];
  protected activeSessionCreatorId: string | null = null;
  protected sessionCreatorFilterActive = false;
  sessionOwnershipVisible = false;

  override updated() {
    super.updated();
    const selectedId = this.sessionCreatorFilterId;
    const creators = this.sessionsResult?.creators;
    if (
      selectedId &&
      creators &&
      (creators.length < 2 || !creators.some((creator) => creator.id === selectedId))
    ) {
      this.sessionCreatorFilterId = null;
      void this.context?.sessions.setCreatorFilter(null);
    }
  }

  protected applySessionCreatorFilter(
    projected: readonly SidebarRecentSession[],
    creatorRows: readonly { createdBy?: SessionCreatedBy }[] = [],
    creatorFacet?: readonly SessionCreatedBy[],
  ): SidebarRecentSession[] {
    const flattened: SidebarRecentSession[] = [];
    const pending = [...projected];
    while (pending.length > 0) {
      const row = pending.shift();
      if (row) {
        flattened.push(row);
        pending.push(...row.children);
      }
    }
    const completeFacet = creatorFacet ?? this.sessionsResult?.creators;
    this.sessionCreatorOptions = listSessionCreators([
      ...(completeFacet ?? []).map((createdBy) => ({ createdBy })),
      ...flattened,
      ...creatorRows,
    ]);
    this.sessionOwnershipVisible = this.sessionCreatorOptions.length >= 2;
    const creatorId = this.sessionOwnershipVisible
      ? this.sessionCreatorOptions.some((creator) => creator.id === this.sessionCreatorFilterId)
        ? this.sessionCreatorFilterId
        : null
      : null;
    this.sessionCreatorFilterActive = creatorId !== null;
    this.activeSessionCreatorId = creatorId;
    if (!creatorId) {
      return [...projected];
    }
    const filterTree = (treeRows: readonly SidebarRecentSession[]): SidebarRecentSession[] => {
      const filtered: SidebarRecentSession[] = [];
      for (const row of treeRows) {
        const children = filterTree(row.children);
        if (row.createdBy?.id === creatorId) {
          filtered.push({ ...row, children });
        } else {
          for (const child of children) {
            filtered.push({ ...child, isChild: false });
          }
        }
      }
      return filtered;
    };
    return filterTree(projected);
  }

  protected hideEmptyCreatorFilteredGroup(category: string | undefined, rowCount: number): boolean {
    return this.sessionCreatorFilterActive && Boolean(category) && rowCount === 0;
  }
}
