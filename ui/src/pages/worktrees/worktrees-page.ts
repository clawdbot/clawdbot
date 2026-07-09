import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { WorktreeRecord } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

type WorktreesListResult = { worktrees: WorktreeRecord[] };

type WorktreeOperationScope = {
  gateway: ApplicationContext["gateway"];
  client: GatewayBrowserClient;
  epoch: number;
};

function repoName(repoRoot: string): string {
  return repoRoot.split(/[\\/]/).findLast(Boolean) ?? repoRoot;
}

class WorktreesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private loading = false;
  @state() private records: WorktreeRecord[] = [];
  @state() private error: string | null = null;
  @state() private busyId: string | null = null;

  private client: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  private gatewaySource?: ApplicationContext["gateway"];
  private hasBoundGateway = false;
  private loadGeneration = 0;
  private operationEpoch = 0;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      const sourceChanged = this.hasBoundGateway && this.gatewaySource !== gateway;
      this.gatewaySource = gateway;
      this.hasBoundGateway = true;
      this.applyGatewaySnapshot(gateway.snapshot, sourceChanged);
      return gateway.subscribe((snapshot) => {
        if (this.gatewaySource === gateway && this.context.gateway === gateway) {
          this.applyGatewaySnapshot(snapshot);
        }
      });
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.invalidateLoad();
    this.invalidateOperations();
    this.gatewaySource = undefined;
    this.client = null;
    this.gatewayConnected = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    sourceChanged = false,
  ) {
    const clientChanged = snapshot.client !== this.client;
    const connectionChanged = snapshot.connected !== this.gatewayConnected;
    const identityChanged = sourceChanged || clientChanged;
    this.client = snapshot.client;
    this.gatewayConnected = snapshot.connected;
    if (identityChanged || connectionChanged) {
      this.invalidateLoad();
      this.invalidateOperations();
    }
    if (identityChanged) {
      this.records = [];
      this.error = null;
    }
    if (snapshot.connected && snapshot.client) {
      void this.load();
    }
  }

  private invalidateLoad() {
    this.loadGeneration += 1;
    this.loading = false;
  }

  private invalidateOperations() {
    this.operationEpoch += 1;
    this.busyId = null;
  }

  private captureOperationScope(): WorktreeOperationScope | null {
    const gateway = this.gatewaySource;
    const client = this.client;
    if (
      !gateway ||
      !client ||
      !this.gatewayConnected ||
      !this.isConnected ||
      this.context.gateway !== gateway
    ) {
      return null;
    }
    return { gateway, client, epoch: this.operationEpoch };
  }

  private isOperationScopeCurrent(scope: WorktreeOperationScope): boolean {
    return (
      this.isConnected &&
      this.gatewayConnected &&
      this.gatewaySource === scope.gateway &&
      this.context.gateway === scope.gateway &&
      this.client === scope.client &&
      this.operationEpoch === scope.epoch
    );
  }

  private async load() {
    const client = this.client;
    if (!client || !this.gatewayConnected || this.loading) {
      return;
    }
    const generation = ++this.loadGeneration;
    this.loading = true;
    this.error = null;
    try {
      const result = await client.request<WorktreesListResult>("worktrees.list", {});
      if (generation === this.loadGeneration && client === this.client) {
        this.records = result.worktrees;
      }
    } catch (error) {
      if (generation === this.loadGeneration && client === this.client) {
        this.error = String(error);
      }
    } finally {
      if (generation === this.loadGeneration && client === this.client) {
        this.loading = false;
      }
    }
  }

  private async removeWorktree(record: WorktreeRecord) {
    const scope = this.captureOperationScope();
    if (!scope || !window.confirm(t("worktrees.confirmDelete", { name: record.name }))) {
      return;
    }
    // Both attempts belong to one Gateway epoch. A force retry must never jump
    // to a replacement client after the first request reports snapshot failure.
    this.busyId = record.id;
    this.error = null;
    try {
      await scope.client.request("worktrees.remove", { id: record.id });
    } catch (error) {
      if (!this.isOperationScopeCurrent(scope)) {
        return;
      }
      const message = String(error);
      if (!message.toLowerCase().includes("snapshot failed")) {
        this.error = message;
        return;
      }
      const force = window.confirm(t("worktrees.confirmForceDelete", { error: message }));
      if (!force) {
        this.error = String(error);
        return;
      }
      if (!this.isOperationScopeCurrent(scope)) {
        return;
      }
      try {
        await scope.client.request("worktrees.remove", { id: record.id, force: true });
      } catch (forceError) {
        if (this.isOperationScopeCurrent(scope)) {
          this.error = String(forceError);
        }
      }
    } finally {
      if (this.isOperationScopeCurrent(scope)) {
        this.busyId = null;
        await this.load();
      }
    }
  }

  private async restore(record: WorktreeRecord) {
    const scope = this.captureOperationScope();
    if (!scope) {
      return;
    }
    this.busyId = record.id;
    this.error = null;
    try {
      await scope.client.request("worktrees.restore", { id: record.id });
    } catch (error) {
      if (this.isOperationScopeCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.isOperationScopeCurrent(scope)) {
        this.busyId = null;
        await this.load();
      }
    }
  }

  private async gc() {
    const scope = this.captureOperationScope();
    if (!scope) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      await scope.client.request("worktrees.gc", {});
    } catch (error) {
      if (this.isOperationScopeCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.isOperationScopeCurrent(scope)) {
        this.loading = false;
        await this.load();
      }
    }
  }

  override render() {
    const body = html`
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${t("worktrees.title")}</div>
            <div class="card-sub">${t("worktrees.subtitle")}</div>
          </div>
          <button class="btn" ?disabled=${this.loading} @click=${() => void this.gc()}>
            ${this.loading ? t("common.loading") : t("worktrees.cleanNow")}
          </button>
        </div>
        ${this.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${this.error}</div>`
          : nothing}
        <div class="table worktrees-table" style="margin-top: 16px;">
          <div class="table-head">
            <div>${t("worktrees.name")}</div>
            <div>${t("worktrees.repo")}</div>
            <div>${t("worktrees.branch")}</div>
            <div>${t("worktrees.status")}</div>
            <div>${t("worktrees.lastActive")}</div>
            <div>${t("worktrees.actions")}</div>
          </div>
          ${this.records.length === 0
            ? html`<div class="muted" style="padding: 16px;">${t("worktrees.empty")}</div>`
            : this.records.map(
                (record) => html`
                  <div class="table-row">
                    <div>${record.name}</div>
                    <div title=${record.repoRoot}>${repoName(record.repoRoot)}</div>
                    <div>${record.branch}</div>
                    <div>${record.removedAt ? t("worktrees.restorable") : t("common.active")}</div>
                    <div>${formatRelativeTimestamp(record.lastActiveAt)}</div>
                    <div class="row" style="gap: 8px;">
                      ${record.removedAt
                        ? html`<button
                            class="btn btn--sm"
                            ?disabled=${this.busyId === record.id}
                            @click=${() => void this.restore(record)}
                          >
                            ${t("worktrees.restore")}
                          </button>`
                        : html`<button
                            class="btn btn--sm danger"
                            ?disabled=${this.busyId === record.id}
                            @click=${() => void this.removeWorktree(record)}
                          >
                            ${t("common.delete")}
                          </button>`}
                    </div>
                  </div>
                `,
              )}
        </div>
      </section>
    `;
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("worktrees")}</div>
          <div class="page-sub">${subtitleForRoute("worktrees")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

customElements.define("openclaw-worktrees-page", WorktreesPage);
