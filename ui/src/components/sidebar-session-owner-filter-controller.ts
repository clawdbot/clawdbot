import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { applySidebarSessionOwnerFilter } from "./app-sidebar-session-navigation-logic.ts";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
  type SidebarRecentSession,
  type SidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";

/** Browser-persisted owner selection and its Gateway query lifecycle. */
export class SidebarSessionOwnerFilterController implements ReactiveController {
  ownerOptions: readonly SessionOwnerOption[] = [];
  activeOwnerId: string | null = null;
  ownershipVisible = false;

  private filter = loadStoredSidebarSessionOwnerFilter();
  private source: SessionCapability | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly context: () => ApplicationContext<RouteId> | undefined,
  ) {
    host.addController(this);
  }

  get ownerId(): string | null {
    return this.filter.startsWith("owner:") ? this.filter.slice("owner:".length) : null;
  }

  get involvingMe(): boolean {
    return this.filter === "involving-me";
  }

  get active(): boolean {
    return this.filter !== "all";
  }

  hostUpdated(): void {
    const context = this.context();
    if (
      !context ||
      context.gateway.snapshot.phase !== "connected" ||
      context.sessions === this.source
    ) {
      return;
    }
    this.source = context.sessions;
    if (this.active) {
      this.applyToGateway();
    }
  }

  set(ownerId: string | null, involvingMe = false): void {
    const next: SidebarSessionOwnerFilter = involvingMe
      ? "involving-me"
      : ownerId
        ? `owner:${ownerId}`
        : "all";
    if (next === this.filter) {
      return;
    }
    this.filter = storeSidebarSessionOwnerFilter(next);
    this.applyToGateway();
    this.host.requestUpdate();
  }

  project(
    rows: SidebarRecentSession[],
    owners: SessionsListResult["owners"],
    self?: { id: string; name?: string; avatarUrl?: string } | null,
  ): SidebarRecentSession[] {
    const result = applySidebarSessionOwnerFilter({
      projected: rows,
      ownerFacet: owners,
      selectedOwnerId: this.ownerId,
      self,
    });
    this.ownerOptions = result.ownerOptions;
    this.ownershipVisible = result.ownershipVisible;
    this.activeOwnerId = result.activeOwnerId;
    return result.rows;
  }

  private applyToGateway(): void {
    const sessions = this.context()?.sessions;
    if (!sessions) {
      return;
    }
    void (this.involvingMe
      ? sessions.setInvolvingMeFilter(true)
      : sessions.setOwnerFilter(this.ownerId));
  }
}
