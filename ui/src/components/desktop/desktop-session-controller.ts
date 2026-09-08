import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { resolveChatPaneDesktopTarget } from "../../pages/chat/chat-pane-placement.ts";

// Keep the chat placement dependency in this lazily loaded desktop owner, outside the boot chunk.
async function resolveDesktopDocumentSessionTarget(
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

type TargetReceiver = (target: string | null) => void | Promise<void>;

export class DesktopSessionController {
  private refreshId = 0;

  constructor(
    private readonly host: DesktopSessionHost,
    private readonly currentTarget: () => string | null,
    private readonly onTargetChange: (target: string | null) => void,
    private readonly onInventoryChange: () => void,
  ) {
    new SubscriptionsController(host).effect(
      () => (host.available ? host.client : null),
      (client) =>
        client.addEventListener((event) => {
          if (!host.isConnected || !host.available || client !== host.client) {
            return;
          }
          if (
            event.event === "presence" ||
            event.event === "node.pair.resolved" ||
            event.event === "node.runnerInventory.changed"
          ) {
            this.onInventoryChange();
            return;
          }
          const changed =
            host.documentMode &&
            host.sessionKey !== null &&
            host.requestedSource === null &&
            event.event === "sessions.changed"
              ? readSessionChangedEvent(event.payload)
              : null;
          if (changed && areUiSessionKeysEquivalent(changed.key, host.sessionKey)) {
            void this.resolveTarget((target) => {
              // Session events omit placement; unchanged updates must keep live input.
              if (target === null || target !== this.currentTarget()) {
                this.onTargetChange(target);
              }
            });
          }
        }),
    );
  }

  invalidate(): void {
    this.refreshId += 1;
  }

  async resolveInventoryTarget(
    environments: readonly Pick<EnvironmentSummary, "id">[],
    onTarget: TargetReceiver,
    resolvedSessionTarget?: string | null,
  ): Promise<void> {
    const select = (target: string | null) =>
      onTarget(environments.some((environment) => environment.id === target) ? target : null);
    const target = this.host.requestedSource ?? resolvedSessionTarget;
    // Embedded presenters receive the chat owner's placement instead of rediscovering it.
    if (target === undefined && this.host.documentMode && this.host.sessionKey !== null) {
      return this.resolveTarget(select);
    }
    return select(target ?? null);
  }

  private async resolveTarget(onTarget: TargetReceiver): Promise<void> {
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
      this.host.requestedSource !== null
    ) {
      return;
    }
    // Accept in this continuation so a newer lookup cannot interleave after the generation check.
    return onTarget(target);
  }
}
