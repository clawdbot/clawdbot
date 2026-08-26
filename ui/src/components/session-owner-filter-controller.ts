import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
  type SidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";

type SessionOwnerFilterControllerHost = ReactiveControllerHost;

export class SessionOwnerFilterController implements ReactiveController {
  private filter: SidebarSessionOwnerFilter = { kind: "all" };
  private scope: string | null = null;

  constructor(
    private readonly host: SessionOwnerFilterControllerHost,
    private readonly getContext: () => ApplicationContext<RouteId> | undefined,
  ) {
    host.addController(this);
  }

  get ownerId(): string | null {
    return this.filter.kind === "owner" ? this.filter.ownerId : null;
  }

  get involvingMe(): boolean {
    return this.filter.kind === "involving-me";
  }

  get ownerActive(): boolean {
    return this.filter.kind === "owner";
  }

  hostUpdated(): void {
    this.restore();
  }

  set(ownerId: string | null, involvingMe = false): void {
    const normalizedOwnerId = ownerId?.trim() ?? "";
    this.filter = involvingMe
      ? { kind: "involving-me" }
      : normalizedOwnerId
        ? { kind: "owner", ownerId: normalizedOwnerId }
        : { kind: "all" };
    const context = this.getContext();
    const selfUserId = context?.gateway.snapshot.selfUser?.id.trim();
    if (context && selfUserId) {
      storeSidebarSessionOwnerFilter(
        context.gateway.connection.gatewayUrl,
        selfUserId,
        this.filter,
      );
    }
    this.host.requestUpdate();
    void this.applyRequest();
  }

  private restore(): void {
    const context = this.getContext();
    const selfUserId = context?.gateway.snapshot.selfUser?.id.trim();
    if (!context || !selfUserId) {
      return;
    }
    const gatewayUrl = context.gateway.connection.gatewayUrl;
    const nextScope = `${gatewayUrl}\0${selfUserId}`;
    if (nextScope === this.scope) {
      return;
    }
    const previousScope = this.scope;
    this.scope = nextScope;
    if (previousScope === null && this.filter.kind !== "all") {
      storeSidebarSessionOwnerFilter(gatewayUrl, selfUserId, this.filter);
    } else {
      this.filter = loadStoredSidebarSessionOwnerFilter(gatewayUrl, selfUserId);
    }
    this.host.requestUpdate();
    if (previousScope !== null || this.filter.kind !== "all") {
      void this.applyRequest();
    }
  }

  private applyRequest(): Promise<void> {
    const sessions = this.getContext()?.sessions;
    if (!sessions) {
      return Promise.resolve();
    }
    return this.filter.kind === "involving-me"
      ? sessions.setInvolvingMeFilter(true)
      : sessions.setOwnerFilter(this.filter.kind === "owner" ? this.filter.ownerId : null);
  }
}
