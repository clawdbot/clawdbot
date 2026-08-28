import { ContextProvider } from "@lit/context";
import { buildControlUiFocusPath, type ControlUiFocusTarget } from "@openclaw/session-url-contract";
import type { RouteLocation, RouteNotFound } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import "../components/gateway-url-confirmation.ts";
import "../components/github-link-hovercard-registration.ts";
import "../components/login-gate.ts";
import "../components/openclaw-mascot.ts";
import { renderLazyElementState } from "../components/lazy-view-error.ts";
import { installTitleTooltips } from "../components/tooltip-title.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import type { ChatRouteData } from "../pages/chat/route-loader.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { applicationContext, type ApplicationContext } from "./context.ts";
import {
  APPROVAL_PAGE_ELEMENT,
  DASHBOARD_DOCUMENT_ELEMENT,
  DESKTOP_PANEL_ELEMENT,
  isOptionalElementDefined,
  LazyCustomElementRequestController,
  type OptionalCustomElement,
  QUESTION_PAGE_ELEMENT,
  TERMINAL_PANEL_ELEMENT,
} from "./lazy-custom-element.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";
import { isDesktopPanelAvailable } from "./panel-availability.ts";

type FocusDashboardRouteState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "ambiguous"; data: Extract<ChatRouteData, { kind: "ambiguous" }> }
  | { kind: "session"; data: Extract<ChatRouteData, { kind: "session" }> };

function routeLocationHref(location: RouteLocation): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function isRouteNotFound(result: ChatRouteData | RouteNotFound): result is RouteNotFound {
  return "type" in result && result.type === "notFound";
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
  @state() private focusDashboardRoute: FocusDashboardRouteState = { kind: "loading" };

  private runtime: ApplicationRuntime | undefined;
  private readonly contextProvider = new ContextProvider(this, {
    context: applicationContext,
  });
  private readonly subscriptions = new SubscriptionsController(this);
  private loginGatewaySource: ApplicationContext["gateway"] | null = null;
  private loginConnectionClient: GatewayBrowserClient | null = null;
  private focusDashboardAbort: AbortController | null = null;
  private readonly lazyCustomElements = new LazyCustomElementRequestController(this, () =>
    this.closeDocument(this.context?.basePath ?? ""),
  );

  private get context(): ApplicationContext<RouteId> | undefined {
    return this.runtime?.context;
  }

  private get focusTarget(): ControlUiFocusTarget | null {
    const focus = this.runtime?.focusLocation;
    return focus?.status === "valid" ? focus.target : null;
  }

  private get terminalOnly(): boolean {
    return this.focusTarget?.kind === "terminal";
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
      )
      .watch(
        () => (this.terminalOnly ? this.context?.theme : undefined),
        (theme, notify) => theme.subscribe(notify),
      )
      .effect(() => this.ownerDocument, installTitleTooltips);
  }

  override connectedCallback() {
    super.connectedCallback();
    void import("../components/session-progress-hovercard-registration.ts");
    this.resetLoginSensitivePresentation();
    this.runtime = bootstrapApplication();
    const focusTarget = this.focusTarget;
    if (focusTarget?.kind === "terminal") {
      this.requestLazyDocument(TERMINAL_PANEL_ELEMENT);
    }
    if (focusTarget?.kind === "desktop") {
      this.requestLazyDocument(DESKTOP_PANEL_ELEMENT);
    }
    if (focusTarget?.kind === "dashboard") {
      this.requestLazyDocument(DASHBOARD_DOCUMENT_ELEMENT);
    }
    if (this.runtime.documentMode?.kind === "approval") {
      this.requestLazyDocument(APPROVAL_PAGE_ELEMENT);
    }
    if (this.runtime.documentMode?.kind === "question") {
      this.requestLazyDocument(QUESTION_PAGE_ELEMENT);
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
    void this.runtime
      .start()
      .then(() => this.resolveFocusDashboard())
      .catch((error: unknown) => {
        console.error("[openclaw] application start failed", error);
      });
  }

  override disconnectedCallback() {
    // Stop reactive subscriptions before disposing their application sources.
    this.subscriptions.clear();
    this.focusDashboardAbort?.abort();
    this.focusDashboardAbort = null;
    this.lazyCustomElements.abandon();
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

  private closeDocument(basePath: string): void {
    if (globalThis.history.length > 1) {
      globalThis.history.back();
    } else {
      globalThis.location.assign(basePath || "/");
    }
  }

  private renderFocusEscape(label: string) {
    return html`<button
      class="btn btn--ghost"
      type="button"
      @click=${() => this.closeDocument(this.context?.basePath ?? "")}
    >
      ${label}
    </button>`;
  }

  private requestLazyDocument(element: OptionalCustomElement): void {
    if (!isOptionalElementDefined(element)) {
      this.lazyCustomElements.request(element);
    }
  }

  private renderLazyDocumentState(element: OptionalCustomElement) {
    const lazyState = this.lazyCustomElements.visibleState;
    if (!lazyState || lazyState.element !== element) {
      return nothing;
    }
    return html`<main class="connect-splash">
      ${renderLazyElementState(
        lazyState,
        () => this.lazyCustomElements.retry(),
        () => this.lazyCustomElements.close(),
      )}
    </main>`;
  }

  private renderApprovalDocument(runtime: ApplicationRuntime) {
    const lazyState = this.lazyCustomElements.visibleState;
    if (lazyState?.element === APPROVAL_PAGE_ELEMENT) {
      return this.renderLazyDocumentState(APPROVAL_PAGE_ELEMENT);
    }
    const approvalId =
      runtime.documentMode?.kind === "approval" ? runtime.documentMode.approvalId : "";
    return html`<openclaw-approval-page .approvalId=${approvalId ?? ""}></openclaw-approval-page>`;
  }

  private renderQuestionDocument(runtime: ApplicationRuntime) {
    const lazyState = this.lazyCustomElements.visibleState;
    if (lazyState?.element === QUESTION_PAGE_ELEMENT) {
      return this.renderLazyDocumentState(QUESTION_PAGE_ELEMENT);
    }
    const questionId =
      runtime.documentMode?.kind === "question" ? runtime.documentMode.questionId : "";
    return html`<openclaw-question-page .questionId=${questionId ?? ""}></openclaw-question-page>`;
  }

  private replaceFocusDashboardLocation(location: RouteLocation, source: RouteLocation): void {
    const basePath = this.context?.basePath ?? "";
    const expected = buildControlUiFocusPath(
      { kind: "dashboard", path: routeLocationHref(source) },
      basePath,
    );
    const replacement = buildControlUiFocusPath(
      { kind: "dashboard", path: routeLocationHref(location) },
      basePath,
    );
    const current = `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;
    if (!expected || !replacement || current !== expected || replacement === current) {
      return;
    }
    globalThis.history.replaceState(globalThis.history.state, "", replacement);
  }

  private async resolveFocusDashboard(): Promise<void> {
    const target = this.focusTarget;
    const context = this.context;
    if (target?.kind !== "dashboard" || !context) {
      return;
    }
    this.focusDashboardAbort?.abort();
    const controller = new AbortController();
    this.focusDashboardAbort = controller;
    this.focusDashboardRoute = { kind: "loading" };
    const location = target.route;
    try {
      const { loadChatRoute } = await import("../pages/chat/route-loader.ts");
      const result = await loadChatRoute(context, location, "dashboard", controller.signal);
      if (controller.signal.aborted || this.focusDashboardAbort !== controller) {
        return;
      }
      if (isRouteNotFound(result)) {
        this.focusDashboardRoute = { kind: "not-found" };
        return;
      }
      if (result.kind === "ambiguous") {
        this.focusDashboardRoute = {
          kind: "ambiguous",
          data: {
            ...result,
            candidates: result.candidates.map((candidate) => ({
              ...candidate,
              href:
                buildControlUiFocusPath(
                  { kind: "dashboard", path: candidate.href },
                  context.basePath,
                ) ?? candidate.href,
            })),
          },
        };
        return;
      }
      this.focusDashboardRoute = { kind: "session", data: result };
      if (result.canonicalLocation && result.canonicalLocationSource) {
        this.replaceFocusDashboardLocation(
          result.canonicalLocation,
          result.canonicalLocationSource,
        );
      }
      const canonicalLocationSource = result.canonicalLocationSource;
      if (result.canonicalLocationReady && canonicalLocationSource) {
        void result.canonicalLocationReady.then((canonicalLocation) => {
          if (
            canonicalLocation &&
            !controller.signal.aborted &&
            this.focusDashboardAbort === controller
          ) {
            this.replaceFocusDashboardLocation(canonicalLocation, canonicalLocationSource);
          }
        });
      }
    } catch (error) {
      if (!controller.signal.aborted && this.focusDashboardAbort === controller) {
        this.focusDashboardRoute = { kind: "error", message: formatUiError(error) };
      }
    }
  }

  private renderFocusDashboard(
    gatewaySnapshot: ApplicationContext["gateway"]["snapshot"],
    gatewayConnected: boolean,
    gatewayStartupStatus: string | undefined,
  ) {
    const route = this.focusDashboardRoute;
    if (route.kind === "loading") {
      return renderConnectingSplash(gatewayStartupStatus);
    }
    if (route.kind === "not-found") {
      return html`<main class="board-document">
        <section class="board-document__state stack" role="status">
          <span>${t("dashboardDocument.notFound")}</span>
          ${this.renderFocusEscape(t("dashboardDocument.close"))}
        </section>
      </main>`;
    }
    if (route.kind === "error") {
      return html`<main class="board-document">
        <section class="board-document__state board-document__state--error stack" role="alert">
          <span>${t("dashboardDocument.loadFailed", { error: route.message })}</span>
          ${this.renderFocusEscape(t("dashboardDocument.close"))}
        </section>
      </main>`;
    }
    if (route.kind === "ambiguous") {
      return html`<main class="board-document">
        <section class="card board-document__state">
          <h2>${t("chat.sessionRoute.chooseTitle")}</h2>
          <p>
            ${route.data.candidates.length > 1
              ? t("chat.sessionRoute.multipleMatches", { shortId: route.data.shortId })
              : t("chat.sessionRoute.additionalMatches")}
          </p>
          ${route.data.candidates.map(
            (candidate) => html`<p>
              <a href=${candidate.href}>${candidate.displayName}</a><br />
              <small>${candidate.agentId} · ${candidate.idPrefix}</small>
            </p>`,
          )}
          ${route.data.truncated
            ? html`<p><small>${t("chat.sessionRoute.additionalMatches")}</small></p>`
            : nothing}
          ${this.renderFocusEscape(t("dashboardDocument.close"))}
        </section>
      </main>`;
    }
    return html`
      <openclaw-board-document
        .gatewaySnapshot=${gatewaySnapshot}
        .sessionKey=${route.data.sessionKey}
        .onDocumentClose=${() => this.closeDocument(this.context?.basePath ?? "")}
      ></openclaw-board-document>
      ${!gatewayConnected && gatewaySnapshot.lastError === null
        ? renderConnectingSplash(gatewayStartupStatus)
        : nothing}
      ${gatewayConnected ? this.renderLazyDocumentState(DASHBOARD_DOCUMENT_ELEMENT) : nothing}
    `;
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
    if (runtime.focusLocation?.status === "unsupported") {
      return html`<main class="connect-splash" role="alert">
        <div class="stack">
          <span class="connect-splash__status">${t("focus.unsupported")}</span>
          ${this.renderFocusEscape(t("common.back"))}
        </div>
      </main>`;
    }
    const focusTarget = this.focusTarget;
    // Focused terminals own the whole document. Keep the generic login gate
    // out of this path or a connecting native session exposes Web UI chrome.
    if (focusTarget?.kind === "terminal") {
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
          .themeMode=${context.theme.resolvedMode}
          fullscreen
        ></openclaw-terminal-panel>
        ${!gatewayConnected && gatewaySnapshot.lastError === null
          ? renderConnectingSplash(gatewayStartupStatus)
          : nothing}
        ${terminalAvailable ? this.renderLazyDocumentState(TERMINAL_PANEL_ELEMENT) : nothing}
        ${!terminalAvailable && (gatewayConnected || gatewaySnapshot.lastError)
          ? html`<div class="terminal-view-unavailable">
              <div class="stack">
                <span>${t("terminal.unavailable")}</span>
                ${this.renderFocusEscape(t("common.back"))}
              </div>
            </div>`
          : nothing}
      `;
    }
    // Desktop documents share the panel's connection owner but none of its
    // dock or shell chrome. Native clients can therefore load this route as a
    // standalone, mobile-shaped surface without changing the observe contract.
    if (focusTarget?.kind === "desktop") {
      const desktopAvailable = isDesktopPanelAvailable(gatewaySnapshot);
      const source = focusTarget.selector?.kind === "source" ? focusTarget.selector.value : null;
      const session = focusTarget.selector?.kind === "session" ? focusTarget.selector.value : null;
      return html`
        <openclaw-desktop-panel
          .client=${gatewayConnected ? gatewaySnapshot.client : null}
          .available=${desktopAvailable}
          .documentMode=${true}
          .documentSource=${source}
          .documentSession=${session}
          .documentControl=${focusTarget.control}
          .onDocumentClose=${() => this.closeDocument(context.basePath)}
        ></openclaw-desktop-panel>
        ${!gatewayConnected && gatewaySnapshot.lastError === null
          ? renderConnectingSplash(gatewayStartupStatus)
          : nothing}
        ${desktopAvailable ? this.renderLazyDocumentState(DESKTOP_PANEL_ELEMENT) : nothing}
        ${!desktopAvailable && (gatewayConnected || gatewaySnapshot.lastError)
          ? html`<div class="desktop-view-unavailable">
              <div class="stack">
                <span>${t("desktop.unavailable")}</span>
                ${this.renderFocusEscape(t("common.back"))}
              </div>
            </div>`
          : nothing}
      `;
    }
    if (focusTarget?.kind === "dashboard") {
      return this.renderFocusDashboard(gatewaySnapshot, gatewayConnected, gatewayStartupStatus);
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
              resourceBasePath: context.resourceBasePath,
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
          ${gatewayUrlConfirmation} ${this.renderApprovalDocument(runtime)}
        </openclaw-tooltip-provider>
      `;
    }
    if (runtime.documentMode?.kind === "question") {
      return html`
        <openclaw-tooltip-provider>
          ${gatewayUrlConfirmation} ${this.renderQuestionDocument(runtime)}
        </openclaw-tooltip-provider>
      `;
    }
    return html`
      <openclaw-tooltip-provider>
        <openclaw-github-link-hovercard-provider .client=${gatewaySnapshot.client}>
          <openclaw-session-progress-hovercard-provider
            .client=${gatewaySnapshot.client}
            .context=${context}
            .gateway=${context.gateway}
          >
            ${gatewayUrlConfirmation}
            <openclaw-app-shell
              .runtime=${runtime}
              .onboarding=${this.onboarding}
            ></openclaw-app-shell>
          </openclaw-session-progress-hovercard-provider>
        </openclaw-github-link-hovercard-provider>
      </openclaw-tooltip-provider>
    `;
  }
}
