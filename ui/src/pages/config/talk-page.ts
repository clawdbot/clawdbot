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
  /** `undefined` = baseline not yet observed; `null` = no snapshot hash. */
  private lastCatalogConfigHash: string | null | undefined;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) =>
        this.syncCatalog(gateway.snapshot.client, gateway.snapshot.phase === "connected"),
    )
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
      (runtimeConfig) => this.refreshCatalogOnConfigChange(runtimeConfig.state),
    );

  /**
   * The GPT-Live setup this page advertises runs `openclaw models auth login`
   * in a terminal; that changes credential readiness without advancing the
   * config hash, so returning focus to the window re-reads the catalog.
   */
  private readonly refreshOnFocus = () => {
    const connection = this.connection;
    if (connection?.client && connection.connected) {
      void this.loadCatalog(connection.client, connection);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("focus", this.refreshOnFocus);
  }

  override disconnectedCallback() {
    window.removeEventListener("focus", this.refreshOnFocus);
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

  /**
   * Readiness can change on the same connection when a config write lands (the
   * gateway may hot-apply talk config without dropping the socket), so the
   * catalog re-reads whenever the config snapshot hash advances. The hash is
   * the durable ack signal; transient saving flags can be skipped entirely by
   * a fast save.
   */
  private refreshCatalogOnConfigChange(state: {
    configSnapshot?: { hash?: string | null } | null;
  }) {
    const hash = state.configSnapshot?.hash ?? null;
    if (this.lastCatalogConfigHash === undefined) {
      this.lastCatalogConfigHash = hash;
      return;
    }
    if (hash === null || hash === this.lastCatalogConfigHash) {
      return;
    }
    this.lastCatalogConfigHash = hash;
    const connection = this.connection;
    if (connection?.client && connection.connected) {
      void this.loadCatalog(connection.client, connection);
    }
  }

  private patchRealtimeValue(key: "provider" | "model" | "speakerVoice", value: string | null) {
    const runtimeConfig = this.context.runtimeConfig;
    if (value === null) {
      runtimeConfig.removeFormValue(["talk", "realtime", key]);
      return;
    }
    runtimeConfig.patchForm(["talk", "realtime", key], value);
  }

  /**
   * Model, voice, and transport picks are provider-coupled (an xAI session
   * cannot use a gpt-live model, marin, or webrtc), so a provider switch
   * clears the top-level overrides instead of carrying them across. Each
   * provider's own `talk.realtime.providers.<id>` entry survives untouched and
   * supplies that provider's fallback values.
   */
  private changeProvider(providerId: string | null) {
    const runtimeConfig = this.context.runtimeConfig;
    for (const key of ["model", "speakerVoice", "speakerVoiceId", "transport"]) {
      runtimeConfig.removeFormValue(["talk", "realtime", key]);
    }
    this.patchRealtimeValue("provider", providerId);
  }

  override render() {
    const runtimeState = this.context.runtimeConfig.state;
    return renderTalk({
      selection: resolveTalkRealtimeSelection(this.configObject),
      catalog: this.catalog,
      configBusy:
        runtimeState.configLoading || runtimeState.configSaving || runtimeState.configApplying,
      onProviderChange: (providerId) => this.changeProvider(providerId),
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
