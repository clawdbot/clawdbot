import { consume } from "@lit/context";
// Controller for the curated Talk settings page. Owns the talk.catalog read
// that feeds the provider/model/voice pickers; all writes go through the shared
// config form draft so the embedded schema editor below stays in sync.
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { resolveTalkRealtimeSelection } from "./talk-schema.ts";
import { renderTalk, type TalkCatalogState, type TalkRealtimeProviderOption } from "./talk.ts";

type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

/**
 * One gateway connection phase; object identity is the request generation so a
 * catalog load that started under an older phase is dropped, never applied
 * (same shape as memory-page.ts).
 */
type CatalogConnection = {
  client: GatewayClient | null;
  connected: boolean;
};

type TalkPageProps = {
  configObject: Record<string, unknown>;
  /** Builds the embedded schema editor over the full `talk` section. */
  buildEditor: () => TemplateResult;
};

function toProviderOption(
  provider: TalkCatalogResult["realtime"]["providers"][number],
): TalkRealtimeProviderOption {
  return {
    id: provider.id,
    label: provider.label,
    configured: provider.configured,
    aliases: provider.aliases ?? [],
    models: provider.models ?? [],
    voices: provider.voices ?? [],
    defaultModel: provider.defaultModel ?? null,
  };
}

class TalkSettingsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) configObject: Record<string, unknown> = {};
  @property({ attribute: false }) buildEditor: TalkPageProps["buildEditor"] = () => html``;

  @state() private catalog: TalkCatalogState = { kind: "unavailable" };

  private connection: CatalogConnection | null = null;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
    (gateway) => this.syncCatalog(gateway.snapshot.client, gateway.snapshot.phase === "connected"),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.connection = null;
    this.catalog = { kind: "unavailable" };
    super.disconnectedCallback();
  }

  private syncCatalog(client: GatewayClient | null, connected: boolean) {
    // connecting -> connected keeps the same client object; keying only on the
    // client would leave a page mounted mid-handshake without a catalog.
    if (this.connection?.client === client && this.connection.connected === connected) {
      return;
    }
    const connection: CatalogConnection = { client, connected };
    this.connection = connection;
    if (!client || !connected) {
      this.catalog = { kind: "unavailable" };
      return;
    }
    this.catalog = { kind: "loading" };
    void this.loadCatalog(client, connection);
  }

  private async loadCatalog(client: GatewayClient, connection: CatalogConnection) {
    try {
      const result = await client.request<TalkCatalogResult>("talk.catalog", {});
      this.applyCatalog(connection, {
        kind: "ready",
        ready: result.realtime.ready === true,
        activeProvider: result.realtime.activeProvider ?? null,
        providers: result.realtime.providers.map(toProviderOption),
      });
    } catch {
      // The catalog only powers the pickers; the page still renders the raw
      // configured values when it cannot be read.
      this.applyCatalog(connection, { kind: "unavailable" });
    }
  }

  private applyCatalog(connection: CatalogConnection, catalog: TalkCatalogState) {
    if (!this.isConnected || this.connection !== connection) {
      return;
    }
    this.catalog = catalog;
  }

  private patchRealtimeValue(key: "provider" | "model" | "speakerVoice", value: string | null) {
    const runtimeConfig = this.context.runtimeConfig;
    if (value === null) {
      runtimeConfig.removeFormValue(["talk", "realtime", key]);
      return;
    }
    runtimeConfig.patchForm(["talk", "realtime", key], value);
  }

  override render() {
    const runtimeState = this.context.runtimeConfig.state;
    return renderTalk({
      selection: resolveTalkRealtimeSelection(this.configObject),
      catalog: this.catalog,
      configBusy:
        runtimeState.configLoading || runtimeState.configSaving || runtimeState.configApplying,
      onProviderChange: (providerId) => this.patchRealtimeValue("provider", providerId),
      onModelChange: (model) => this.patchRealtimeValue("model", model),
      onVoiceChange: (voice) => this.patchRealtimeValue("speakerVoice", voice),
      editor: this.buildEditor(),
    });
  }
}

if (!customElements.get("openclaw-talk-settings")) {
  customElements.define("openclaw-talk-settings", TalkSettingsPage);
}

export function renderTalkPage(props: TalkPageProps) {
  return html`
    <openclaw-talk-settings
      .configObject=${props.configObject}
      .buildEditor=${props.buildEditor}
    ></openclaw-talk-settings>
  `;
}
