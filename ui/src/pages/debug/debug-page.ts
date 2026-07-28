import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { state } from "lit/decorators.js";
import type { EventLogEntry } from "../../api/event-log.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { HealthSnapshot, StatusSummary } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { loadGatewayDiagnostics } from "../../lib/gateway-diagnostics.ts";
import { renderDebug } from "./view.ts";

const DEBUG_POLL_INTERVAL_MS = 3000;

class DebugPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
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

  private debugPollInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private stopGatewaySubscription?: () => void;
  private stopEventLogSubscription?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    this.eventLog = this.context.gateway.eventLog;
    this.syncGatewayState();
    this.stopGatewaySubscription = this.context.gateway.subscribe((snapshot) => {
      const previousClient = this.client;
      this.syncGatewayState();
      if (previousClient !== snapshot.client) {
        this.resetServerState();
      }
      this.syncPolling();
      this.ensureInitialDebug();
    });
    this.stopEventLogSubscription = this.context.gateway.subscribeEventLog((events) => {
      this.eventLog = events;
    });
    this.syncPolling();
    this.ensureInitialDebug();
  }

  override disconnectedCallback() {
    this.stopPolling();
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopEventLogSubscription?.();
    this.stopEventLogSubscription = undefined;
    super.disconnectedCallback();
  }

  private syncGatewayState() {
    const gateway = this.context.gateway.snapshot;
    this.client = gateway.client;
    this.connected = gateway.connected;
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
      this.stopPolling();
      return;
    }
    if (this.debugPollInterval !== null) {
      return;
    }
    this.debugPollInterval = globalThis.setInterval(() => {
      void this.loadDiagnostics();
    }, DEBUG_POLL_INTERVAL_MS);
  }

  private stopPolling() {
    if (this.debugPollInterval === null) {
      return;
    }
    globalThis.clearInterval(this.debugPollInterval);
    this.debugPollInterval = null;
  }

  private ensureInitialDebug() {
    if (!this.connected || !this.client || this.debugStatus || this.debugLoading) {
      return;
    }
    void this.loadDiagnostics();
  }

  private async loadDiagnostics() {
    const client = this.client;
    if (!client || !this.connected || this.debugLoading) {
      return;
    }
    this.debugLoading = true;
    try {
      const result = await loadGatewayDiagnostics(client);
      if (this.client !== client || !this.connected) {
        return;
      }
      this.debugStatus = result.status;
      this.debugHealth = result.health;
      this.debugModels = result.models;
      this.debugHeartbeat = result.heartbeat;
    } catch (err) {
      if (this.client === client && this.connected) {
        this.debugCallError = String(err);
      }
    } finally {
      if (this.client === client) {
        this.debugLoading = false;
      }
    }
  }

  private async callDebugMethod() {
    const client = this.client;
    if (!client || !this.connected) {
      return;
    }
    this.debugCallError = null;
    this.debugCallResult = null;
    try {
      const params = this.debugCallParams.trim()
        ? (JSON.parse(this.debugCallParams) as unknown)
        : {};
      const res = await client.request(this.debugCallMethod.trim(), params);
      if (this.client === client) {
        this.debugCallResult = JSON.stringify(res, null, 2);
      }
    } catch (err) {
      if (this.client === client) {
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
          <div class="page-sub">${subtitleForRoute("debug")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        this.context.basePath,
        body,
        "debug",
        (routeId) => this.context.navigate(routeId),
        (routeId) => this.context.preload(routeId),
        { hostPolicy: this.context.hostPolicy },
      )}
    `;
  }
}

customElements.define("openclaw-debug-page", DebugPage);
