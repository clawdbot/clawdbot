import type { ApplicationGateway } from "../../app/gateway.ts";
import { sessionViewerPresenceForGateway } from "../../lib/session-viewer-presence.ts";

/** Moves a mounted chat page's viewer declaration between gateway lifecycles. */
export class ChatViewerPresenceController {
  private gateway: ApplicationGateway | null = null;

  constructor(private readonly owner: object) {}

  sync(gateway: ApplicationGateway | undefined, sessionKeys: readonly string[]) {
    const nextGateway = gateway && typeof gateway.subscribe === "function" ? gateway : null;
    if (this.gateway && this.gateway !== nextGateway) {
      sessionViewerPresenceForGateway(this.gateway).unwatch(this.owner);
    }
    this.gateway = nextGateway;
    if (nextGateway) {
      sessionViewerPresenceForGateway(nextGateway).watch(this.owner, sessionKeys);
    }
  }

  dispose() {
    if (this.gateway) {
      sessionViewerPresenceForGateway(this.gateway).unwatch(this.owner);
      this.gateway = null;
    }
  }
}
