import type { ProgressCard, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../lib/session-progress-cards.ts";

type SessionProgressCardControllerOptions = {
  gateway: () => ApplicationGateway | null | undefined;
  target: () => ProgressCardGetParams | null | undefined;
};

/** Keeps one chat pane on the gateway-scoped durable progress-card snapshot. */
export class SessionProgressCardController implements ReactiveController {
  private store: SessionProgressCardStore | null = null;
  private stopUpdates: (() => void) | null = null;
  private target: ProgressCardGetParams | undefined;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: SessionProgressCardControllerOptions,
  ) {
    host.addController(this);
  }

  get card(): ProgressCard | null {
    return this.target ? (this.store?.get(this.target) ?? null) : null;
  }

  get error() {
    return this.target ? this.store?.getError(this.target) : undefined;
  }

  dismiss = (card: ProgressCard): Promise<boolean> =>
    this.target
      ? (this.store?.dismiss(this.target, card) ?? Promise.resolve(false))
      : Promise.resolve(false);

  hostUpdate(): void {
    this.synchronize();
  }

  hostDisconnected(): void {
    this.release();
  }

  private synchronize(): void {
    const gateway = this.options.gateway() ?? null;
    const target = this.options.target() ?? undefined;
    const nextStore = gateway ? sessionProgressCardsForGateway(gateway) : null;
    if (nextStore !== this.store) {
      this.release();
      this.store = nextStore;
      this.stopUpdates = nextStore?.subscribe(() => this.host.requestUpdate()) ?? null;
    }
    if (
      target?.sessionKey === this.target?.sessionKey &&
      target?.agentId === this.target?.agentId
    ) {
      return;
    }
    this.target = target;
    this.store?.watch(this, target ? [target] : []);
  }

  private release(): void {
    this.store?.unwatch(this);
    this.stopUpdates?.();
    this.stopUpdates = null;
    this.store = null;
    this.target = undefined;
  }
}
