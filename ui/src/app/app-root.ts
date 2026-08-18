import { ContextProvider } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import "../components/gateway-url-confirmation.ts";
import "../components/github-link-hovercard-registration.ts";
import "../components/login-gate.ts";
import "../components/openclaw-mascot.ts";
import "../components/tooltip.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { isDesktopPanelAvailable } from "./app-shell-chrome.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { resolveControlUiBasePath } from "./browser.ts";
import { applicationContext, type ApplicationContext } from "./context.ts";
import { desktopDocumentOptions, isDesktopOnlyView } from "./desktop-document-mode.ts";
import {
  APPROVAL_PAGE_ELEMENT,
  DESKTOP_PANEL_ELEMENT,
  isOptionalElementDefined,
  preloadOptionalElement,
  TERMINAL_PANEL_ELEMENT,
} from "./lazy-custom-element.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";
import { controlUiPublicAssetPath } from "./public-assets.ts";
import { isTerminalOnlyView } from "./terminal-document-mode.ts";

export function resolveTerminalThemeMode(): "dark" | "light" {
  return document.documentElement.dataset.themeMode === "light" ? "light" : "dark";
}

function renderConnectingSplash(status?: string) {
  return html`
    <main
      class="connect-splash"
      role="status"
      aria-live="polite"
      aria-label=${status ?? t("common.loading")}
    >
      <openclaw-mascot mood="thinking" .size=${120}></openclaw-mascot>
      ${status ? html`<span class="connect-splash__status">${status}</span>` : nothing}
    </main>
  `;
}

function renderApprovalDocument(runtime: ApplicationRuntime) {
  const documentMode = runtime.documentMode;
  if (documentMode?.kind !== "approval") {
    return nothing;
  }
  return html`
    <openclaw-approval-page .approvalId=${documentMode.approvalId ?? ""}>
      <main class="approval-page approval-page--booting" role="status" aria-live="polite">
        <img
          class="connect-splash__logo"
          src=${controlUiPublicAssetPath("favicon.svg", runtime.context.basePath)}
          alt=""
        />
        <span>${t("common.loading")}</span>
      </main>
    </openclaw-approval-page>
  `;
}

export class OpenClawApp extends OpenClawLightDomElement {
  // Pinned while a connect submitted from the visible login gate is in
  // flight, so a failed manual attempt cannot flash the shell in between.
  @state() private loginGatePinned = false;
  @state() private loginGatewayUrl = "";
  @state() private loginToken = "";
  @state() private loginPassword = "";
  @state() private loginShowGatewayToken = false;
  @state() private loginShowGatewayPassword = false;
  @state() private pendingGatewayUrl: string | null = null;
  @state() private onboarding = resolveOnboardingMode(globalThis.location?.search ?? "");

  private readonly terminalOnly = isTerminalOnlyView(
    globalThis.location,
    resolveControlUiBasePath(globalThis.location?.pathname ?? "/"),
  );
  private readonly desktopOnly = isDesktopOnlyView(
    globalThis.location,
    resolveControlUiBasePath(globalThis.location?.pathname ?? "/"),
  );
  private readonly desktopOptions = desktopDocumentOptions(globalThis.location);
  private runtime: ApplicationRuntime | undefined;
  private readonly contextProvider = new ContextProvider(this, {
    context: applicationContext,
  });
  private readonly subscriptions = new SubscriptionsController(this);
  private loginGatewaySource: ApplicationContext["gateway"] | null = null;
  private loginConnectionClient: GatewayBrowserClient | null = null;

  private get context(): ApplicationContext<RouteId> | undefined {
    return this.runtime?.context;
  }

  constructor() {
    super();
    this.subscriptions
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeGateway(gateway),
      )
      .watch(
        () => (this.terminalOnly ? this.context?.config : undefined),
        (config, notify) => config.subscribe(notify),
      )
      .watch(
        () => (this.terminalOnly ? this.context?.agentSelection : undefined),
        (selection, notify) => selection.subscribe(notify),
      );
  }

  override connectedCallback() {
    super.connectedCallback();
    void import("../components/app-sidebar.ts");
    void import("../components/session-progress-hovercard-registration.ts");
    this.resetLoginSensitivePresentation();
    this.runtime = bootstrapApplication();
    if (this.terminalOnly) {
      preloadOptionalElement(this, TERMINAL_PANEL_ELEMENT);
    }
    if (this.desktopOnly) {
      preloadOptionalElement(this, DESKTOP_PANEL_ELEMENT);
    }
    if (this.runtime.documentMode?.kind === "approval") {
      preloadOptionalElement(this, APPROVAL_PAGE_ELEMENT);
    }
    const context = this.runtime.context;
    this.pendingGatewayUrl = this.runtime.pendingGatewayConnection?.gatewayUrl ?? null;
    // Context identity changes only across a full app-tree connection epoch;
    // descendants reconnect and rebuild their controller-owned state afterward.
    this.contextProvider.setValue(context);
    this.syncLoginConnection();
    // The runtime is created after controller hostConnected hooks run. Ensure
    // their lazy source getters bind on both the initial mount and reconnect.
    this.requestUpdate();
    void this.runtime.start().catch((error: unknown) => {
      console.error("[openclaw] application start failed", error);
    });
  }

  override disconnectedCallback() {
    // Stop reactive subscriptions before disposing their application sources.
    this.subscriptions.clear();
    this.runtime?.stop();
    this.runtime = undefined;
    this.loginGatewaySource = null;
    this.loginConnectionClient = null;
    this.pendingGatewayUrl = null;
    this.resetLoginSensitivePresentation();
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    if (this.runtime) {
      globalThis.dispatchEvent(new Event("openclaw-control-ui-rendered"));
    }
  }

  private synchronizeGateway(gateway: ApplicationContext["gateway"]) {
    const sourceChanged = gateway !== this.loginGatewaySource;
    if (sourceChanged) {
      this.loginGatewaySource = gateway;
      this.loginConnectionClient = null;
      this.resetLoginSensitivePresentation();
    }
    const snapshot = gateway.snapshot;
    const clientChanged = snapshot.client !== this.loginConnectionClient;
    if (clientChanged) {
      this.loginConnectionClient = snapshot.client;
      this.resetLoginSensitivePresentation();
    }
    if (sourceChanged || clientChanged) {
      this.syncLoginConnection(gateway);
    }
    if (snapshot.phase === "connected") {
      this.loginGatePinned = false;
    }
  }

  private syncLoginConnection(gateway = this.context?.gateway) {
    const connection = gateway?.connection;
    if (!connection) {
      return;
    }
    this.loginGatewayUrl = connection.gatewayUrl;
    this.loginToken = connection.token;
    this.loginPassword = connection.password;
  }

  private resetLoginSensitivePresentation() {
    this.loginShowGatewayToken = false;
    this.loginShowGatewayPassword = false;
  }

  override render() {
    const context = this.context;
    const runtime = this.runtime;
    if (!context || !runtime) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const gatewaySnapshot = context.gateway.snapshot;
    const gatewayConnected = gatewaySnapshot.phase === "connected";
    const gatewayStartupStatus =
      gatewaySnapshot.phase === "starting" ? t("common.gatewayStarting") : undefined;
    const gatewayUrlConfirmation = this.pendingGatewayUrl
      ? html`
          <openclaw-gateway-url-confirmation
            .props=${{
              pendingGatewayUrl: this.pendingGatewayUrl,
              onConfirm: () => {
                runtime.confirmPendingGatewayConnection();
                this.pendingGatewayUrl = null;
              },
              onCancel: () => {
                runtime.cancelPendingGatewayConnection();
                this.pendingGatewayUrl = null;
              },
            }}
          ></openclaw-gateway-url-confirmation>
        `
      : nothing;
    // Full-screen terminals own the whole document. Keep the generic login gate
    // out of this path or a connecting native session exposes Web UI chrome.
    if (this.terminalOnly) {
      const terminalAvailable = isTerminalAvailable(
        gatewaySnapshot,
        context.config.current.terminalEnabled ?? false,
      );
      const terminalOwner =
        context.agentSelection.state.selectedId ?? gatewaySnapshot.assistantAgentId;
      const terminalAgentId = terminalOwner ? normalizeAgentId(terminalOwner) : null;
      // Embedded clients query this host immediately; keep it stable while the chunk loads.
      return html`
        <openclaw-terminal-panel
          .client=${gatewayConnected ? gatewaySnapshot.client : null}
          .available=${terminalAvailable}
          .agentId=${terminalAgentId}
          .themeMode=${resolveTerminalThemeMode()}
          fullscreen
        ></openclaw-terminal-panel>
        ${!gatewayConnected && gatewaySnapshot.lastError === null
          ? renderConnectingSplash(gatewayStartupStatus)
          : nothing}
        ${!isOptionalElementDefined(TERMINAL_PANEL_ELEMENT) && terminalAvailable
          ? renderConnectingSplash(gatewayStartupStatus)
          : nothing}
        ${!terminalAvailable && (gatewayConnected || gatewaySnapshot.lastError)
          ? html`<div class="terminal-view-unavailable">${t("terminal.unavailable")}</div>`
          : nothing}
      `;
    }
    // Desktop documents share the panel's connection owner but none of its
    // dock or shell chrome. Native clients can therefore load this route as a
    // standalone, mobile-shaped surface without changing the observe contract.
    if (this.desktopOnly) {
      const desktopAvailable = isDesktopPanelAvailable(gatewaySnapshot);
      return html`
        <openclaw-desktop-panel
          .client=${gatewayConnected ? gatewaySnapshot.client : null}
          .available=${desktopAvailable}
          .documentMode=${true}
          .documentSource=${this.desktopOptions.source}
          .documentSession=${this.desktopOptions.session}
          .documentControl=${this.desktopOptions.control}
          .onDocumentClose=${() => {
            if (globalThis.history.length > 1) {
              globalThis.history.back();
            } else {
              globalThis.location.assign(context.basePath || "/");
            }
          }}
        ></openclaw-desktop-panel>
        ${!gatewayConnected && gatewaySnapshot.lastError === null
          ? renderConnectingSplash(gatewayStartupStatus)
          : nothing}
        ${!isOptionalElementDefined(DESKTOP_PANEL_ELEMENT) && desktopAvailable
          ? renderConnectingSplash(gatewayStartupStatus)
          : nothing}
        ${!desktopAvailable && (gatewayConnected || gatewaySnapshot.lastError)
          ? html`<div class="desktop-view-unavailable">${t("desktop.unavailable")}</div>`
          : nothing}
      `;
    }
    // In the normal Control UI document, the Gateway lifecycle owns unresolved
    // first-connect state across every auth mode. Failures publish lastError
    // before the gate returns; reconnects keep the shell mounted, and
    // loginGatePinned protects manual submissions.
    const initialConnectPending =
      runtime.documentMode === null &&
      gatewaySnapshot.lastError === null &&
      (gatewaySnapshot.phase === "starting" ||
        (gatewaySnapshot.phase === "connecting" && !this.loginGatePinned));
    if (initialConnectPending) {
      return html`
        <openclaw-tooltip-provider>
          ${renderConnectingSplash(gatewayStartupStatus)} ${gatewayUrlConfirmation}
        </openclaw-tooltip-provider>
      `;
    }
    const shellOwnsRecovery =
      gatewaySnapshot.phase === "reconnecting" || gatewaySnapshot.phase === "reload-required";
    const showLoginGate = !gatewayConnected && !shellOwnsRecovery;
    if (showLoginGate) {
      return html`
        <openclaw-tooltip-provider>
          <openclaw-login-gate
            .props=${{
              basePath: context.basePath,
              connected: gatewayConnected,
              lastError: gatewaySnapshot.lastError,
              lastErrorCode: gatewaySnapshot.lastErrorCode,
              hasToken: Boolean(this.loginToken.trim()),
              hasPassword: Boolean(this.loginPassword.trim()),
              gatewayUrl: this.loginGatewayUrl,
              token: this.loginToken,
              password: this.loginPassword,
              showGatewayToken: this.loginShowGatewayToken,
              showGatewayPassword: this.loginShowGatewayPassword,
              onGatewayUrlChange: (value: string) => {
                this.loginGatewayUrl = value;
              },
              onTokenChange: (value: string) => {
                this.loginToken = value;
              },
              onPasswordChange: (value: string) => {
                this.loginPassword = value;
              },
              onToggleGatewayToken: () => {
                this.loginShowGatewayToken = !this.loginShowGatewayToken;
              },
              onToggleGatewayPassword: () => {
                this.loginShowGatewayPassword = !this.loginShowGatewayPassword;
              },
              onConnect: () => {
                this.loginGatePinned = true;
                context.gateway.connect({
                  gatewayUrl: this.loginGatewayUrl,
                  token: this.loginToken,
                  password: this.loginPassword,
                });
              },
            }}
          ></openclaw-login-gate>
          ${gatewayUrlConfirmation}
        </openclaw-tooltip-provider>
      `;
    }
    if (runtime.documentMode?.kind === "approval") {
      return html`
        <openclaw-tooltip-provider>
          ${gatewayUrlConfirmation} ${renderApprovalDocument(runtime)}
        </openclaw-tooltip-provider>
      `;
    }
    return html`
      <openclaw-tooltip-provider>
        <openclaw-github-link-hovercard-provider .client=${gatewaySnapshot.client}>
          <openclaw-session-link-hovercard-provider
            .client=${gatewaySnapshot.client}
            .context=${context}
          >
            <openclaw-session-progress-hovercard-provider .gateway=${context.gateway}>
              ${gatewayUrlConfirmation}
              <openclaw-app-shell
                .runtime=${runtime}
                .onboarding=${this.onboarding}
              ></openclaw-app-shell>
            </openclaw-session-progress-hovercard-provider>
          </openclaw-session-link-hovercard-provider>
        </openclaw-github-link-hovercard-provider>
      </openclaw-tooltip-provider>
    `;
  }
}
