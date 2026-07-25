import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";

type GatewaySource = ApplicationContext["gateway"];
type AsyncGatewayScopeHost = ReactiveControllerHost & { readonly isConnected: boolean };

export type AsyncGatewayScope = {
  gateway: GatewaySource;
  client: GatewayBrowserClient;
  generation: number;
};

export type AsyncGatewayScopeChange = {
  sourceChanged: boolean;
  clientChanged: boolean;
  connectionChanged: boolean;
};

export class AsyncGatewayScopeController implements ReactiveController {
  gateway: GatewaySource | null = null;
  client: GatewayBrowserClient | null = null;
  connected = false;

  private generation = 0;
  private hasBoundSource = false;
  private cleanup: (() => void) | null = null;

  constructor(
    private readonly host: AsyncGatewayScopeHost,
    private readonly getGateway: () => GatewaySource | null | undefined,
    private readonly onSnapshot: (
      snapshot: ApplicationGatewaySnapshot,
      change: AsyncGatewayScopeChange,
    ) => void,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.refreshSource();
  }

  hostUpdate(): void {
    this.refreshSource();
  }

  hostDisconnected(): void {
    this.disconnectSource();
    this.invalidate();
    this.gateway = null;
    this.client = null;
    this.connected = false;
  }

  capture(): AsyncGatewayScope | null {
    if (
      !this.host.isConnected ||
      !this.connected ||
      !this.gateway ||
      !this.client ||
      this.getGateway() !== this.gateway
    ) {
      return null;
    }
    return { gateway: this.gateway, client: this.client, generation: this.generation };
  }

  isCurrent(scope: AsyncGatewayScope): boolean {
    return (
      this.host.isConnected &&
      this.connected &&
      this.gateway === scope.gateway &&
      this.getGateway() === scope.gateway &&
      this.client === scope.client &&
      this.generation === scope.generation
    );
  }

  private refreshSource(): void {
    const gateway = this.getGateway() ?? null;
    if (this.gateway === gateway) {
      return;
    }
    this.disconnectSource();
    const sourceChanged = this.hasBoundSource;
    this.hasBoundSource = true;
    this.gateway = gateway;
    this.invalidate();
    if (!gateway) {
      this.client = null;
      this.connected = false;
      return;
    }
    this.cleanup = gateway.subscribe((snapshot) => {
      if (this.gateway === gateway && this.getGateway() === gateway) {
        this.applySnapshot(snapshot, false);
      }
    });
    this.applySnapshot(gateway.snapshot, sourceChanged);
  }

  private applySnapshot(snapshot: ApplicationGatewaySnapshot, sourceChanged: boolean): void {
    const clientChanged = sourceChanged || snapshot.client !== this.client;
    const connectionChanged = (snapshot.phase === "connected") !== this.connected;
    if (clientChanged || connectionChanged) {
      this.invalidate();
    }
    this.client = snapshot.client;
    this.connected = snapshot.phase === "connected";
    this.onSnapshot(snapshot, { sourceChanged, clientChanged, connectionChanged });
    this.host.requestUpdate();
  }

  private disconnectSource(): void {
    this.cleanup?.();
    this.cleanup = null;
  }

  private invalidate(): void {
    this.generation += 1;
  }
}
