import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import {
  validateApprovalHistoryResult,
  type ApprovalHistoryResult,
} from "../../../../packages/gateway-protocol/src/approval-result-validators.js";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalTerminalReason,
  TerminalApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { renderSettingsPage } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { i18n, t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

const APPROVAL_HISTORY_PAGE_SIZE = 50;

function formatResolvedAt(timestampMs: number): string {
  return new Intl.DateTimeFormat(i18n.getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestampMs));
}

function kindLabel(kind: ApprovalKind): string {
  switch (kind) {
    case "exec":
      return t("approvalHistory.kinds.exec");
    case "plugin":
      return t("approvalHistory.kinds.plugin");
    case "system-agent":
      return t("approvalHistory.kinds.systemAgent");
  }
  return kind satisfies never;
}

function statusLabel(status: TerminalApprovalSnapshot["status"]): string {
  switch (status) {
    case "allowed":
      return t("approvalHistory.statuses.allowed");
    case "denied":
      return t("approvalHistory.statuses.denied");
    case "expired":
      return t("approvalHistory.statuses.expired");
    case "cancelled":
      return t("approvalHistory.statuses.cancelled");
  }
  return status satisfies never;
}

function decisionLabel(decision: ApprovalDecision | undefined): string {
  switch (decision) {
    case "allow-once":
      return t("approvalHistory.decisions.allowOnce");
    case "allow-always":
      return t("approvalHistory.decisions.allowAlways");
    case "deny":
      return t("approvalHistory.decisions.deny");
    case undefined:
      return t("approvalHistory.notApplicable");
  }
  return decision satisfies never;
}

function reasonLabel(reason: ApprovalTerminalReason): string {
  switch (reason) {
    case "user":
      return t("approvalHistory.reasons.user");
    case "timeout":
      return t("approvalHistory.reasons.timeout");
    case "malformed-verdict":
      return t("approvalHistory.reasons.malformedVerdict");
    case "no-route":
      return t("approvalHistory.reasons.noRoute");
    case "run-aborted":
      return t("approvalHistory.reasons.runAborted");
    case "gateway-restart":
      return t("approvalHistory.reasons.gatewayRestart");
    case "storage-corrupt":
      return t("approvalHistory.reasons.storageCorrupt");
  }
  return reason satisfies never;
}

function requestLabel(item: TerminalApprovalSnapshot): string {
  const presentation = item.presentation;
  const request = presentation.kind === "exec" ? presentation.commandText : presentation.title;
  return request || t("approvalHistory.unknown");
}

function sourceLabel(item: TerminalApprovalSnapshot): string {
  const parts = [item.source?.agentId, item.source?.sessionKey].filter((part): part is string =>
    Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : t("approvalHistory.unknown");
}

function resolverLabel(item: TerminalApprovalSnapshot): string {
  if (!item.resolver) {
    return t("approvalHistory.unknown");
  }
  return item.resolver.id ? `${item.resolver.kind} · ${item.resolver.id}` : item.resolver.kind;
}

class ApprovalsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private items: TerminalApprovalSnapshot[] = [];
  @state() private nextCursor: string | null = null;
  @state() private loading = false;
  @state() private loadingMore = false;
  @state() private error: string | null = null;
  @state() private connected = false;

  private client: GatewayBrowserClient | null = null;
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private requestGeneration = 0;
  private hasLoaded = false;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      // A new gateway identity (even with the same client/connection) is a fresh
      // data source: invalidate in-flight requests and drop the previous
      // gateway's rows/cursor/error so stale history is not shown and "Load more"
      // cannot append across sources. Mirrors the client-change reset below.
      if (this.gatewaySource !== gateway) {
        this.requestGeneration += 1;
        this.loading = false;
        this.loadingMore = false;
        this.hasLoaded = false;
        this.items = [];
        this.nextCursor = null;
        this.error = null;
      }
      this.gatewaySource = gateway;
      this.applyGatewaySnapshot(gateway.snapshot);
      return gateway.subscribe((snapshot) => {
        if (this.gatewaySource === gateway && this.context.gateway === gateway) {
          this.applyGatewaySnapshot(snapshot);
        }
      });
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.requestGeneration += 1;
    this.gatewaySource = null;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.client;
    const connectionChanged = snapshot.connected !== this.connected;
    this.connected = snapshot.connected;
    if (clientChanged) {
      this.client = snapshot.client;
      this.requestGeneration += 1;
      this.items = [];
      this.nextCursor = null;
      this.error = null;
      this.hasLoaded = false;
      this.loading = false;
      this.loadingMore = false;
    } else if (connectionChanged) {
      this.requestGeneration += 1;
      this.loading = false;
      this.loadingMore = false;
      if (snapshot.connected) {
        this.hasLoaded = false;
      }
    }
    if (snapshot.connected && snapshot.client && !this.hasLoaded && !this.loading) {
      void this.loadPage(true);
    }
  }

  private async loadPage(reset: boolean): Promise<void> {
    const client = this.client;
    const gateway = this.gatewaySource;
    if (!client || !gateway || !this.connected || this.loading || this.loadingMore) {
      return;
    }
    const generation = this.requestGeneration;
    const cursor = reset ? undefined : (this.nextCursor ?? undefined);
    if (!reset && !cursor) {
      return;
    }
    if (reset) {
      this.loading = true;
    } else {
      this.loadingMore = true;
    }
    this.error = null;
    const isCurrent = () =>
      this.isConnected &&
      this.connected &&
      this.gatewaySource === gateway &&
      this.context.gateway === gateway &&
      gateway.snapshot.connected &&
      this.client === client &&
      this.requestGeneration === generation;
    try {
      const result = await client.request<ApprovalHistoryResult>("approval.history", {
        ...(cursor ? { cursor } : {}),
        limit: APPROVAL_HISTORY_PAGE_SIZE,
      });
      if (!validateApprovalHistoryResult(result)) {
        throw new Error(t("approvalHistory.invalidResponse"));
      }
      if (!isCurrent()) {
        return;
      }
      this.items = reset ? result.items : [...this.items, ...result.items];
      this.nextCursor = result.nextCursor ?? null;
      this.hasLoaded = true;
    } catch (error) {
      if (isCurrent()) {
        this.error = String(error);
        this.hasLoaded = true;
      }
    } finally {
      if (isCurrent()) {
        this.loading = false;
        this.loadingMore = false;
      }
    }
  }

  private renderTable() {
    return html`
      <div class="data-table-container">
        <table class="data-table approval-history-table">
          <thead>
            <tr>
              <th>${t("approvalHistory.columns.resolved")}</th>
              <th>${t("approvalHistory.columns.kind")}</th>
              <th>${t("approvalHistory.columns.request")}</th>
              <th>${t("approvalHistory.columns.decision")}</th>
              <th>${t("approvalHistory.columns.reason")}</th>
              <th>${t("approvalHistory.columns.source")}</th>
              <th>${t("approvalHistory.columns.resolver")}</th>
            </tr>
          </thead>
          <tbody>
            ${this.items.length === 0
              ? html`
                  <tr>
                    <td colspan="7" class="data-table-empty-cell">
                      <div class="data-table-empty-state" role="status" aria-live="polite">
                        ${this.loading
                          ? t("approvalHistory.loading")
                          : this.error || !this.hasLoaded
                            ? t("approvalHistory.unknown")
                            : t("approvalHistory.empty")}
                      </div>
                    </td>
                  </tr>
                `
              : this.items.map(
                  (item) => html`
                    <tr>
                      <td>${formatResolvedAt(item.resolvedAtMs)}</td>
                      <td>${kindLabel(item.presentation.kind)}</td>
                      <td class="mono">${requestLabel(item)}</td>
                      <td>
                        ${statusLabel(item.status)} ·
                        ${decisionLabel("decision" in item ? item.decision : undefined)}
                      </td>
                      <td>${reasonLabel(item.reason)}</td>
                      <td class="mono">${sourceLabel(item)}</td>
                      <td class="mono">${resolverLabel(item)}</td>
                    </tr>
                  `,
                )}
          </tbody>
        </table>
      </div>
      <div class="data-table-pagination">
        <div class="data-table-pagination__info">${t("approvalHistory.retention")}</div>
        <div class="data-table-pagination__controls">
          ${this.nextCursor
            ? html`
                <button ?disabled=${this.loadingMore} @click=${() => void this.loadPage(false)}>
                  ${this.loadingMore
                    ? t("approvalHistory.loadingMore")
                    : t("approvalHistory.loadMore")}
                </button>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  override render() {
    const body = renderSettingsPage(
      html`
        <p class="settings-page__intro">${t("approvalHistory.description")}</p>
        ${!this.connected
          ? html`<div class="callout warn">${t("approvalHistory.offline")}</div>`
          : nothing}
        ${this.error
          ? html`
              <div class="callout danger">
                ${this.error}
                <button class="btn btn--sm" @click=${() => void this.loadPage(true)}>
                  ${t("common.retry")}
                </button>
              </div>
            `
          : nothing}
        ${this.renderTable()}
      `,
      { wide: true },
    );
    return html`
      <section class="content-header">
        <div><div class="page-title">${titleForRoute("approvals")}</div></div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-approvals-page")) {
  customElements.define("openclaw-approvals-page", ApprovalsPage);
}
