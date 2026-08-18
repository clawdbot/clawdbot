import type { ProgressCard } from "@openclaw/gateway-protocol";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../lib/session-progress-cards.ts";

type SessionProgressCardControllerOptions = {
  gateway: () => ApplicationGateway | null | undefined;
  sessionKey: () => string | null | undefined;
};

/** Keeps one chat pane on the gateway-scoped durable progress-card snapshot. */
export class SessionProgressCardController implements ReactiveController {
  private store: SessionProgressCardStore | null = null;
  private stopUpdates: (() => void) | null = null;
  private sessionKey = "";

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: SessionProgressCardControllerOptions,
  ) {
    host.addController(this);
  }

  get card(): ProgressCard | null {
    return this.store?.get(this.sessionKey) ?? null;
  }

  hostUpdate(): void {
    this.synchronize();
  }

  hostDisconnected(): void {
    this.release();
  }

  private synchronize(): void {
    const gateway = this.options.gateway() ?? null;
    const sessionKey = this.options.sessionKey()?.trim() ?? "";
    const nextStore = gateway ? sessionProgressCardsForGateway(gateway) : null;
    if (nextStore !== this.store) {
      this.release();
      this.store = nextStore;
      this.stopUpdates = nextStore?.subscribe(() => this.host.requestUpdate()) ?? null;
    }
    if (sessionKey === this.sessionKey) {
      return;
    }
    this.sessionKey = sessionKey;
    this.store?.watch(this, sessionKey ? [sessionKey] : []);
  }

  private release(): void {
    this.store?.unwatch(this);
    this.stopUpdates?.();
    this.stopUpdates = null;
    this.store = null;
    this.sessionKey = "";
  }
}
