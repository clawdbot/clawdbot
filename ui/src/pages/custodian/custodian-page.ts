import { consume } from "@lit/context";
import type { SystemChangeEntry, SystemChangesListResult } from "@openclaw/gateway-protocol";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import "../../components/openclaw-mascot.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../../styles/custodian.css";
import { renderCustodianChangeHistory } from "./custodian-history.ts";
import { custodianSessionStore, type CustodianSessionStore } from "./custodian-session-store.ts";
import "./custodian-surface.ts";

const SYSTEM_CHANGE_PAGE_SIZE = 50;

export class CustodianPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) newAgentIntent = false;
  @property({ attribute: false }) store: CustodianSessionStore = custodianSessionStore;

  @state() private historyAvailable = false;
  @state() private historyOpen = false;
  @state() private historyEntries: SystemChangeEntry[] = [];
  @state() private historyNextCursor: string | null = null;
  @state() private historyLoading = false;
  @state() private historyLoadingMore = false;
  @state() private historyError: string | null = null;

  private historyLoaded = false;
  private historyClient: GatewayBrowserClient | null = null;
  private historyRequestEpoch = 0;
  private subscribedStore: CustodianSessionStore | null = null;
  private storeCleanup: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.subscribeToStore();
  }

  override disconnectedCallback(): void {
    this.storeCleanup?.();
    this.storeCleanup = null;
    this.subscribedStore = null;
    super.disconnectedCallback();
  }

  protected override async getUpdateComplete(): Promise<boolean> {
    const complete = await super.getUpdateComplete();
    const surface = this.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-custodian-surface",
    );
    await surface?.updateComplete;
    return complete;
  }

  override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has("store")) {
      this.subscribeToStore();
    }
    this.synchronizeHistoryClient();
  }

  private subscribeToStore(): void {
    if (!this.isConnected || this.subscribedStore === this.store) {
      return;
    }
    this.storeCleanup?.();
    this.subscribedStore = this.store;
    this.storeCleanup = this.store.subscribe(() => this.requestUpdate());
  }

  private synchronizeHistoryClient(): void {
    const snapshot = this.context.gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const available =
      client !== null && isGatewayMethodAdvertised(snapshot, "openclaw.changes.list") === true;
    if (client !== this.historyClient || available !== this.historyAvailable) {
      this.historyClient = client;
      this.historyAvailable = available;
      this.historyOpen = false;
      this.resetHistory();
    }
  }

  private resetHistory(): void {
    this.historyRequestEpoch += 1;
    this.historyEntries = [];
    this.historyNextCursor = null;
    this.historyLoading = false;
    this.historyLoadingMore = false;
    this.historyError = null;
    this.historyLoaded = false;
  }

  private toggleHistory(): void {
    this.historyOpen = !this.historyOpen;
    if (this.historyOpen && !this.historyLoading && !this.historyLoadingMore) {
      void this.loadHistory(true);
    }
  }

  private async loadHistory(reset: boolean): Promise<void> {
    const client = this.historyClient;
    const cursor = reset ? undefined : (this.historyNextCursor ?? undefined);
    if (
      !client ||
      !this.historyAvailable ||
      this.historyLoading ||
      this.historyLoadingMore ||
      (!reset && !cursor)
    ) {
      return;
    }
    const epoch = ++this.historyRequestEpoch;
    if (reset) {
      this.historyLoading = true;
    } else {
      this.historyLoadingMore = true;
    }
    this.historyError = null;
    const isCurrent = () =>
      this.isConnected &&
      this.historyClient === client &&
      this.historyRequestEpoch === epoch &&
      this.historyAvailable;
    try {
      const result = await client.request<SystemChangesListResult>("openclaw.changes.list", {
        limit: SYSTEM_CHANGE_PAGE_SIZE,
        ...(cursor ? { beforeCursor: cursor } : {}),
      });
      if (!isCurrent()) {
        return;
      }
      this.historyEntries = reset ? result.entries : [...this.historyEntries, ...result.entries];
      this.historyNextCursor = result.nextCursor ?? null;
      this.historyLoaded = true;
    } catch {
      if (isCurrent()) {
        this.historyError = t("custodian.history.requestFailed");
        this.historyLoaded = true;
      }
    } finally {
      if (isCurrent()) {
        this.historyLoading = false;
        this.historyLoadingMore = false;
      }
    }
  }

  override render() {
    const historyContent =
      this.historyOpen && this.historyAvailable
        ? renderCustodianChangeHistory({
            entries: this.historyEntries,
            error: this.historyError,
            loaded: this.historyLoaded,
            loading: this.historyLoading,
            loadingMore: this.historyLoadingMore,
            nextCursor: this.historyNextCursor,
            onLoad: (reset) => void this.loadHistory(reset),
          })
        : nothing;
    return html`
      <section class="custodian custodian--page">
        <header class="custodian__header custodian__column">
          <div class="custodian__identity">
            <div class="custodian__mark" aria-hidden="true">
              <openclaw-mascot
                .mood=${this.store.sending ? "thinking" : "idle"}
                .size=${38}
              ></openclaw-mascot>
            </div>
            <div>
              <h1>${t("custodian.title")}</h1>
              <p>${t(this.onboarding ? "custodian.subtitle" : "custodian.subtitleCaretaker")}</p>
            </div>
          </div>
          <div class="custodian__header-actions">
            ${this.historyAvailable
              ? html`<button
                  class="btn btn--ghost custodian__history-toggle"
                  type="button"
                  aria-expanded=${this.historyOpen ? "true" : "false"}
                  @click=${() => this.toggleHistory()}
                >
                  ${t("custodian.history.button")}
                </button>`
              : nothing}
            ${this.onboarding
              ? html`<button
                  class="btn btn--ghost"
                  type="button"
                  @click=${() => this.store.exitSetup()}
                >
                  ${t("custodian.exitSetup")}
                </button>`
              : nothing}
          </div>
        </header>

        <openclaw-custodian-surface
          class="custodian__column"
          .store=${this.store}
          .onboarding=${this.onboarding}
          .newAgentIntent=${this.newAgentIntent}
          .historyContent=${historyContent}
        ></openclaw-custodian-surface>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-custodian-page")) {
  customElements.define("openclaw-custodian-page", CustodianPage);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-page": CustodianPage;
  }
}
