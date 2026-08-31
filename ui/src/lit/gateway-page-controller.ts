import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import {
  createGatewayConnectionLifecycle,
  type GatewayConnectionScope,
} from "../lib/gateway-connection-lifecycle.ts";
import { SubscriptionsController } from "./subscriptions-controller.ts";

export type GatewayPageChange = {
  readonly snapshot: ApplicationGatewaySnapshot;
  readonly initial: boolean;
  readonly sourceChanged: boolean;
  readonly clientChanged: boolean;
  readonly connectionChanged: boolean;
  readonly identityChanged: boolean;
  readonly becameConnected: boolean;
};

type GatewayPageControllerOptions = {
  getGateway: () => ApplicationContext["gateway"] | null | undefined;
  onIdentityChange?: (change: GatewayPageChange) => void;
  invalidateRequests?: (change: GatewayPageChange) => void;
  ensureInitialData?: () => void;
  onSnapshot?: (change: GatewayPageChange) => void;
  onPageActivation?: () => void;
};

type GatewayRouteDataIdentity = {
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
};

/**
 * Owns a page's Gateway binding and request epoch. Source replacement and
 * same-client reconnects share one request boundary, so stale work cannot survive either.
 */
export class GatewayPageController implements ReactiveController {
  private readonly lifecycle = createGatewayConnectionLifecycle({
    client: null,
    phase: "stopped",
  });
  private readonly subscriptions: SubscriptionsController;
  private currentGateway: ApplicationContext["gateway"] | null = null;
  private currentSnapshot: ApplicationGatewaySnapshot | null = null;
  private currentClient: GatewayBrowserClient | null = null;
  private currentConnected = false;
  private hasBoundGateway = false;

  private readonly handlePageActivation = () => {
    this.options.onPageActivation?.();
  };

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: GatewayPageControllerOptions,
  ) {
    this.subscriptions = new SubscriptionsController(host).effect(options.getGateway, (gateway) => {
      const initial = !this.hasBoundGateway;
      const sourceChanged = this.hasBoundGateway && this.currentGateway !== gateway;
      this.hasBoundGateway = true;
      this.currentGateway = gateway;
      this.applySnapshot(gateway.snapshot, { initial, sourceChanged });
      const unsubscribe = gateway.subscribe((snapshot) => {
        if (this.currentGateway === gateway && this.options.getGateway() === gateway) {
          this.applySnapshot(snapshot, { initial: false, sourceChanged: false });
        }
      });
      return () => unsubscribe();
    });
    // Register after subscriptions so source cleanup happens before the
    // synthetic stopped transition on disconnect.
    host.addController(this);
  }

  get gateway(): ApplicationContext["gateway"] | null {
    return this.currentGateway;
  }

  get snapshot(): ApplicationGatewaySnapshot | null {
    return this.currentSnapshot;
  }

  get client(): GatewayBrowserClient | null {
    return this.currentClient;
  }

  get connected(): boolean {
    return this.currentConnected;
  }

  get epoch(): number {
    return this.lifecycle.epoch;
  }

  capture(): GatewayConnectionScope | null {
    return this.lifecycle.capture();
  }

  isCurrent(scope: GatewayConnectionScope): boolean {
    return this.lifecycle.isCurrent(scope);
  }

  invalidate(): void {
    this.lifecycle.invalidate();
  }

  isRouteDataCurrent(data: GatewayRouteDataIdentity): boolean {
    const gateway = this.options.getGateway();
    if (!gateway || data.gateway !== gateway) {
      return false;
    }
    const current = gateway.snapshot;
    if (data.gatewaySnapshot === current) {
      return true;
    }
    // Recovery-scope and shell metadata can clone a connected snapshot. The hello object
    // identifies its transport epoch; accepting another hello would revive stale route work.
    return (
      data.gatewaySnapshot.phase === "connected" &&
      current.phase === "connected" &&
      data.gatewaySnapshot.client === current.client &&
      data.gatewaySnapshot.hello !== null &&
      data.gatewaySnapshot.hello === current.hello
    );
  }

  hostConnected(): void {
    if (this.options.onPageActivation) {
      document.addEventListener("visibilitychange", this.handlePageActivation);
      globalThis.addEventListener("focus", this.handlePageActivation);
    }
  }

  hostDisconnected(): void {
    if (this.options.onPageActivation) {
      document.removeEventListener("visibilitychange", this.handlePageActivation);
      globalThis.removeEventListener("focus", this.handlePageActivation);
    }
    this.subscriptions.clear();
    const previous = this.currentSnapshot;
    this.currentGateway = null;
    if (previous) {
      const stopped = { ...previous, client: null, phase: "stopped" } as const;
      const lifecycleChanged = this.lifecycle.transition(stopped);
      const clientChanged = this.currentClient !== null;
      const connectionChanged = this.currentConnected;
      this.currentSnapshot = null;
      this.currentClient = null;
      this.currentConnected = false;
      if (lifecycleChanged) {
        this.options.invalidateRequests?.({
          snapshot: stopped,
          initial: false,
          sourceChanged: false,
          clientChanged,
          connectionChanged,
          identityChanged: false,
          becameConnected: false,
        });
      }
    } else {
      this.lifecycle.invalidate();
    }
    this.host.requestUpdate();
  }

  private applySnapshot(
    snapshot: ApplicationGatewaySnapshot,
    binding: { initial: boolean; sourceChanged: boolean },
  ): void {
    const previousClient = this.currentClient;
    const previousConnected = this.currentConnected;
    const nextConnected = snapshot.phase === "connected";
    const clientChanged = previousClient !== snapshot.client;
    const connectionChanged = previousConnected !== nextConnected;
    const lifecycleChanged = this.lifecycle.transition(snapshot);
    if (binding.sourceChanged && !lifecycleChanged) {
      // Provider ownership can change while reusing the same client and phase.
      this.lifecycle.invalidate();
    }
    this.currentSnapshot = snapshot;
    this.currentClient = snapshot.client;
    this.currentConnected = nextConnected;
    const change: GatewayPageChange = {
      snapshot,
      initial: binding.initial,
      sourceChanged: binding.sourceChanged,
      clientChanged,
      connectionChanged,
      identityChanged: !binding.initial && (binding.sourceChanged || clientChanged),
      becameConnected: nextConnected && !previousConnected,
    };
    if (change.identityChanged) {
      this.options.onIdentityChange?.(change);
    }
    if (!binding.initial && (lifecycleChanged || binding.sourceChanged)) {
      this.options.invalidateRequests?.(change);
    }
    this.options.onSnapshot?.(change);
    if (nextConnected && (binding.initial || change.identityChanged || change.connectionChanged)) {
      this.options.ensureInitialData?.();
    }
    this.host.requestUpdate();
  }
}
