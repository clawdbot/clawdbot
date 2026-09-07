// Settings page owning this browser's Gateway connection draft (URL, credential,
// default session) and the live handshake summary.
import "../../styles/connection.css";
import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  loadGatewaySessionSelection,
  loadSettings,
  resolveGatewayCredentialsForUrlEdit,
  type UiSettings,
} from "../../app/settings.ts";
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { isUnknownSystemInfoMethodError, supportsSystemInfo } from "./system-info.ts";
import { renderConnection } from "./view.ts";

const SYSTEM_INFO_POLL_INTERVAL_MS = 10_000;
const CONNECTION_DOCS_URL = "https://docs.openclaw.ai/gateway/remote";

export class ConnectionPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private settings: UiSettings = loadSettings();
  @state() private password = "";
  @state() private gatewaySecretVisible = false;
  @state() private systemInfo: SystemInfoResult | null = null;
  @state() private systemInfoUnavailable = false;

  // Distinguishes an operator-edited session key from the stored selection so
  // Connect only overrides the per-gateway selection after an explicit edit.
  private sessionKeyDirty = false;
  private systemInfoLoading = false;

  private readonly systemInfoPolling = new PollController(
    this,
    SYSTEM_INFO_POLL_INTERVAL_MS,
    () => {
      void this.loadSystemInfo();
    },
    false,
  );

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.systemInfoLoading = false;
    },
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
  });

  override disconnectedCallback() {
    this.systemInfoPolling.stop();
    this.resetSensitiveUi();
    super.disconnectedCallback();
  }

  private resetSensitiveUi() {
    this.gatewaySecretVisible = false;
  }

  private handleGatewaySnapshot({
    snapshot,
    initial,
    sourceChanged,
    clientChanged,
  }: GatewayPageChange) {
    if (initial || sourceChanged || clientChanged) {
      this.resetDraft(this.context.gateway);
      this.systemInfo = null;
      this.systemInfoUnavailable = false;
    } else if (snapshot.phase !== "connected") {
      this.resetSensitiveUi();
      this.systemInfo = null;
    }
    if (initial || sourceChanged) {
      this.systemInfoPolling.stop();
    }
    if (snapshot.phase === "connected" && snapshot.hello) {
      this.systemInfoUnavailable = !supportsSystemInfo(snapshot.hello);
      if (this.systemInfoUnavailable) {
        this.gateway.invalidate();
        this.systemInfoLoading = false;
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

  private async loadSystemInfo() {
    const gatewaySource = this.gateway.gateway;
    if (!gatewaySource || gatewaySource !== this.context.gateway) {
      return;
    }
    const scope = this.gateway.capture();
    if (!scope || this.systemInfoUnavailable || this.systemInfoLoading) {
      return;
    }
    // Context can change before Lit rebinds the controller's source.
    const isCurrent = () =>
      this.isConnected && this.context.gateway === gatewaySource && this.gateway.isCurrent(scope);
    this.systemInfoLoading = true;
    try {
      const response = await scope.client.request("system.info", {});
      if (!isCurrent()) {
        return;
      }
      this.systemInfo = response as SystemInfoResult;
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      if (isMissingOperatorReadScopeError(error) || isUnknownSystemInfoMethodError(error)) {
        this.systemInfo = null;
        this.systemInfoUnavailable = true;
        this.systemInfoPolling.stop();
      }
    } finally {
      if (isCurrent()) {
        this.systemInfoLoading = false;
      }
    }
  }

  private resetDraft(gateway: ApplicationContext["gateway"]) {
    const sessionKey = gateway.snapshot.sessionKey;
    const { gatewayUrl, token, password } = gateway.connection;
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

  private updateConnection(patch: Partial<Pick<UiSettings, "gatewayUrl" | "token">>) {
    if (patch.gatewayUrl !== undefined) {
      const credentials = resolveGatewayCredentialsForUrlEdit(
        this.settings.gatewayUrl,
        patch.gatewayUrl,
        { token: this.settings.token, password: this.password },
      );
      this.password = credentials.password;
      this.settings = { ...this.settings, ...patch, token: credentials.token };
      return;
    }
    this.settings = { ...this.settings, ...patch };
  }

  override render() {
    const gateway = this.context.gateway.snapshot;
    const live = this.context.gateway.connection;
    const dirty =
      this.sessionKeyDirty ||
      this.settings.gatewayUrl !== live.gatewayUrl ||
      this.settings.token !== live.token ||
      this.password !== live.password;
    const body = renderConnection({
      connected: gateway.phase === "connected",
      hello: gateway.hello,
      settings: this.settings,
      liveGatewayUrl: live.gatewayUrl,
      secret: this.settings.token || this.password,
      lastError: gateway.lastError,
      systemInfo: this.systemInfo,
      systemInfoUnavailable: this.systemInfoUnavailable,
      dirty,
      showGatewaySecret: this.gatewaySecretVisible,
      onConnectionChange: (patch) => this.updateConnection(patch),
      onSecretChange: (token) => {
        this.password = "";
        this.updateConnection({ token });
      },
      onSessionKeyChange: (sessionKey) => {
        this.sessionKeyDirty = true;
        this.settings = {
          ...this.settings,
          sessionKey,
          lastActiveSessionKey: sessionKey,
        };
      },
      onToggleGatewaySecretVisibility: () => {
        this.gatewaySecretVisible = !this.gatewaySecretVisible;
      },
      onConnect: () => this.connect(),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("connection")}</div>
          <div class="page-subtitle">
            ${subtitleForRoute("connection")} ${renderLearnMoreLink(CONNECTION_DOCS_URL)}
          </div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-connection-page")) {
  customElements.define("openclaw-connection-page", ConnectionPage);
}
