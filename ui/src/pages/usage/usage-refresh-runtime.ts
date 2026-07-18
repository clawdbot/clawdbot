import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { decideUsageRefresh, type UsageRefreshReason } from "./refresh-policy.ts";

type UsageRefreshRuntimeOptions = {
  getGateway: () => ApplicationContext["gateway"] | null | undefined;
  isLoading: () => boolean;
  isRouteDataInitialized: () => boolean;
  ensureAgents: () => void;
  invalidateRequests: () => void;
  resetForClientChange: () => void;
  reload: () => void;
};

export class UsageRefreshRuntime {
  private currentClient: GatewayBrowserClient | null = null;
  private currentConnected = false;
  private lastLoadedAtMs: number | null = null;
  private pendingAutomaticRefresh = false;
  // Disconnects invalidate active work; keep this set until policy permits a
  // visible-page retry, even while the prior payload remains fresh.
  private reloadPending = false;
  private hasBoundGatewaySource = false;
  private readonly subscriptions: SubscriptionsController;

  private readonly handlePageActivation = () => {
    this.request("focus");
  };

  constructor(
    host: ReactiveControllerHost,
    private readonly options: UsageRefreshRuntimeOptions,
  ) {
    this.subscriptions = new SubscriptionsController(host).effect(options.getGateway, (gateway) => {
      const resetForSourceBind = this.hasBoundGatewaySource;
      this.hasBoundGatewaySource = true;
      const cleanup = gateway.subscribe((snapshot) => this.applyGatewaySnapshot(snapshot, false));
      this.applyGatewaySnapshot(gateway.snapshot, resetForSourceBind);
      return cleanup;
    });
  }

  get client(): GatewayBrowserClient | null {
    return this.currentClient;
  }

  get connected(): boolean {
    return this.currentConnected;
  }

  connect(): void {
    document.addEventListener("visibilitychange", this.handlePageActivation);
    globalThis.addEventListener("focus", this.handlePageActivation);
  }

  disconnect(): void {
    document.removeEventListener("visibilitychange", this.handlePageActivation);
    globalThis.removeEventListener("focus", this.handlePageActivation);
    this.subscriptions.clear();
    this.currentClient = null;
    this.currentConnected = false;
  }

  applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot, resetForSourceBind = false): void {
    const clientChanged = resetForSourceBind || snapshot.client !== this.currentClient;
    const becameConnected = snapshot.connected && !this.currentConnected;
    this.adoptGatewaySnapshot(snapshot);

    if (clientChanged) {
      this.options.resetForClientChange();
    }
    if (!snapshot.connected || !snapshot.client) {
      this.reloadPending ||= this.options.isLoading();
      this.options.invalidateRequests();
      return;
    }

    this.options.ensureAgents();
    if (this.options.isRouteDataInitialized() && (clientChanged || becameConnected)) {
      this.request("reconnect");
    }
  }

  adoptGatewaySnapshot(snapshot: ApplicationGatewaySnapshot): void {
    this.currentClient = snapshot.client;
    this.currentConnected = snapshot.connected;
  }

  setLastLoadedAtMs(value: number | null): void {
    this.lastLoadedAtMs = value;
  }

  markLoaded(): void {
    this.lastLoadedAtMs = Date.now();
  }

  resetPayload(): void {
    this.lastLoadedAtMs = null;
    this.reloadPending = false;
  }

  markLoadDeferred(): void {
    this.reloadPending = true;
  }

  beginLoad(): void {
    this.reloadPending = false;
  }

  reload(): void {
    this.pendingAutomaticRefresh = false;
    this.options.reload();
  }

  request(reason: UsageRefreshReason): void {
    if (this.options.isLoading() && reason !== "manual") {
      this.pendingAutomaticRefresh = true;
      return;
    }
    this.pendingAutomaticRefresh = false;
    const decision = decideUsageRefresh({
      reason,
      visible: document.visibilityState === "visible" && document.hasFocus(),
      interrupted: this.reloadPending,
      nowMs: Date.now(),
      lastLoadedAtMs: this.lastLoadedAtMs,
    });
    if (decision === "fetch") {
      this.reload();
    }
  }

  flushPending(): void {
    if (!this.pendingAutomaticRefresh) {
      return;
    }
    this.pendingAutomaticRefresh = false;
    this.request("focus");
  }
}
