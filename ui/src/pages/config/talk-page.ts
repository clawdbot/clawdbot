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
import { isTalkGptLiveModel, resolveTalkRealtimeSelection } from "./talk-schema.ts";
import {
  renderTalk,
  selectedTalkProviderOption,
  talkProviderConfigKeys,
  type TalkCatalogState,
  type TalkRealtimeProviderOption,
} from "./talk.ts";

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
    transports: provider.transports ?? [],
    defaultModel: provider.defaultModel ?? null,
  };
}

/** Transports whose sessions are client-owned (`talk.client.create`). */
const TALK_CLIENT_OWNED_TRANSPORTS = new Set(["webrtc", "provider-websocket"]);

class TalkSettingsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) configObject: Record<string, unknown> = {};
  @property({ attribute: false }) buildEditor: TalkPageProps["buildEditor"] = () => html``;

  @state() private catalog: TalkCatalogState = { kind: "unavailable" };

  private connection: CatalogConnection | null = null;
  private catalogRequestId = 0;
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
    // Initial load, config-hash refresh, and focus refresh can overlap on the
    // same connection; only the newest request may write the catalog, or a
    // slow older response would overwrite a fresher one.
    const requestId = ++this.catalogRequestId;
    try {
      const result = await client.request<TalkCatalogResult>("talk.catalog", {});
      this.applyCatalog(connection, requestId, {
        kind: "ready",
        ready: result.realtime.ready === true,
        activeProvider: result.realtime.activeProvider ?? null,
        providers: result.realtime.providers.map(toProviderOption),
      });
    } catch {
      // The catalog only powers the pickers; the page still renders the raw
      // configured values when it cannot be read.
      this.applyCatalog(connection, requestId, { kind: "unavailable" });
    }
  }

  private applyCatalog(
    connection: CatalogConnection,
    requestId: number,
    catalog: TalkCatalogState,
  ) {
    if (
      !this.isConnected ||
      this.connection !== connection ||
      this.catalogRequestId !== requestId
    ) {
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
  private refreshCatalogOnConfigChange(configState: {
    configSnapshot?: { hash?: string | null } | null;
  }) {
    const hash = configState.configSnapshot?.hash ?? null;
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

  /**
   * The pickers advertise "Provider default", so a null pick must clear every
   * key that could keep supplying the old value: the top-level override, the
   * legacy speakerVoiceId spelling, and the selected provider's own entry
   * (matched by configured spelling, canonical id, and aliases). Removing only
   * the top-level key would make Default a no-op over provider-level config.
   */
  private changeModel(model: string | null) {
    const runtimeConfig = this.context.runtimeConfig;
    if (model !== null) {
      runtimeConfig.patchForm(["talk", "realtime", "model"], model);
      // GPT-Live is WebRTC-only; a configured relay or provider-websocket
      // transport would make the just-picked model fail at session create, so
      // clearing it lets the default client-owned WebRTC path apply.
      const transport = this.liveSelection().transport;
      if (isTalkGptLiveModel(model) && transport && transport !== "webrtc") {
        runtimeConfig.removeFormValue(["talk", "realtime", "transport"]);
      }
      return;
    }
    runtimeConfig.removeFormValue(["talk", "realtime", "model"]);
    for (const key of this.selectedProviderConfigKeys()) {
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "model"]);
    }
  }

  private changeVoice(voice: string | null) {
    const runtimeConfig = this.context.runtimeConfig;
    if (voice !== null) {
      runtimeConfig.patchForm(["talk", "realtime", "speakerVoice"], voice);
      return;
    }
    runtimeConfig.removeFormValue(["talk", "realtime", "speakerVoice"]);
    runtimeConfig.removeFormValue(["talk", "realtime", "speakerVoiceId"]);
    for (const key of this.selectedProviderConfigKeys()) {
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "speakerVoice"]);
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "voice"]);
    }
  }

  private selectedProviderConfigKeys(): string[] {
    const selection = this.liveSelection();
    const option = selectedTalkProviderOption(this.catalog, selection);
    return talkProviderConfigKeys(selection, option);
  }

  /**
   * Mutation helpers must read the live form draft, not the configObject prop:
   * the form updates immutably and the prop only refreshes on the next render,
   * so a same-tick read through the prop sees pre-write values.
   */
  private liveSelection() {
    const form = this.context.runtimeConfig.state.configForm;
    const configObject =
      form && typeof form === "object" ? (form as Record<string, unknown>) : this.configObject;
    return resolveTalkRealtimeSelection(configObject);
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
    for (const key of ["model", "speakerVoice", "speakerVoiceId"]) {
      runtimeConfig.removeFormValue(["talk", "realtime", key]);
    }
    if (providerId === null) {
      // Auto keeps the current transport: it was valid for the configuration
      // auto-selection will re-derive from (clearing it would strand a
      // relay-only provider on the client-owned default).
      runtimeConfig.removeFormValue(["talk", "realtime", "provider"]);
      return;
    }
    runtimeConfig.removeFormValue(["talk", "realtime", "transport"]);
    runtimeConfig.patchForm(["talk", "realtime", "provider"], providerId);
    // A relay-only provider (no client-owned transport) needs the transport
    // written explicitly: an unset transport routes to talk.client.create,
    // which such a provider cannot serve.
    const option =
      this.catalog.kind === "ready"
        ? this.catalog.providers.find((provider) => provider.id === providerId)
        : undefined;
    const relayOnly =
      option !== undefined &&
      option.transports.length > 0 &&
      !option.transports.some((transport) => TALK_CLIENT_OWNED_TRANSPORTS.has(transport));
    if (relayOnly) {
      runtimeConfig.patchForm(["talk", "realtime", "transport"], "gateway-relay");
    }
  }

  override render() {
    const runtimeState = this.context.runtimeConfig.state;
    return renderTalk({
      selection: resolveTalkRealtimeSelection(this.configObject),
      catalog: this.catalog,
      configBusy:
        runtimeState.configLoading || runtimeState.configSaving || runtimeState.configApplying,
      onProviderChange: (providerId) => this.changeProvider(providerId),
      onModelChange: (model) => this.changeModel(model),
      onVoiceChange: (voice) => this.changeVoice(voice),
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
