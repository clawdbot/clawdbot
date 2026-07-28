// Settings page owning the dashboard's gateway connection draft (URL, token,
// password, default session key) plus the latest handshake snapshot.
import "../../styles/connection.css";
import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { loadGatewaySessionSelection, loadSettings, type UiSettings } from "../../app/settings.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { isUnknownSystemInfoMethodError, supportsSystemInfo } from "./system-info.ts";
import { renderConnection } from "./view.ts";

const SYSTEM_INFO_POLL_INTERVAL_MS = 10_000;

export { supportsSystemInfo } from "./system-info.ts";

export class ConnectionPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private settings: UiSettings = loadSettings();
  @state() private password = "";
  @state() private gatewayTokenVisible = false;
  @state() private gatewayPasswordVisible = false;
  @state() private systemInfo: SystemInfoResult | null = null;
  @state() private systemInfoUnavailable = false;

  // Distinguishes an operator-edited session key from the stored selection so
  // Connect only overrides the per-gateway selection after an explicit edit.
  private sessionKeyDirty = false;
  private gatewayClient: ApplicationContext["gateway"]["snapshot"]["client"] = null;
  private systemInfoGatewaySource: ApplicationContext["gateway"] | null = null;
  private systemInfoClient: GatewayBrowserClient | null = null;
  private systemInfoLoading = false;
  private systemInfoRequestId = 0;

  private readonly systemInfoPolling = new PollController(
    this,
    SYSTEM_INFO_POLL_INTERVAL_MS,
    () => {
      void this.loadSystemInfo();
    },
    false,
  );

  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        this.resetDraft(gateway);
        this.synchronizeSystemInfoGateway(gateway);
        return gateway.subscribe((snapshot) => {
          if (snapshot.client !== this.gatewayClient) {
            this.resetDraft(gateway);
          } else if (snapshot.phase !== "connected") {
            this.resetSensitiveUi();
          }
          this.handleSystemInfoGatewaySnapshot(snapshot);
          this.requestUpdate();
        });
      },
    )
    .watch(
      () => this.context?.channels,
      (channels, notify) => channels.subscribe(notify),
    );

  override disconnectedCallback() {
    this.systemInfoPolling.stop();
    this.invalidateSystemInfoRequest();
    this.systemInfoGatewaySource = null;
    this.systemInfoClient = null;
    this.subscriptions.clear();
    this.resetSensitiveUi();
    super.disconnectedCallback();
  }

  private resetSensitiveUi() {
    this.gatewayTokenVisible = false;
    this.gatewayPasswordVisible = false;
  }

  private synchronizeSystemInfoGateway(gateway: ApplicationContext["gateway"]) {
    if (gateway !== this.systemInfoGatewaySource) {
      this.systemInfoPolling.stop();
      this.invalidateSystemInfoRequest();
      this.systemInfoGatewaySource = gateway;
      this.systemInfoClient = null;
      this.systemInfo = null;
      this.systemInfoUnavailable = false;
    }
    this.handleSystemInfoGatewaySnapshot(gateway.snapshot);
  }

  private handleSystemInfoGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.systemInfoClient;
    const hasSystemInfo = supportsSystemInfo(snapshot.hello);
    this.systemInfoClient = snapshot.client;
    if (clientChanged) {
      this.invalidateSystemInfoRequest();
      this.systemInfo = null;
      this.systemInfoUnavailable = false;
    } else if (snapshot.phase !== "connected") {
      this.invalidateSystemInfoRequest();
      this.systemInfo = null;
    }
    if (snapshot.phase === "connected" && snapshot.hello) {
      this.systemInfoUnavailable = !hasSystemInfo;
      if (!hasSystemInfo) {
        this.invalidateSystemInfoRequest();
        this.systemInfo = null;
      }
    }
    this.syncSystemInfoPolling();
  }

  private syncSystemInfoPolling() {
    const gateway = this.context.gateway.snapshot;
    const shouldPoll =
      this.isConnected &&
      !this.systemInfoUnavailable &&
      gateway.phase === "connected" &&
      supportsSystemInfo(gateway.hello) &&
      gateway.client != null;
    if (!shouldPoll) {
      this.systemInfoPolling.stop();
      return;
    }
    if (this.systemInfoPolling.start()) {
      void this.loadSystemInfo();
    }
  }

  private invalidateSystemInfoRequest() {
    this.systemInfoRequestId += 1;
    this.systemInfoLoading = false;
  }

  private isCurrentSystemInfoRequest(
    requestId: number,
    client: GatewayBrowserClient,
    gatewaySource: ApplicationContext["gateway"],
  ): boolean {
    const gateway = gatewaySource.snapshot;
    return (
      this.isConnected &&
      requestId === this.systemInfoRequestId &&
      this.systemInfoGatewaySource === gatewaySource &&
      this.context.gateway === gatewaySource &&
      gateway.phase === "connected" &&
      gateway.client === client
    );
  }

  private async loadSystemInfo() {
    const gatewaySource = this.systemInfoGatewaySource;
    if (!gatewaySource || gatewaySource !== this.context.gateway) {
      return;
    }
    const gateway = gatewaySource.snapshot;
    const client = gateway.client;
    if (
      gateway.phase !== "connected" ||
      !client ||
      this.systemInfoUnavailable ||
      this.systemInfoLoading
    ) {
      return;
    }

    const requestId = ++this.systemInfoRequestId;
    this.systemInfoLoading = true;
    try {
      const response = await client.request("system.info", {});
      if (!this.isCurrentSystemInfoRequest(requestId, client, gatewaySource)) {
        return;
      }
      this.systemInfo = response as SystemInfoResult;
    } catch (error) {
      if (!this.isCurrentSystemInfoRequest(requestId, client, gatewaySource)) {
        return;
      }
      if (isMissingOperatorReadScopeError(error) || isUnknownSystemInfoMethodError(error)) {
        this.systemInfo = null;
        this.systemInfoUnavailable = true;
        this.systemInfoPolling.stop();
      }
    } finally {
      if (this.isCurrentSystemInfoRequest(requestId, client, gatewaySource)) {
        this.systemInfoLoading = false;
      }
    }
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
      connected: gateway.phase === "connected",
      hello: gateway.hello,
      settings: this.settings,
      password: this.password,
      lastError: gateway.lastError,
      lastChannelsRefresh: this.context.channels.state.channelsLastSuccess,
      systemInfo: this.systemInfo,
      systemInfoUnavailable: this.systemInfoUnavailable,
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
