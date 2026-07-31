import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import {
  type ClawCatalogDetail,
  type ClawCatalogEntry,
  type ClawLifecycleApplyResult,
  type ClawLifecyclePlanResult,
  type ClawStatusEntry,
  type ClawsCatalogDetailResult,
  type ClawsCatalogSearchResult,
  type ClawsDoctorResult,
  type ClawsStatusResult,
  validateClawLifecycleApplyResult,
  validateClawLifecyclePlanResult,
  validateClawsCatalogDetailResult,
  validateClawsCatalogSearchResult,
  validateClawsDoctorResult,
  validateClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/claws.css";
import {
  PLUGINS_HUB_PANEL_ID,
  pluginsHubTabs,
  type PluginsHubTab,
} from "../plugins/plugins-hub.ts";
import { clawMutationAvailable } from "./access.ts";
import { buildClawApplyRequest, type PendingClawOperation } from "./lifecycle-request.ts";
import { renderClawLifecycle } from "./lifecycle-view.ts";
import { renderClaws } from "./view.ts";

type OperationScope = {
  client: GatewayBrowserClient;
  gateway: ApplicationContext["gateway"];
  generation: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

class ClawsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private connected = false;
  @state() private available = false;
  @state() private catalogAvailable = false;
  @state() private lifecycleAvailable = false;
  @state() private mutationAvailable = false;
  @state() private loading = false;
  @state() private operationBusy = false;
  @state() private error: string | null = null;
  @state() private status: ClawsStatusResult | null = null;
  @state() private doctor: ClawsDoctorResult | null = null;
  @state() private selectedAgentId: string | null = null;
  @state() private selectedAgentExplicit = false;
  @state() private query = "";
  @state() private entries: ClawCatalogEntry[] = [];
  @state() private detail: ClawCatalogDetail | null = null;
  @state() private plan: ClawLifecyclePlanResult | null = null;
  @state() private pending: PendingClawOperation | null = null;
  @state() private completion: ClawLifecycleApplyResult | null = null;
  @state() private removeUnused = false;
  @state() private riskAcknowledged = false;

  private gatewaySource?: ApplicationContext["gateway"];
  private client: GatewayBrowserClient | null = null;
  private generation = 0;
  private operationGeneration = 0;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      this.gatewaySource = gateway;
      this.applyGatewaySnapshot(gateway.snapshot);
      return gateway.subscribe((snapshot) => {
        if (this.gatewaySource === gateway) {
          this.applyGatewaySnapshot(snapshot);
        }
      });
    },
  );

  override disconnectedCallback() {
    this.generation += 1;
    this.operationGeneration += 1;
    this.gatewaySource = undefined;
    this.client = null;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = this.client !== snapshot.client;
    const wasConnected = this.connected;
    const wasAvailable = this.available;
    this.client = snapshot.client;
    this.connected = snapshot.phase === "connected";
    this.available = ["claws.status", "claws.doctor"].every(
      (method) => isGatewayMethodAdvertised(snapshot, method) === true,
    );
    this.catalogAvailable = ["claws.catalog.search", "claws.catalog.detail"].every(
      (method) => isGatewayMethodAdvertised(snapshot, method) === true,
    );
    this.lifecycleAvailable = ["claws.add.plan", "claws.update.plan", "claws.remove.plan"].every(
      (method) => isGatewayMethodAdvertised(snapshot, method) === true,
    );
    this.mutationAvailable = clawMutationAvailable(snapshot, [
      "claws.add.apply",
      "claws.update.apply",
      "claws.remove.apply",
    ]);
    if (clientChanged || !this.connected || !this.available) {
      this.generation += 1;
      this.operationGeneration += 1;
      this.loading = false;
      this.operationBusy = false;
      if (clientChanged) {
        this.resetState();
      }
    }
    if (
      this.connected &&
      this.available &&
      (clientChanged || !wasConnected || !wasAvailable || !this.status)
    ) {
      void this.refresh();
    }
  }

  private resetState() {
    this.status = null;
    this.doctor = null;
    this.error = null;
    this.selectedAgentId = null;
    this.selectedAgentExplicit = false;
    this.entries = [];
    this.detail = null;
    this.completion = null;
    this.cancelPlan();
  }

  private selectedRecord(): ClawStatusEntry | null {
    return this.status?.records.find((record) => record.agentId === this.selectedAgentId) ?? null;
  }

  private selectInstalledAgent(
    agentId: string | null,
    explicit: boolean,
    options: { invalidateOperation?: boolean } = {},
  ) {
    if (this.selectedAgentId === agentId && this.selectedAgentExplicit === explicit) {
      return;
    }
    if (options.invalidateOperation !== false) {
      this.operationGeneration += 1;
    }
    this.selectedAgentId = agentId;
    this.selectedAgentExplicit = explicit;
    this.cancelPlan();
  }

  private updateSelectionRequired(): boolean {
    if (!this.detail) {
      return false;
    }
    const matches =
      this.status?.records.filter((record) => record.name === this.detail?.packageName) ?? [];
    return matches.length > 1 && !this.selectedAgentExplicit;
  }

  private async refresh(options: { preserveOperation?: boolean } = {}) {
    const gateway = this.gatewaySource;
    const client = this.client;
    if (
      !gateway ||
      gateway !== this.context.gateway ||
      !this.connected ||
      !this.available ||
      !client
    ) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.error = null;
    try {
      const [statusPayload, doctorPayload] = await Promise.all([
        client.request("claws.status", {}),
        client.request("claws.doctor", {}),
      ]);
      if (!validateClawsStatusResult(statusPayload) || !validateClawsDoctorResult(doctorPayload)) {
        throw new Error(t("clawsPage.errors.invalidLifecycle"));
      }
      if (
        this.generation !== generation ||
        this.gatewaySource !== gateway ||
        this.client !== client
      ) {
        return;
      }
      this.status = statusPayload;
      this.doctor = doctorPayload;
      if (!statusPayload.records.some((record) => record.agentId === this.selectedAgentId)) {
        this.selectInstalledAgent(statusPayload.records[0]?.agentId ?? null, false, {
          invalidateOperation: options.preserveOperation === true ? false : undefined,
        });
      }
    } catch (error) {
      if (this.generation === generation) {
        this.error = errorMessage(error);
      }
    } finally {
      if (this.generation === generation) {
        this.loading = false;
      }
    }
  }

  private operationCurrent(scope: OperationScope): boolean {
    return (
      this.operationGeneration === scope.generation &&
      this.gatewaySource === scope.gateway &&
      this.client === scope.client
    );
  }

  private async runOperation(operation: (scope: OperationScope) => Promise<void>) {
    const gateway = this.gatewaySource;
    const client = this.client;
    if (!gateway || !client || this.loading || this.operationBusy) {
      return;
    }
    const scope = { client, gateway, generation: this.operationGeneration };
    this.operationBusy = true;
    this.error = null;
    try {
      await operation(scope);
    } catch (error) {
      if (this.operationCurrent(scope)) {
        this.error = errorMessage(error);
      }
    } finally {
      if (this.operationCurrent(scope)) {
        this.operationBusy = false;
      }
    }
  }

  private async searchCatalog() {
    const query = this.query.trim();
    if (!query || !this.catalogAvailable) {
      return;
    }
    await this.runOperation(async (scope) => {
      const payload = await scope.client.request<ClawsCatalogSearchResult>("claws.catalog.search", {
        query,
      });
      if (!this.operationCurrent(scope)) {
        return;
      }
      if (!validateClawsCatalogSearchResult(payload)) {
        throw new Error(t("clawsPage.errors.invalidCatalog"));
      }
      this.entries = payload.entries;
      this.detail = null;
      this.cancelPlan();
    });
  }

  private async selectCatalog(entry: ClawCatalogEntry) {
    await this.runOperation(async (scope) => {
      const payload = await scope.client.request<ClawsCatalogDetailResult>("claws.catalog.detail", {
        packageName: entry.packageName,
        ...(entry.latestVersion ? { version: entry.latestVersion } : {}),
      });
      if (!this.operationCurrent(scope)) {
        return;
      }
      if (!validateClawsCatalogDetailResult(payload)) {
        throw new Error(t("clawsPage.errors.invalidCatalog"));
      }
      this.detail = payload.detail;
      this.cancelPlan();
    });
  }

  private async loadPlan(pending: PendingClawOperation) {
    if (!this.lifecycleAvailable) {
      return;
    }
    await this.runOperation(async (scope) => {
      const params =
        pending.operation === "add"
          ? { source: pending.source, ...(pending.agentId ? { agentId: pending.agentId } : {}) }
          : pending.operation === "update"
            ? { target: pending.target, ...(pending.source ? { source: pending.source } : {}) }
            : { target: pending.target, removeUnused: this.removeUnused };
      const payload = await scope.client.request<ClawLifecyclePlanResult>(
        `claws.${pending.operation}.plan`,
        params,
      );
      if (!this.operationCurrent(scope)) {
        return;
      }
      if (!validateClawLifecyclePlanResult(payload)) {
        throw new Error(t("clawsPage.errors.invalidPlan"));
      }
      this.pending = pending;
      this.plan = payload;
      this.completion = null;
      this.riskAcknowledged = false;
    });
  }

  private previewAdd() {
    const detail = this.detail;
    if (!detail) {
      return;
    }
    void this.loadPlan({
      operation: "add",
      source: { packageName: detail.packageName, version: detail.version },
    });
  }

  private previewUpdate() {
    const detail = this.detail;
    const selected = this.selectedRecord();
    if (
      !detail ||
      !selected ||
      selected.name !== detail.packageName ||
      this.updateSelectionRequired()
    ) {
      return;
    }
    void this.loadPlan({
      operation: "update",
      target: selected.agentId,
      source: { packageName: detail.packageName, version: detail.version },
    });
  }

  private previewRemove() {
    const selected = this.selectedRecord();
    if (selected) {
      void this.loadPlan({ operation: "remove", target: selected.agentId });
    }
  }

  private async replanRemove(removeUnused: boolean) {
    this.removeUnused = removeUnused;
    if (this.pending?.operation === "remove") {
      await this.loadPlan(this.pending);
    }
  }

  private cancelPlan() {
    this.plan = null;
    this.pending = null;
    this.removeUnused = false;
    this.riskAcknowledged = false;
  }

  private async applyPlan() {
    if (!this.pending || !this.plan || !this.mutationAvailable) {
      return;
    }
    const request = buildClawApplyRequest({
      pending: this.pending,
      plan: this.plan,
      removeUnused: this.removeUnused,
      riskAcknowledged: this.riskAcknowledged,
    });
    if (!request) {
      return;
    }
    await this.runOperation(async (scope) => {
      const payload = await scope.client.request<ClawLifecycleApplyResult>(
        request.method,
        request.request,
      );
      if (!this.operationCurrent(scope)) {
        return;
      }
      if (!validateClawLifecycleApplyResult(payload)) {
        throw new Error(t("clawsPage.errors.invalidOutcome"));
      }
      this.completion = payload;
      this.selectedAgentId = payload.operation === "remove" ? null : payload.agentId;
      this.selectedAgentExplicit = false;
      this.cancelPlan();
      await this.refresh({ preserveOperation: true });
    });
  }

  private openChat(agentId: string) {
    this.context.navigate("chat", { search: `?agent=${encodeURIComponent(agentId)}` });
  }

  private selectHubTab(tab: PluginsHubTab) {
    if (tab === "claws") {
      return;
    }
    if (tab === "skills") {
      this.context.navigate("skills");
      return;
    }
    if (tab === "workshop") {
      this.context.navigate("skill-workshop");
      return;
    }
    this.context.navigate("plugins", tab === "discover" ? { search: "?tab=discover" } : undefined);
  }

  override render() {
    const selected = this.selectedRecord();
    return html`
      <section class="content-header content-header--page">
        <div><div class="page-title">${titleForRoute("claws")}</div></div>
        <div class="page-header-actions">
          <button
            class="btn"
            type="button"
            title=${t("clawsPage.refresh")}
            ?disabled=${!this.connected || !this.available || this.loading || this.operationBusy}
            @click=${() => void this.refresh()}
          >
            ${this.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
      </section>
      ${renderSettingsWorkspace(html`
        <div class="plugins-hub-tabs-row">
          ${renderHubTabs({
            id: "plugins",
            active: "claws",
            tabs: pluginsHubTabs(null, true),
            ariaLabel: t("pluginsPage.hubTablistLabel"),
            panelId: PLUGINS_HUB_PANEL_ID,
            className: "plugins-tabs",
            onSelect: (tab) => this.selectHubTab(tab),
          })}
        </div>
        <wa-tab-panel
          id=${PLUGINS_HUB_PANEL_ID}
          name="claws"
          active
          aria-labelledby="plugins-tab-claws"
        >
          ${this.connected && this.available
            ? renderClawLifecycle({
                catalogAvailable: this.catalogAvailable,
                lifecycleAvailable: this.lifecycleAvailable,
                mutationAvailable: this.mutationAvailable,
                busy: this.loading || this.operationBusy,
                applying: this.operationBusy,
                error: this.error,
                query: this.query,
                entries: this.entries,
                detail: this.detail,
                selected,
                plan: this.plan,
                completion: this.completion,
                removeUnused: this.removeUnused,
                riskAcknowledged: this.riskAcknowledged,
                updateSelectionRequired: this.updateSelectionRequired(),
                onQueryChange: (query) => {
                  this.query = query;
                },
                onSearch: () => void this.searchCatalog(),
                onSelectCatalog: (entry) => void this.selectCatalog(entry),
                onPreviewAdd: () => this.previewAdd(),
                onPreviewUpdate: () => this.previewUpdate(),
                onPreviewRemove: () => this.previewRemove(),
                onApply: () => void this.applyPlan(),
                onCancelPlan: () => this.cancelPlan(),
                onRemoveUnusedChange: (value) => void this.replanRemove(value),
                onRiskAcknowledgedChange: (value) => {
                  this.riskAcknowledged = value;
                },
                onOpenChat: (agentId) => this.openChat(agentId),
              })
            : nothing}
          ${renderClaws({
            connected: this.connected,
            available: this.available,
            loading: this.loading,
            busy: this.operationBusy,
            error: this.connected && this.available ? null : this.error,
            status: this.status,
            doctor: this.doctor,
            selectedAgentId: this.selectedAgentId,
            onSelect: (agentId) => {
              this.selectInstalledAgent(agentId, true);
            },
          })}
        </wa-tab-panel>
      `)}
    `;
  }
}

if (!customElements.get("openclaw-claws-page")) {
  customElements.define("openclaw-claws-page", ClawsPage);
}
