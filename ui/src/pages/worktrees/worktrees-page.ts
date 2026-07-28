import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { WorktreeRecord } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";

type WorktreesListResult = { worktrees: WorktreeRecord[] };

function repoName(repoRoot: string): string {
  return repoRoot.split(/[\\/]/).findLast(Boolean) ?? repoRoot;
}

class WorktreesPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private loading = false;
  @state() private records: WorktreeRecord[] = [];
  @state() private error: string | null = null;
  @state() private busyId: string | null = null;

  private client: GatewayBrowserClient | null = null;
  private unsubscribe: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = this.context.gateway.subscribe((snapshot) => {
      const connected = snapshot.connected && snapshot.client;
      if (snapshot.client !== this.client) {
        this.client = snapshot.client;
        this.records = [];
        this.loading = false;
      }
      if (connected) {
        void this.load();
      }
    });
    const snapshot = this.context.gateway.snapshot;
    this.client = snapshot.client;
    if (snapshot.connected && snapshot.client) {
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.client = null;
    super.disconnectedCallback();
  }

  private async load() {
    const client = this.client;
    if (!client || this.loading) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const result = await client.request<WorktreesListResult>("worktrees.list", {});
      if (client === this.client) {
        this.records = result.worktrees;
      }
    } catch (error) {
      if (client === this.client) {
        this.error = String(error);
      }
    } finally {
      if (client === this.client) {
        this.loading = false;
      }
    }
  }

  private async removeWorktree(record: WorktreeRecord) {
    if (!this.client || !window.confirm(t("worktrees.confirmDelete", { name: record.name }))) {
      return;
    }
    this.busyId = record.id;
    this.error = null;
    try {
      await this.client.request("worktrees.remove", { id: record.id });
    } catch (error) {
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
      try {
        await this.client.request("worktrees.remove", { id: record.id, force: true });
      } catch (forceError) {
        this.error = String(forceError);
      }
    } finally {
      this.busyId = null;
      await this.load();
    }
  }

  private async restore(record: WorktreeRecord) {
    if (!this.client) {
      return;
    }
    this.busyId = record.id;
    this.error = null;
    try {
      await this.client.request("worktrees.restore", { id: record.id });
    } catch (error) {
      this.error = String(error);
    } finally {
      this.busyId = null;
      await this.load();
    }
  }

  private async gc() {
    if (!this.client) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      await this.client.request("worktrees.gc", {});
    } catch (error) {
      this.error = String(error);
    } finally {
      this.loading = false;
      await this.load();
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
      ${renderSettingsWorkspace(
        this.context.basePath,
        body,
        "worktrees",
        (routeId) => this.context.navigate(routeId),
        (routeId) => this.context.preload(routeId),
        { hostPolicy: this.context.hostPolicy },
      )}
    `;
  }
}

customElements.define("openclaw-worktrees-page", WorktreesPage);
