import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { EventLogEntry } from "../../api/event-log.ts";
import type { HealthSnapshot, StatusSummary } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { loadGatewayDiagnostics } from "../../lib/gateway-diagnostics.ts";
import { AsyncGatewayScopeController } from "../../lit/async-gateway-scope-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderDebug } from "./view.ts";

const DEBUG_POLL_INTERVAL_MS = 3000;

class DebugPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

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
  private readonly gatewayScope = new AsyncGatewayScopeController(
    this,
    () => this.context?.gateway,
    (_snapshot, { clientChanged, connectionChanged }) => {
      if (clientChanged) {
        this.resetServerState();
      } else if (connectionChanged) {
        this.debugLoading = false;
      }
      this.syncPolling();
      this.ensureInitialDebug();
    },
  );
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribeEventLog(notify),
    (gateway) => {
      this.eventLog = gateway.eventLog;
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.debugLoading = false;
    super.disconnectedCallback();
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
    if (!this.gatewayScope.connected || !this.gatewayScope.client) {
      this.polling.stop();
      return;
    }
    this.polling.start();
  }

  private ensureInitialDebug() {
    if (
      !this.gatewayScope.connected ||
      !this.gatewayScope.client ||
      this.debugStatus ||
      this.debugLoading
    ) {
      return;
    }
    void this.loadDiagnostics();
  }

  private async loadDiagnostics() {
    const scope = this.gatewayScope.capture();
    if (!scope || this.debugLoading) {
      return;
    }
    this.debugLoading = true;
    try {
      const result = await loadGatewayDiagnostics(scope.client);
      if (!this.gatewayScope.isCurrent(scope)) {
        return;
      }
      this.debugStatus = result.status;
      this.debugHealth = result.health;
      this.debugModels = result.models;
      this.debugHeartbeat = result.heartbeat;
    } catch (err) {
      if (this.gatewayScope.isCurrent(scope)) {
        this.debugCallError = String(err);
      }
    } finally {
      if (this.gatewayScope.isCurrent(scope)) {
        this.debugLoading = false;
      }
    }
  }

  private async callDebugMethod() {
    const scope = this.gatewayScope.capture();
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
      if (this.gatewayScope.isCurrent(scope)) {
        this.debugCallResult = JSON.stringify(res, null, 2);
      }
    } catch (err) {
      if (this.gatewayScope.isCurrent(scope)) {
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
