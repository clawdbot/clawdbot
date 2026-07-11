import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { buildModelProviderCards } from "./data.ts";
import {
  EMPTY_MODEL_PROVIDERS_DATA,
  loadModelProvidersData,
  MODEL_PROVIDERS_COST_DAYS,
  type ModelProvidersData,
} from "./load.ts";
import { renderModelProviders } from "./view.ts";

export type ModelProvidersRouteData = {
  data: ModelProvidersData;
  /** Client the loader fetched from; null when it ran disconnected. */
  client: GatewayBrowserClient | null;
};

export class ModelProvidersPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelProvidersRouteData | undefined;

  @state() private data: ModelProvidersData | null = null;
  @state() private refreshing = false;

  /** Client the current data was loaded from; a new client means stale data. */
  private dataClient: GatewayBrowserClient | null = null;
  private refreshEpoch = 0;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );

  override disconnectedCallback() {
    this.refreshEpoch += 1;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("routeData") && this.routeData) {
      this.data = this.routeData.data;
      // Adopt the client the loader actually fetched from — not the current
      // snapshot — so a gateway swap during the in-flight load still reads as
      // stale and triggers the automatic refresh.
      this.dataClient = this.routeData.client;
    }
  }

  override updated() {
    // Fetch when the loader ran disconnected (empty data) and the gateway is
    // now up, or when a reconnect/gateway switch produced a new client — the
    // held snapshot belongs to the previous gateway then.
    const snapshot = this.context.gateway.snapshot;
    if (!snapshot.connected || !snapshot.client || this.refreshing) {
      return;
    }
    const stale = this.data === null || this.data.updatedAt === null;
    if (stale || snapshot.client !== this.dataClient) {
      void this.refresh({ force: false });
    }
  }

  private async refresh(opts: { force: boolean }) {
    const client = this.context.gateway.snapshot.client;
    if (!client || this.refreshing) {
      return;
    }
    const epoch = ++this.refreshEpoch;
    this.refreshing = true;
    try {
      const data = await loadModelProvidersData(client, opts.force ? { refresh: true } : undefined);
      if (epoch === this.refreshEpoch) {
        this.data = data;
        this.dataClient = client;
      }
    } finally {
      if (epoch === this.refreshEpoch) {
        this.refreshing = false;
      }
    }
  }

  override render() {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const data = this.data ?? EMPTY_MODEL_PROVIDERS_DATA;
    const body = renderModelProviders({
      connected: gatewaySnapshot.connected,
      loading: gatewaySnapshot.connected && this.data === null,
      refreshing: this.refreshing,
      error: data.error,
      updatedAt: data.updatedAt,
      costDays: MODEL_PROVIDERS_COST_DAYS,
      cards: buildModelProviderCards(data),
      onRefresh: () => void this.refresh({ force: true }),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("model-providers")}</div>
          <div class="page-sub">${subtitleForRoute("model-providers")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

customElements.define("openclaw-model-providers-page", ModelProvidersPage);
