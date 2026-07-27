import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  acquireBoardProviderForSession,
  boardExists,
  boardProviderCacheKey,
  boardProviderForSession,
  GatewayBoardProvider,
  type BoardProvider,
  type BoardProviderLease,
  type BoardViewCallbacks,
} from "../../lib/board/provider.ts";
import type { BoardViewSnapshot } from "../../lib/board/view-types.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

function ensureBoardViewElement(): Promise<void> {
  return ensureCustomElementDefined(
    "openclaw-board-view",
    () => import("../../components/board/board-view.ts"),
  );
}

class WorkboardCardDashboard extends OpenClawLightDomElement {
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) canMutate = false;
  @property({ attribute: false }) canGrant = false;

  @state() private provider: BoardProvider | null = null;
  @state() private expanded = false;
  @state() private activeTabId = "";
  private lease:
    | (BoardProviderLease & { client: GatewayBrowserClient; sessionKey: string })
    | null = null;
  private unsubscribeSnapshot: (() => void) | null = null;
  private expansionInitialized = false;

  override updated(): void {
    void ensureBoardViewElement().catch(() => undefined);
    this.synchronizeProvider();
  }

  override disconnectedCallback(): void {
    this.releaseProvider();
    super.disconnectedCallback();
  }

  private synchronizeProvider(): void {
    const sessionKey = this.sessionKey.trim();
    const client = this.client;
    if (!sessionKey || !client) {
      this.releaseProvider();
      return;
    }
    const key = boardProviderCacheKey(sessionKey);
    if (this.lease?.client === client && this.lease.sessionKey === key) {
      boardProviderForSession(
        key,
        client,
        true,
        this.connected,
        false,
        false,
        this.canMutate,
        this.canGrant,
      );
      return;
    }

    this.releaseProvider();
    this.expansionInitialized = false;
    this.activeTabId = "";
    const lease = acquireBoardProviderForSession(
      key,
      client,
      this.connected,
      false,
      false,
      this.canMutate,
      this.canGrant,
    );
    this.lease = { ...lease, client, sessionKey: key };
    this.provider = lease.provider;
    this.unsubscribeSnapshot = lease.provider.snapshot$.subscribe(() => {
      this.reconcileSnapshot(lease.provider);
      this.requestUpdate();
    });
    this.reconcileSnapshot(lease.provider);
    this.requestUpdate();
  }

  private releaseProvider(): void {
    this.unsubscribeSnapshot?.();
    this.unsubscribeSnapshot = null;
    this.lease?.release();
    this.lease = null;
    this.provider = null;
  }

  private reconcileSnapshot(provider: BoardProvider): void {
    const snapshot = provider.snapshot$.value;
    const firstTabId = snapshot.tabs[0]?.tabId ?? "";
    if (!snapshot.tabs.some((tab) => tab.tabId === this.activeTabId)) {
      this.activeTabId = firstTabId;
    }
    const loaded = !(provider instanceof GatewayBoardProvider) || provider.hasLoadedSnapshot;
    if (!this.expansionInitialized && loaded) {
      this.expansionInitialized = true;
      this.expanded = boardExists(snapshot);
    }
  }

  override render() {
    const provider = this.provider;
    const snapshot = provider?.snapshot$.value;
    const hasBoard = Boolean(snapshot && boardExists(snapshot));
    const callbacks = provider
      ? ({
          applyOps: (ops) => provider.applyOps(ops),
          grant: (name, decision) => provider.grant(name, decision),
          selectTab: (tabId) => {
            this.activeTabId = tabId;
          },
          frameLoadFailed: (name) => provider.refreshWidgetFrame(name),
          widgetAppView: (name, revision) => provider.widgetAppView(name, revision),
          refreshWidgetAppView: (name, revision) => provider.refreshWidgetAppView(name, revision),
        } satisfies BoardViewCallbacks)
      : null;
    const boardSnapshot = snapshot as BoardViewSnapshot | undefined;

    return html`
      <section class="workboard-detail__section workboard-card-dashboard">
        <button
          type="button"
          class="workboard-card-dashboard__toggle"
          aria-expanded=${this.expanded ? "true" : "false"}
          @click=${() => {
            this.expansionInitialized = true;
            this.expanded = !this.expanded;
          }}
        >
          <span class="workboard-card-dashboard__title">
            ${icons.kanban}<span>${t("workboard.dashboardTitle")}</span>
          </span>
          <span class="workboard-card-dashboard__chevron" aria-hidden="true"
            >${icons.arrowDown}</span
          >
        </button>
        <div class="workboard-card-dashboard__body" ?hidden=${!this.expanded}>
          ${hasBoard && provider && boardSnapshot && callbacks
            ? html`
                <openclaw-board-view
                  .snapshot=${boardSnapshot}
                  .activeTabId=${this.activeTabId}
                  .widgetFrameUrl=${(name: string, revision: number) =>
                    provider.widgetFrameUrl(name, revision)}
                  .callbacks=${callbacks}
                  .sessions=${[]}
                  .canMutate=${provider.canMutate}
                  .canGrant=${provider.canGrant}
                ></openclaw-board-view>
              `
            : html`<p class="workboard-card-dashboard__empty">${t("workboard.dashboardEmpty")}</p>`}
        </div>
        ${!this.expanded && this.expansionInitialized && !hasBoard
          ? html`<p class="workboard-card-dashboard__collapsed-empty">
              ${t("workboard.dashboardEmpty")}
            </p>`
          : nothing}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-workboard-card-dashboard")) {
  customElements.define("openclaw-workboard-card-dashboard", WorkboardCardDashboard);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-workboard-card-dashboard": WorkboardCardDashboard;
  }
}
