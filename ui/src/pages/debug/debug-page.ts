import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { EventLogEntry } from "../../api/event-log.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { HealthSnapshot, StatusSummary } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { loadGatewayDiagnostics } from "../../lib/gateway-diagnostics.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderDebug } from "./view.ts";

const DEBUG_POLL_INTERVAL_MS = 3000;

type DebugRequestScope = {
  gateway: ApplicationContext["gateway"];
  client: GatewayBrowserClient;
  generation: number;
};

class DebugPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private client: GatewayBrowserClient | null = null;
  @state() private connected = false;
  @state() private debugLoading = false;
  @state() private debugStatus: StatusSummary | null = null;
  @state() private debugHealth: HealthSnapshot | null = null;
  @state() private debugModels: unknown[] = [];
  @state() private debugHeartbeat: unknown = null;
  @state() private debugCallMethod = "";
  @state() private debugCallParams = "{}";
  @state() private debugCallResult: string | null = null;
  @state() private debugCallError: string | null = null;
  @state() private eventLog: readonly EventLogEntry[] = [];

  private readonly polling = new PollController(
    this,
    DEBUG_POLL_INTERVAL_MS,
    () => {
      void this.loadDiagnostics();
    },
    false,
  );
  private hasBoundGatewaySource = false;
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private requestGeneration = 0;
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const resetForSourceBind = this.hasBoundGatewaySource;
        this.hasBoundGatewaySource = true;
        this.gatewaySource = gateway;
        this.requestGeneration += 1;
        const cleanup = gateway.subscribe((snapshot) => {
          if (this.gatewaySource === gateway && this.context.gateway === gateway) {
            this.applyGatewaySnapshot(snapshot);
          }
        });
        this.applyGatewaySnapshot(gateway.snapshot, resetForSourceBind);
        return cleanup;
      },
    )
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribeEventLog(notify),
      (gateway) => {
        this.eventLog = gateway.eventLog;
      },
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.requestGeneration += 1;
    this.gatewaySource = null;
    this.debugLoading = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot, resetForSourceBind = false) {
    const connectionChanged = snapshot.connected !== this.connected;
    const clientChanged = resetForSourceBind || snapshot.client !== this.client;
    if (clientChanged || connectionChanged) {
      this.requestGeneration += 1;
    }
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    if (clientChanged) {
      this.resetServerState();
    } else if (connectionChanged) {
      this.debugLoading = false;
    }
    this.syncPolling();
    this.ensureInitialDebug();
  }

  private resetServerState() {
    this.debugLoading = false;
    this.debugStatus = null;
    this.debugHealth = null;
    this.debugModels = [];
    this.debugHeartbeat = null;
    this.debugCallResult = null;
    this.debugCallError = null;
  }

  private syncPolling() {
    if (!this.connected || !this.client) {
      this.polling.stop();
      return;
    }
    this.polling.start();
  }

  private ensureInitialDebug() {
    if (!this.connected || !this.client || this.debugStatus || this.debugLoading) {
      return;
    }
    void this.loadDiagnostics();
  }

  private captureRequestScope(): DebugRequestScope | null {
    const gateway = this.gatewaySource;
    const client = this.client;
    if (
      !gateway ||
      !client ||
      !this.connected ||
      !this.isConnected ||
      this.context.gateway !== gateway
    ) {
      return null;
    }
    return { gateway, client, generation: this.requestGeneration };
  }

  private isRequestScopeCurrent(scope: DebugRequestScope): boolean {
    return (
      this.isConnected &&
      this.gatewaySource === scope.gateway &&
      this.context.gateway === scope.gateway &&
      this.requestGeneration === scope.generation &&
      this.client === scope.client &&
      this.connected
    );
  }

  private async loadDiagnostics() {
    const scope = this.captureRequestScope();
    if (!scope || this.debugLoading) {
      return;
    }
    this.debugLoading = true;
    try {
      const result = await loadGatewayDiagnostics(scope.client);
      if (!this.isRequestScopeCurrent(scope)) {
        return;
      }
      this.debugStatus = result.status;
      this.debugHealth = result.health;
      this.debugModels = result.models;
      this.debugHeartbeat = result.heartbeat;
    } catch (err) {
      if (this.isRequestScopeCurrent(scope)) {
        this.debugCallError = String(err);
      }
    } finally {
      if (this.isRequestScopeCurrent(scope)) {
        this.debugLoading = false;
      }
    }
  }

  private async callDebugMethod() {
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    this.debugCallError = null;
    this.debugCallResult = null;
    try {
      const params = this.debugCallParams.trim()
        ? (JSON.parse(this.debugCallParams) as unknown)
        : {};
      const res = await scope.client.request(this.debugCallMethod.trim(), params);
      if (this.isRequestScopeCurrent(scope)) {
        this.debugCallResult = JSON.stringify(res, null, 2);
      }
    } catch (err) {
      if (this.isRequestScopeCurrent(scope)) {
        this.debugCallError = String(err);
      }
    }
  }

  override render() {
    const body = renderDebug({
      loading: this.debugLoading,
      status: this.debugStatus,
      health: this.debugHealth,
      models: this.debugModels,
      heartbeat: this.debugHeartbeat,
      eventLog: this.eventLog,
      methods: (this.context.gateway.snapshot.hello?.features?.methods ?? []).toSorted(),
      callMethod: this.debugCallMethod,
      callParams: this.debugCallParams,
      callResult: this.debugCallResult,
      callError: this.debugCallError,
      onCallMethodChange: (next) => (this.debugCallMethod = next),
      onCallParamsChange: (next) => (this.debugCallParams = next),
      onRefresh: () => void this.loadDiagnostics(),
      onCall: () => void this.callDebugMethod(),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("debug")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-debug-page")) {
  customElements.define("openclaw-debug-page", DebugPage);
}
