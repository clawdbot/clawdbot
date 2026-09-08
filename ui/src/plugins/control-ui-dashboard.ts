import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { ensureCustomElementDefined } from "../app/lazy-custom-element.ts";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import {
  acquireBoardProviderForSession,
  boardExists,
  boardProviderCacheKey,
  type BoardProvider,
  type BoardProviderLease,
  type BoardViewCallbacks,
} from "../lib/board/provider.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "./control-ui-dashboard.css";

function ensureBoardViewElement(): Promise<void> {
  return ensureCustomElementDefined(
    "openclaw-board-view",
    () => import("../components/board/board-view.ts"),
  );
}

class PluginSessionDashboard extends OpenClawLightDomElement {
  @property({ attribute: false }) session: BoardGetParams | null = null;
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) canMutate = false;
  @property({ attribute: false }) canGrant = false;
  @property({ attribute: false }) presented = true;

  @state() private provider: BoardProvider | null = null;
  @state() private expanded = false;
  @state() private activeTabId = "";
  @state() private viewError: string | null = null;
  private viewLoad: Promise<void> | null = null;
  private lease:
    | (BoardProviderLease & {
        client: GatewayBrowserClient;
        cacheKey: string;
        session: BoardGetParams;
      })
    | null = null;
  private unsubscribeSnapshot: (() => void) | null = null;
  private expansionInitialized = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override updated(): void {
    this.viewLoad ??= ensureBoardViewElement().catch((error: unknown) => {
      this.viewError = error instanceof Error ? error.message : String(error);
    });
    this.synchronizeProvider();
  }

  override disconnectedCallback(): void {
    this.releaseProvider();
    super.disconnectedCallback();
  }

  private synchronizeProvider(): void {
    const session = this.session;
    const client = this.client;
    // Lit still drains queued updates after removal; only a mounted card may own a lease.
    if (!this.isConnected || !session?.sessionKey.trim() || !client) {
      this.releaseProvider();
      return;
    }
    const key = boardProviderCacheKey(session);
    if (this.lease?.client === client && this.lease.cacheKey === key) {
      if (
        this.lease.session.sessionKey !== session.sessionKey ||
        this.lease.session.agentId !== session.agentId
      ) {
        // Canonical aliases share a transport; native views still need the latest query identity.
        this.lease.session = { ...session };
        this.requestUpdate();
      }
      this.lease.update(client, this.connected, {
        canPinWidgets: false,
        canPinMcpApps: false,
        canMutate: this.canMutate,
        canGrant: this.canGrant,
      });
      return;
    }

    this.releaseProvider();
    this.expansionInitialized = false;
    this.activeTabId = "";
    const lease = acquireBoardProviderForSession(
      session,
      client,
      this.connected,
      false,
      false,
      this.canMutate,
      this.canGrant,
    );
    this.lease = { ...lease, client, cacheKey: key, session: { ...session } };
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
    if (!this.expansionInitialized && provider.hasLoadedSnapshot) {
      this.expansionInitialized = true;
      this.expanded = boardExists(snapshot);
    }
  }

  override render() {
    const provider = this.provider;
    const snapshot = provider?.snapshot$.value;
    const session = this.lease?.session;
    const hasBoard = Boolean(snapshot && boardExists(snapshot));
    const callbacks = provider
      ? ({
          appViewGeneration: provider.appViewGeneration,
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

    return html`
      <section class="plugin-session-dashboard">
        <button
          type="button"
          class="plugin-session-dashboard__toggle"
          aria-expanded=${this.expanded ? "true" : "false"}
          @click=${() => {
            this.expansionInitialized = true;
            this.expanded = !this.expanded;
          }}
        >
          <span class="plugin-session-dashboard__title">
            ${icons.kanban}<span>${t("pluginUi.dashboardTitle")}</span>
          </span>
          <span class="plugin-session-dashboard__chevron" aria-hidden="true"
            >${icons.arrowDown}</span
          >
        </button>
        <div class="plugin-session-dashboard__body" ?hidden=${!this.expanded}>
          ${
            this.viewError
              ? html`<p role="alert">${this.viewError}</p>
                  <button
                    type="button"
                    @click=${() => {
                      this.viewLoad = null;
                      this.viewError = null;
                    }}
                  >
                    ${t("common.retry")}
                  </button>`
              : hasBoard && provider && snapshot && session && callbacks
                ? html`
                    <openclaw-board-view
                      .active=${this.expanded && this.presented}
                      .session=${session}
                      .snapshot=${snapshot}
                      .activeTabId=${this.activeTabId}
                      .widgetFrameUrl=${(name: string, revision: number) =>
                        provider.widgetFrameUrl(name, revision)}
                      .callbacks=${callbacks}
                      .sessions=${[]}
                      .canMutate=${this.canMutate}
                      .canGrant=${this.canGrant}
                    ></openclaw-board-view>
                  `
                : html`<p class="plugin-session-dashboard__empty">
                    ${t("pluginUi.dashboardEmpty")}
                  </p>`
          }
        </div>
        ${
          !this.expanded && this.expansionInitialized && !hasBoard
            ? html`<p class="plugin-session-dashboard__collapsed-empty">
                ${t("pluginUi.dashboardEmpty")}
              </p>`
            : nothing
        }
      </section>
    `;
  }
}

if (!customElements.get("openclaw-plugin-session-dashboard")) {
  customElements.define("openclaw-plugin-session-dashboard", PluginSessionDashboard);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-session-dashboard": PluginSessionDashboard;
  }
}
