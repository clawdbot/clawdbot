import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { resolveChatPaneDesktopTarget } from "../../pages/chat/chat-pane-placement.ts";

// Keep the chat placement dependency in this lazily loaded desktop owner, outside the boot chunk.
export async function resolveDesktopDocumentSessionTarget(
  client: Pick<GatewayBrowserClient, "request"> | null,
  sessionKey: string,
): Promise<string | null> {
  let session: GatewaySessionRow | undefined;
  // `sessions.describe` is the exact-key lookup; a paged list cannot rule out a later match.
  try {
    session =
      (
        await client?.request<{ session?: GatewaySessionRow | null }>("sessions.describe", {
          key: sessionKey,
        })
      )?.session ?? undefined;
  } catch {}
  return resolveChatPaneDesktopTarget(session);
}

type DesktopSessionHost = ReactiveControllerHost & {
  isConnected: boolean;
  client: GatewayBrowserClient | null;
  available: boolean;
  documentMode: boolean;
  requestedSource: string | null;
  sessionKey: string | null;
};

export class DesktopSessionController {
  private refreshId = 0;

  constructor(
    private readonly host: DesktopSessionHost,
    private readonly currentTarget: () => string | null,
    private readonly onTargetChange: (target: string | null) => void,
  ) {
    new SubscriptionsController(host).effect(
      () =>
        host.documentMode &&
        host.available &&
        host.sessionKey !== null &&
        host.requestedSource === null
          ? host.client
          : null,
      (client) =>
        client.addEventListener((event) => {
          const changed =
            event.event === "sessions.changed" ? readSessionChangedEvent(event.payload) : null;
          if (changed && areUiSessionKeysEquivalent(changed.key, host.sessionKey)) {
            void this.refresh();
          }
        }),
    );
  }

  invalidate(): void {
    this.refreshId += 1;
  }

  private async refresh(): Promise<void> {
    const { client, sessionKey } = this.host;
    if (!client || !sessionKey) {
      return;
    }
    const refreshId = ++this.refreshId;
    const target = await resolveDesktopDocumentSessionTarget(client, sessionKey);
    if (
      refreshId !== this.refreshId ||
      !this.host.isConnected ||
      client !== this.host.client ||
      sessionKey !== this.host.sessionKey ||
      !this.host.documentMode ||
      !this.host.available ||
      this.host.requestedSource !== null ||
      (target !== null && target === this.currentTarget())
    ) {
      return;
    }
    // Session events omit placement. Resolve it before comparing; unchanged updates keep live input.
    this.onTargetChange(target);
  }
}
