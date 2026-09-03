import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";

type SessionOwnerFilterContext = {
  gateway: {
    connection: { gatewayUrl: string };
    snapshot: { selfUser?: { id: string } | null };
  };
};

export class SessionOwnerFilterController implements ReactiveController {
  ownerId: string | null = null;
  involvingMe = false;
  private scope: string | null = null;
  private ownerFacetResolved = false;
  private ownerOptions: readonly { id: string }[] = [];
  private pendingFacetRefresh: Promise<void> | null = null;

  constructor(
    private readonly host: ReactiveControllerHost & {
      sessionData: { resetSessionList(): void; refreshSidebarSessions(): Promise<void> };
    },
    private readonly getContext: () => SessionOwnerFilterContext | undefined,
  ) {
    host.addController(this);
  }

  hostUpdated(): void {
    this.restore();
    if (this.pendingFacetRefresh) {
      return;
    }
    if (
      this.ownerFacetResolved &&
      this.ownerId &&
      !this.ownerOptions.some((owner) => owner.id === this.ownerId)
    ) {
      this.set(null);
    }
  }

  observeOwnerFacet(resolved: boolean, options: readonly { id: string }[]): void {
    if (this.pendingFacetRefresh) {
      return;
    }
    this.ownerFacetResolved = resolved;
    this.ownerOptions = options;
  }

  set(ownerId: string | null, involvingMe = false): void {
    this.pendingFacetRefresh = null;
    this.ownerId = involvingMe ? null : ownerId?.trim() || null;
    this.involvingMe = involvingMe;
    const context = this.getContext();
    const selfUserId = context?.gateway.snapshot.selfUser?.id.trim();
    if (context && selfUserId) {
      storeSidebarSessionOwnerFilter(
        context.gateway.connection.gatewayUrl,
        selfUserId,
        this.currentFilter(),
      );
    }
    this.host.requestUpdate();
    void this.refresh();
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
    if (previousScope === null && (this.ownerId || this.involvingMe)) {
      storeSidebarSessionOwnerFilter(gatewayUrl, selfUserId, this.currentFilter());
    } else {
      const stored = loadStoredSidebarSessionOwnerFilter(gatewayUrl, selfUserId);
      this.ownerId = stored.ownerId;
      this.involvingMe = stored.involvingMe;
    }
    this.host.requestUpdate();
    if (previousScope !== null || this.ownerId || this.involvingMe) {
      this.ownerFacetResolved = false;
      this.ownerOptions = [];
      const pending = this.refresh();
      this.pendingFacetRefresh = pending;
      void pending.finally(() => {
        if (this.pendingFacetRefresh === pending) {
          this.pendingFacetRefresh = null;
          this.host.requestUpdate();
        }
      });
    }
  }

  private refresh(): Promise<void> {
    this.host.sessionData.resetSessionList();
    return this.host.sessionData.refreshSidebarSessions();
  }

  private currentFilter() {
    return { ownerId: this.ownerId, involvingMe: this.involvingMe };
  }
}
