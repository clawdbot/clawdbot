// Settings page owning the dashboard's gateway connection draft (URL, token,
// password, default session key) plus the latest handshake snapshot.
import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { loadGatewaySessionSelection, loadSettings, type UiSettings } from "../../app/settings.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderConnection } from "./view.ts";

class ConnectionPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private settings: UiSettings = loadSettings();
  @state() private password = "";
  @state() private gatewayTokenVisible = false;
  @state() private gatewayPasswordVisible = false;

  // Distinguishes an operator-edited session key from the stored selection so
  // Connect only overrides the per-gateway selection after an explicit edit.
  private sessionKeyDirty = false;
  private gatewayClient: ApplicationContext["gateway"]["snapshot"]["client"] = null;

  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        this.resetDraft(gateway);
        return gateway.subscribe((snapshot) => {
          if (snapshot.client !== this.gatewayClient) {
            this.resetDraft(gateway);
          } else if (!snapshot.connected) {
            this.resetSensitiveUi();
          }
          this.requestUpdate();
        });
      },
    )
    .watch(
      () => this.context?.channels,
      (channels, notify) => channels.subscribe(notify),
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.resetSensitiveUi();
    super.disconnectedCallback();
  }

  private resetSensitiveUi() {
    this.gatewayTokenVisible = false;
    this.gatewayPasswordVisible = false;
  }

  private resetDraft(gateway: ApplicationContext["gateway"]) {
    const sessionKey = gateway.snapshot.sessionKey;
    const { gatewayUrl, token, password } = gateway.connection;
    this.gatewayClient = gateway.snapshot.client;
    this.settings = {
      ...loadSettings(),
      gatewayUrl,
      token,
      sessionKey,
      lastActiveSessionKey: sessionKey,
    };
    this.password = password;
    this.sessionKeyDirty = false;
    this.resetSensitiveUi();
  }

  private connect() {
    const session = this.sessionKeyDirty
      ? {
          sessionKey: this.settings.sessionKey,
          lastActiveSessionKey: this.settings.sessionKey,
        }
      : loadGatewaySessionSelection(this.settings.gatewayUrl);
    this.settings = { ...this.settings, ...session };
    this.sessionKeyDirty = false;
    this.context.gateway.connect({
      gatewayUrl: this.settings.gatewayUrl,
      token: this.settings.token,
      password: this.password,
      sessionKey: session.sessionKey,
    });
  }

  override render() {
    const gateway = this.context.gateway.snapshot;
    const body = renderConnection({
      connected: gateway.connected,
      hello: gateway.hello,
      settings: this.settings,
      password: this.password,
      lastError: gateway.lastError,
      lastChannelsRefresh: this.context.channels.state.channelsLastSuccess,
      showGatewayToken: this.gatewayTokenVisible,
      showGatewayPassword: this.gatewayPasswordVisible,
      onConnectionChange: (patch) => {
        this.settings = { ...this.settings, ...patch };
      },
      onPasswordChange: (next) => (this.password = next),
      onSessionKeyChange: (sessionKey) => {
        this.sessionKeyDirty = true;
        this.settings = {
          ...this.settings,
          sessionKey,
          lastActiveSessionKey: sessionKey,
        };
      },
      onToggleGatewayTokenVisibility: () => {
        this.gatewayTokenVisible = !this.gatewayTokenVisible;
      },
      onToggleGatewayPasswordVisibility: () => {
        this.gatewayPasswordVisible = !this.gatewayPasswordVisible;
      },
      onConnect: () => this.connect(),
      onRefresh: () => void this.context.channels.refresh(false),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("connection")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-connection-page")) {
  customElements.define("openclaw-connection-page", ConnectionPage);
}
