import type { ApplicationGateway } from "../../app/gateway.ts";
import { sessionViewerPresenceForGateway } from "../../lib/session-viewer-presence.ts";
import { visiblePanesOf, type ChatSplitLayout } from "./split-layout.ts";

/** Moves a mounted chat page's viewer declaration between gateway lifecycles. */
export class ChatViewerPresenceController {
  private gateway: ApplicationGateway | null = null;

  constructor(private readonly owner: object) {}

  sync(gateway: ApplicationGateway | undefined, layout: ChatSplitLayout, narrow: boolean) {
    const nextGateway = gateway && typeof gateway.subscribe === "function" ? gateway : null;
    if (this.gateway && this.gateway !== nextGateway) {
      sessionViewerPresenceForGateway(this.gateway).unwatch(this.owner);
    }
    this.gateway = nextGateway;
    if (nextGateway) {
      sessionViewerPresenceForGateway(nextGateway).watch(
        this.owner,
        visiblePanesOf(layout, narrow).map((pane) => pane.sessionKey),
      );
    }
  }

  dispose() {
    if (this.gateway) {
      sessionViewerPresenceForGateway(this.gateway).unwatch(this.owner);
      this.gateway = null;
    }
  }
}
