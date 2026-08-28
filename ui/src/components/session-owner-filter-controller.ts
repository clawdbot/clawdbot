import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { SessionCapability } from "../lib/sessions/index.ts";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";

type SessionOwnerFilterContext = {
  gateway: {
    connection: { gatewayUrl: string };
    snapshot: { selfUser?: { id: string } | null };
  };
  sessions: Pick<
    SessionCapability,
    "canonicalListRevision" | "setInvolvingMeFilter" | "setOwnerFilter"
  >;
};

type PendingFacetRefresh = {
  revision: number;
  scope: string;
  settled: boolean;
};

export class SessionOwnerFilterController implements ReactiveController {
  ownerId: string | null = null;
  involvingMe = false;
  private scope: string | null = null;
  private ownerFacetResolved = false;
  private ownerOptions: readonly { id: string }[] = [];
  private pendingFacetRefresh: PendingFacetRefresh | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getContext: () => SessionOwnerFilterContext | undefined,
  ) {
    host.addController(this);
  }

  hostUpdated(): void {
    this.restore();
    const pending = this.pendingFacetRefresh;
    const context = this.getContext();
    if (
      pending?.settled &&
      pending.scope === this.scope &&
      context &&
      context.sessions.canonicalListRevision > pending.revision
    ) {
      this.pendingFacetRefresh = null;
      this.host.requestUpdate();
      return;
    }
    if (pending) {
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
    if (previousScope === null && (this.ownerId || this.involvingMe)) {
      storeSidebarSessionOwnerFilter(gatewayUrl, selfUserId, this.currentFilter());
    } else {
      const stored = loadStoredSidebarSessionOwnerFilter(gatewayUrl, selfUserId);
      this.ownerId = stored.ownerId;
      this.involvingMe = stored.involvingMe;
    }
    this.host.requestUpdate();
    if (previousScope !== null || this.ownerId || this.involvingMe) {
      const pending = {
        revision: context.sessions.canonicalListRevision,
        scope: nextScope,
        settled: false,
      };
      this.pendingFacetRefresh = pending;
      this.ownerFacetResolved = false;
      this.ownerOptions = [];
      void this.applyRequest().finally(() => {
        if (this.pendingFacetRefresh === pending) {
          pending.settled = true;
          this.host.requestUpdate();
        }
      });
    }
  }

  private currentFilter() {
    return { ownerId: this.ownerId, involvingMe: this.involvingMe };
  }

  private applyRequest(): Promise<void> {
    const sessions = this.getContext()?.sessions;
    if (!sessions) {
      return Promise.resolve();
    }
    return this.involvingMe
      ? sessions.setInvolvingMeFilter(true)
      : sessions.setOwnerFilter(this.ownerId);
  }
}
