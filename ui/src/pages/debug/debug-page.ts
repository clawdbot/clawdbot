import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { EventLogEntry } from "../../api/event-log.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { HealthSnapshot, StatusSummary } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadGatewayDiagnostics } from "../../lib/gateway-diagnostics.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderDebug } from "./view.ts";

const DEBUG_POLL_INTERVAL_MS = 3000;

class DebugPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private debugStatus: StatusSummary | null = null;
  @state() private debugHealth: HealthSnapshot | null = null;
  @state() private debugModels: unknown[] = [];
  @state() private debugHeartbeat: unknown = null;
  @state() private debugCallMethod = "";
  @state() private debugCallParams = "{}";
  @state() private debugCallResult: string | null = null;
  @state() private debugCallError: string | null = null;
  @state() private debugDiagnosticsError: string | null = null;
  @state() private eventLog: readonly EventLogEntry[] = [];

  private readonly polling = new PollController(
    this,
    DEBUG_POLL_INTERVAL_MS,
    () => {
      void this.loadDiagnostics();
    },
    false,
  );
  private callEpoch = 0;
  private diagnosticsTaskActiveClient: GatewayBrowserClient | null = null;
  private diagnosticsAgentId: string | null = null;
  private readonly diagnosticsTask = new Task(this, {
    autoRun: false,
    args: () =>
      [
        this.gateway.connected ? this.gateway.client : null,
        this.context?.agentSelection.state.selectedId ?? null,
      ] as const,
    task: ([client, agentId], { signal }) =>
      client ? loadGatewayDiagnostics(client, agentId, signal) : initialState,
    onComplete: (result) => {
      this.diagnosticsTaskActiveClient = null;
      this.debugDiagnosticsError = null;
      this.debugStatus = result.status;
      this.debugHealth = result.health;
      this.debugModels = result.models;
      this.debugHeartbeat = result.heartbeat;
    },
    onError: (error) => {
      this.diagnosticsTaskActiveClient = null;
      this.debugDiagnosticsError = formatUiError(error);
    },
  });
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.debugStatus = null;
      this.debugHealth = null;
      this.debugModels = [];
      this.debugHeartbeat = null;
      this.debugCallResult = null;
      this.debugCallError = null;
      this.debugDiagnosticsError = null;
    },
    invalidateRequests: () => {
      void this.diagnosticsTask.run([null, null]);
      this.diagnosticsTaskActiveClient = null;
      this.callEpoch += 1;
    },
    onSnapshot: () => {
      this.syncPolling();
      this.ensureInitialDebug();
    },
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribeEventLog(notify),
      (gateway) => {
        this.eventLog = gateway.eventLog;
      },
    )
    .watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      (selection) => {
        const agentId = selection.state.selectedId;
        if (agentId === this.diagnosticsAgentId) {
          return;
        }
        this.diagnosticsAgentId = agentId;
        this.debugModels = [];
        void this.diagnosticsTask.run([null, null]);
        this.diagnosticsTaskActiveClient = null;
        void this.loadDiagnostics();
      },
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    void this.diagnosticsTask.run([null, null]);
    this.diagnosticsTaskActiveClient = null;
    this.diagnosticsAgentId = null;
    this.callEpoch += 1;
    super.disconnectedCallback();
  }

  private syncPolling() {
    if (!this.gateway.connected || !this.gateway.client) {
      this.polling.stop();
      return;
    }
    this.polling.start();
  }

  private ensureInitialDebug() {
    if (
      !this.gateway.connected ||
      !this.gateway.client ||
      this.debugStatus ||
      this.diagnosticsTaskActiveClient
    ) {
      return;
    }
    void this.loadDiagnostics();
  }

  private loadDiagnostics(): Promise<void> {
    const client = this.gateway.connected ? this.gateway.client : null;
    if (!client || this.diagnosticsTaskActiveClient) {
      return Promise.resolve();
    }
    this.diagnosticsTaskActiveClient = client;
    return this.diagnosticsTask.run([client, this.context.agentSelection.state.selectedId]);
  }

  private async callDebugMethod() {
    const client = this.gateway.connected ? this.gateway.client : null;
    if (!client) {
      return;
    }
    this.debugCallError = null;
    this.debugCallResult = null;
    const gateway = this.gateway.gateway;
    const epoch = ++this.callEpoch;
    const isCurrent = () =>
      this.gateway.connected &&
      this.gateway.client === client &&
      this.gateway.gateway === gateway &&
      this.context.gateway === gateway &&
      this.callEpoch === epoch;
    try {
      const params = this.debugCallParams.trim()
        ? (JSON.parse(this.debugCallParams) as unknown)
        : {};
      const res = await client.request(this.debugCallMethod.trim(), params);
      if (isCurrent()) {
        this.debugCallResult = JSON.stringify(res, null, 2);
      }
    } catch (err) {
      if (isCurrent()) {
        this.debugCallError = formatUiError(err);
      }
    }
  }

  override render() {
    const debugView = renderDebug({
      loading: this.diagnosticsTask.status === TaskStatus.PENDING,
      status: this.debugStatus,
      health: this.debugHealth,
      models: this.debugModels,
      heartbeat: this.debugHeartbeat,
      diagnosticsError: this.debugDiagnosticsError,
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
      ${renderSettingsWorkspace(debugView)}
    `;
  }
}

if (!customElements.get("openclaw-debug-page")) {
  customElements.define("openclaw-debug-page", DebugPage);
}
