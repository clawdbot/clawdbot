import type {
  DesktopObserveResult,
  DesktopSource,
  EnvironmentSummary,
  EnvironmentsListResult,
  WorkerDesktopLaunchResult,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import { DockLayoutController } from "../dock-layout-controller.ts";
import {
  DESKTOP_PANEL_TOGGLE_EVENT,
  type DesktopPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import { DesktopClient } from "./desktop-client.ts";
import { resolveDesktopDocumentInventoryTarget } from "./desktop-document-inventory.ts";
import { renderDesktopDocumentView } from "./desktop-document-view.ts";
import { openDesktopFocus } from "./desktop-focus-window.ts";
import { DesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import {
  DesktopConnectionHandoff,
  type DesktopAppId,
  type DesktopCredentials,
  type ObservedDesktopConnection,
  type PendingDesktopConnection,
} from "./desktop-panel-connection.ts";
import { desktopCredentialRequirement } from "./desktop-panel-credentials.ts";
import { DesktopPanelFullscreenController } from "./desktop-panel-fullscreen-controller.ts";
import { desktopPanelLayout } from "./desktop-panel-layout.ts";
import { type DesktopPanelState, renderDesktopPanelRecovery } from "./desktop-panel-state.ts";
import { desktopPanelElementStyles } from "./desktop-panel-styles.ts";
import {
  renderDesktopConnection,
  renderDesktopCredentials,
  renderDesktopNotice,
  renderDesktopPanelContent,
  renderDesktopPanelHeader,
  renderDesktopPicker,
} from "./desktop-panel-view.ts";
import { DesktopSessionController } from "./desktop-session-controller.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

/** `<openclaw-desktop-panel>` — dockable RFB access to Gateway desktop sources. */
class OpenClawDesktopPanel extends OpenClawLitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) available = false;
  @property({ type: Boolean }) suppressed = false;
  @property({ type: Boolean }) documentMode = false;
  @property({ attribute: false }) requestedSource: string | null = null;
  @property({ attribute: false }) sessionKey: string | null = null;
  @property({ type: Boolean }) documentControl = false;
  @property({ attribute: false }) basePath = "";
  /** Hosted by the chat side panel, which owns visibility and geometry. */
  @property({ type: Boolean }) embedded = false;
  /** This embedded instance is the active pane's visible Desktop presenter. */
  @property({ type: Boolean }) presented = false;
  /** Whether a newly ready embedded presentation owns its initial inventory refresh. */
  @property({ type: Boolean }) refreshOnPresentation = true;
  @property({ attribute: false }) onDocumentClose: (() => void) | null = null;

  /** Browser tests replace the transport without opening a real RFB socket. */
  desktopClientFactory: () => Pick<DesktopClient, "connect"> = () => new DesktopClient();

  @state() private environments: EnvironmentSummary[] = [];
  @state() private loading = false;
  @state() private state: DesktopPanelState = "picker";
  @state() private environmentId: string | null = null;
  @state() private source: DesktopSource | null = null;
  @state() private controlling = false;
  @state() private errorText: string | null = null;
  @state() private noticeText: string | null = null;
  @state() private disconnectedReason: string | null = null;
  @state() private launchingApp: DesktopAppId | null = null;
  @state() private launchErrorText: string | null = null;
  @state() private desktopApps: DesktopAppId[] = [];
  @state() private scaleViewport = true;

  private readonly connection = new DesktopConnectionHandoff();
  private credentials: DesktopCredentials | undefined;
  private credentialAuth: "vnc-password" | "ard-account" | undefined;
  private pendingConnection: PendingDesktopConnection | null = null;
  private operationId = 0;
  private launchOperationId = 0;
  private controlTakeoverRecoveryUsed = false;
  private sourceSelection: "pending" | "resolved" | "picker" = "pending";
  private readonly sessionSource = new DesktopSessionController(
    this,
    () => this.environmentId,
    (target) => {
      this.returnToPicker();
      this.sourceSelection = "pending";
      void this.refreshEnvironments(undefined, target);
    },
  );
  private readonly mobileKeyboard = new DesktopMobileKeyboard({
    connection: () => this.connection.handle,
    controlling: () => this.controlling,
    input: () => this.shadowRoot?.querySelector<HTMLTextAreaElement>(".desktop-keyboard-input"),
  });
  private readonly dockLayout = new DockLayoutController(this, {
    layout: desktopPanelLayout,
    reservationPrefix: "desktop",
    isAvailable: () => this.available,
    isFullscreen: () => this.fullscreenMode.active,
  });
  private readonly fullscreenMode = new DesktopPanelFullscreenController(this, {
    section: () => this.renderRoot.querySelector<HTMLElement>("section.bp"),
    onChange: () => this.dockLayout.syncReservation(),
  });
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);

  static override styles = desktopPanelElementStyles;

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.embedded) {
      window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    }
    this.dockLayout.setSuppressed(this.suppressed);
    if (this.documentMode && this.available) {
      void this.refreshEnvironments();
    } else if (!this.embedded && this.dockLayout.open) {
      void this.refreshEnvironments();
    }
  }

  override disconnectedCallback(): void {
    window.removeEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.disconnectConnection();
    this.credentials = undefined;
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("embedded")) {
      if (this.embedded) {
        window.removeEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.onToggleRequest);
      } else {
        window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.onToggleRequest);
      }
    }
    if (changed.has("suppressed")) {
      const restored = this.dockLayout.setSuppressed(this.suppressed);
      if (this.suppressed) {
        this.returnToPicker();
      } else if (restored) {
        void this.refreshEnvironments();
      }
    }
    const gatewayAvailabilityChanged = changed.has("client") || changed.has("available");
    const presentationChanged =
      gatewayAvailabilityChanged ||
      changed.has("embedded") ||
      changed.has("presented") ||
      changed.has("documentMode") ||
      changed.has("requestedSource") ||
      changed.has("sessionKey") ||
      changed.has("documentControl");
    if ((this.documentMode || this.embedded) && presentationChanged) {
      // Release input and invalidate pending work before resolving a different session or machine.
      this.returnToPicker();
      this.sourceSelection = "pending";
      if (this.available && (!this.embedded || (this.presented && this.refreshOnPresentation))) {
        void this.refreshEnvironments();
      }
    } else if (gatewayAvailabilityChanged) {
      if (!this.available && this.dockLayout.open) {
        this.dockLayout.hideWithoutPersisting();
        this.returnToPicker();
      } else if (this.available && this.dockLayout.restoreOpenState()) {
        void this.refreshEnvironments();
      }
    }
    this.dockLayout.syncReservation();
  }

  handleToggleRequest(event: Event): void {
    if (this.documentMode) {
      return;
    }
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as DesktopPanelToggleDetail)
        : null;
    if (this.embedded) {
      if (!this.presented) {
        return;
      }
      if (detail?.open === false) {
        this.returnToPicker();
        return;
      }
      if (!this.available || !this.client) {
        return;
      }
      if (detail?.environmentId) {
        void this.connectRequestedEnvironment(detail.environmentId);
      } else {
        this.returnToPicker();
        // An untargeted shell command opens the picker, overriding this presentation's session default.
        this.sourceSelection = "picker";
        void this.refreshEnvironments();
      }
      return;
    }
    if (detail?.dock === "right" || detail?.dock === "bottom") {
      this.dockLayout.setDock(detail.dock, false);
    }
    if (detail?.open === false) {
      this.closePanel();
      return;
    }
    if (!this.available) {
      return;
    }
    const wasOpen = this.dockLayout.open;
    this.dockLayout.setOpen(true);
    if (detail?.environmentId) {
      void this.connectRequestedEnvironment(detail.environmentId);
    } else if (!wasOpen) {
      void this.refreshEnvironments();
    } else if (detail?.open !== true) {
      this.closePanel();
    }
  }

  private closePanel(): void {
    this.returnToPicker();
    this.dockLayout.setOpen(false);
  }

  private returnToPicker(): void {
    this.sessionSource.invalidate();
    this.disconnectConnection();
    this.clearLaunchState();
    this.state = "picker";
    this.environmentId = null;
    this.source = null;
    this.credentials = undefined;
    this.credentialAuth = undefined;
    this.desktopApps = [];
    this.controlling = false;
    this.disconnectedReason = null;
  }

  private disconnectConnection(retainViewer = false): void {
    this.operationId += 1;
    this.pendingConnection = null;
    this.connection.begin(retainViewer);
    this.mobileKeyboard.reset();
  }

  private clearLaunchState(): void {
    this.launchOperationId += 1;
    this.launchingApp = null;
    this.launchErrorText = null;
  }

  private async refreshEnvironments(
    expectedOperationId?: number,
    resolvedSessionTarget?: string | null,
  ): Promise<boolean> {
    const client = this.client;
    if (!client || !this.available || (this.embedded && !this.presented)) {
      return false;
    }
    const operationId = expectedOperationId ?? ++this.operationId;
    this.loading = true;
    this.errorText = null;
    let refreshed = false;
    try {
      const result = await client.request<EnvironmentsListResult>("environments.list", {});
      if (operationId !== this.operationId) {
        return false;
      }
      this.environments = result.environments.filter((environment) => environment.desktop === true);
      refreshed = true;
    } catch (error) {
      if (operationId === this.operationId) {
        this.errorText = t("desktop.errors.listFailed", { error: formatUiError(error) });
        if (this.requestedSource !== null || this.sessionKey !== null) {
          // Keep an explicit target through retry; an unresolved session has no environment yet.
          this.state = "inventory-error";
        }
      }
    } finally {
      if (operationId === this.operationId) {
        this.loading = false;
      }
    }
    if (refreshed) {
      await this.resolveRequestedSource(operationId, resolvedSessionTarget);
    }
    return refreshed;
  }

  private async resolveRequestedSource(
    operationId: number,
    resolvedSessionTarget?: string | null,
  ): Promise<void> {
    if (this.sourceSelection !== "pending" || operationId !== this.operationId) {
      return;
    }
    this.sourceSelection = "resolved";
    const requestedSource = await resolveDesktopDocumentInventoryTarget({
      client: this.client,
      source: this.requestedSource,
      // Embedded presenters already receive the chat owner's current placement; do not rediscover it.
      sessionKey: this.documentMode ? this.sessionKey : null,
      environments: this.environments,
      resolvedSessionTarget,
    });
    if (operationId !== this.operationId) {
      return;
    }
    if (requestedSource === null) {
      if (this.requestedSource !== null || this.sessionKey !== null) {
        this.state = "picker";
        this.noticeText = t("desktop.sourceUnavailable");
      }
      return;
    }
    await this.connectEnvironment(requestedSource, this.documentControl);
  }

  private async connectRequestedEnvironment(environmentId: string): Promise<void> {
    this.returnToPicker();
    this.sourceSelection = "resolved";
    this.environmentId = environmentId;
    this.state = "connecting";
    const operationId = this.operationId;
    const inventoryLoaded = await this.refreshEnvironments(operationId);
    if (operationId !== this.operationId) {
      return;
    }
    if (!inventoryLoaded) {
      this.state = "inventory-error";
      return;
    }
    void this.connectEnvironment(environmentId, false);
  }

  private async connectEnvironment(
    environmentId: string,
    control: boolean,
    options: { preserveNotice?: boolean; takeoverRecovery?: boolean } = {},
  ): Promise<void> {
    const client = this.client;
    if (!client || !this.available || (this.embedded && !this.presented)) {
      return;
    }
    if (this.environmentId !== environmentId) {
      this.clearLaunchState();
      this.credentials = undefined;
      this.credentialAuth = undefined;
    }
    const environment = this.environments.find((candidate) => candidate.id === environmentId);
    this.desktopApps = [...(environment?.worker?.desktopApps ?? [])];
    this.disconnectConnection(this.environmentId === environmentId);
    const operationId = this.operationId;
    const source = desktopSourceForEnvironment(environment ?? { id: environmentId });
    this.environmentId = environmentId;
    this.source = source;
    this.controlling = control;
    this.state = "connecting";
    this.errorText = null;
    this.disconnectedReason = null;
    if (!options.preserveNotice) {
      this.noticeText = null;
    }
    this.controlTakeoverRecoveryUsed = options.takeoverRecovery === true;
    try {
      const observeCredentials =
        source.kind !== "environment" &&
        this.credentials?.password &&
        (this.credentialAuth === "vnc-password" ||
          (this.credentialAuth === "ard-account" && this.credentials.username))
          ? this.credentials
          : undefined;
      const observed = await client.request<DesktopObserveResult>("desktop.observe", {
        source,
        control,
        ...(observeCredentials ? { credentials: observeCredentials } : {}),
      });
      if (operationId !== this.operationId) {
        return;
      }
      this.controlling = observed.control;
      const credentials = observed.preauthenticated
        ? undefined
        : observed.vncPassword
          ? { password: observed.vncPassword }
          : observed.auth === "vnc-password"
            ? this.credentials
            : undefined;
      if (
        observed.auth === "vnc-password" &&
        observed.preauthenticated !== true &&
        !credentials?.password
      ) {
        this.connection.disconnect();
        this.credentialAuth = "vnc-password";
        this.pendingConnection = { environmentId, control, observed, operationId };
        this.state = "credentials";
        return;
      }
      if (observed.auth === "ard-account") {
        this.credentialAuth = "ard-account";
      }
      await this.connectObserved(
        { environmentId, control, observed, operationId },
        observed.auth === "vnc-password" ? credentials : undefined,
      );
    } catch (error) {
      const requiredAuth = desktopCredentialRequirement(error);
      if (requiredAuth && operationId === this.operationId) {
        this.connection.disconnect();
        this.credentialAuth = requiredAuth;
        this.pendingConnection = { environmentId, control, operationId };
        this.state = "credentials";
        return;
      }
      this.failConnection(operationId, error);
    }
  }

  private async connectObserved(
    pending: ObservedDesktopConnection,
    credentials?: DesktopCredentials,
  ): Promise<void> {
    const client = this.client;
    if (!client || pending.operationId !== this.operationId) {
      return;
    }
    this.state = "connecting";
    try {
      await this.updateComplete;
      if (pending.operationId !== this.operationId) {
        return;
      }
      const target = this.shadowRoot?.querySelector<HTMLElement>(".desktop-surface");
      if (!target) {
        throw new Error("Desktop render target is unavailable");
      }
      const desktopClient = this.desktopClientFactory();
      const background = getComputedStyle(target).backgroundColor;
      const connection = await desktopClient.connect({
        background,
        isCurrent: () => pending.operationId === this.operationId,
        wsUrl: pending.observed.wsPath,
        gatewayUrl: client.gatewayUrl,
        credentials,
        viewOnly: !pending.observed.control,
        scaleViewport: this.scaleViewport,
        target,
        onConnect: () => {
          if (pending.operationId === this.operationId) {
            this.connection.markConnected();
            this.state = "connected";
          }
        },
        onDisconnect: (detail) => {
          if (pending.operationId === this.operationId) {
            this.handleDesktopDisconnect(pending.environmentId, detail.code, detail.reason);
          }
        },
        onSecurityFailure: (detail) => {
          if (pending.operationId === this.operationId) {
            const reason = formatUiExternalText(detail.reason, t("desktop.unknownReason"));
            this.errorText = t("desktop.errors.securityFailed", { reason });
            this.failConnection(pending.operationId, new Error(reason));
          }
        },
      });
      if (pending.operationId !== this.operationId) {
        connection.disconnect();
        return;
      }
      this.connection.attach(connection);
    } catch (error) {
      this.failConnection(pending.operationId, error);
    }
  }

  private failConnection(operationId: number, error: unknown): void {
    if (operationId !== this.operationId) {
      return;
    }
    this.disconnectConnection();
    this.state = "disconnected";
    this.disconnectedReason = formatUiError(error);
    this.clearLaunchState();
  }

  private handleCredentialsSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const pending = this.pendingConnection;
    if (!pending || pending.operationId !== this.operationId) {
      return;
    }
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const password = formData.get("password");
    if (typeof password !== "string" || password.length === 0) {
      return;
    }
    const username = formData.get("username");
    if (
      this.credentialAuth === "ard-account" &&
      (typeof username !== "string" || username.trim().length === 0)
    ) {
      return;
    }
    const credentials = {
      ...(typeof username === "string" && username.trim() ? { username: username.trim() } : {}),
      password,
    };
    this.credentials = credentials;
    this.pendingConnection = null;
    if (pending.observed) {
      void this.connectObserved({ ...pending, observed: pending.observed }, credentials);
    } else {
      void this.connectEnvironment(pending.environmentId, pending.control);
    }
  }

  private handleDesktopDisconnect(environmentId: string, code?: number, reason?: string): void {
    this.disconnectConnection();
    this.clearLaunchState();
    if (code === 1008 && this.credentialAuth === "ard-account") {
      this.credentials = this.credentials?.username
        ? { username: this.credentials.username }
        : undefined;
      this.pendingConnection = {
        environmentId,
        control: this.controlling,
        operationId: this.operationId,
      };
      this.state = "credentials";
      this.errorText = t("desktop.errors.securityFailed", {
        reason: formatUiExternalText(reason, t("desktop.unknownReason")),
      });
      return;
    }
    if (
      code === 4000 &&
      reason === "control-taken" &&
      this.controlling &&
      !this.controlTakeoverRecoveryUsed
    ) {
      this.noticeText = t("desktop.controlTaken");
      void this.connectEnvironment(environmentId, false, {
        preserveNotice: true,
        takeoverRecovery: true,
      });
      return;
    }
    this.state = "disconnected";
    this.disconnectedReason =
      formatUiExternalText(reason, code ? t("desktop.closeCode", { code: String(code) }) : "") ||
      null;
  }

  private async launchApp(app: DesktopAppId): Promise<void> {
    const client = this.client;
    const source = this.source;
    if (
      !client ||
      (this.embedded && !this.presented) ||
      source?.kind !== "environment" ||
      (this.state !== "connecting" && this.state !== "connected") ||
      !this.desktopApps.includes(app) ||
      this.launchingApp === app
    ) {
      return;
    }
    const operationId = ++this.launchOperationId;
    this.launchingApp = app;
    this.launchErrorText = null;
    try {
      await client.request<WorkerDesktopLaunchResult>("desktop.launch", {
        source,
        app,
      });
      if (operationId !== this.launchOperationId || source !== this.source) {
        return;
      }
      this.launchingApp = null;
    } catch (error) {
      if (operationId !== this.launchOperationId || source !== this.source) {
        return;
      }
      this.launchingApp = null;
      this.launchErrorText = formatUiError(error);
    }
  }

  override render() {
    if (!this.available) {
      return nothing;
    }
    const notice = renderDesktopNotice(
      this.fullscreenMode.errorText ?? this.launchErrorText ?? this.errorText,
      this.noticeText,
    );
    const picker = renderDesktopPicker({
      environments: this.environments,
      loading: this.loading,
      onRefresh: () => void this.refreshEnvironments(),
      onConnect: (environmentId) => void this.connectEnvironment(environmentId, false),
    });
    const credentials = renderDesktopCredentials({
      ardAccount: this.credentialAuth === "ard-account",
      username: this.credentials?.username ?? "",
      onSubmit: (event) => this.handleCredentialsSubmit(event),
    });
    const recovery = renderDesktopPanelRecovery({
      inventoryError: this.state === "inventory-error",
      reason: this.disconnectedReason,
      onRetry: () => {
        if (this.state === "inventory-error" && (this.documentMode || !this.environmentId)) {
          if (this.sourceSelection !== "picker") {
            this.sourceSelection = "pending";
          }
          this.state = "picker";
          void this.refreshEnvironments();
          return;
        }
        if (!this.environmentId) {
          return;
        }
        if (this.state === "inventory-error") {
          void this.connectRequestedEnvironment(this.environmentId);
          return;
        }
        void this.connectEnvironment(this.environmentId, this.controlling);
      },
    });
    const connection = renderDesktopConnection({
      state: this.state,
      controlling: this.controlling,
      desktopApps: this.desktopApps,
      environmentSelected: this.environmentId !== null,
      launchingApp: this.launchingApp,
      showApps: this.source?.kind === "environment",
      onLaunch: (app) => void this.launchApp(app),
      onTakeControl: () => {
        if (this.environmentId) {
          void this.connectEnvironment(this.environmentId, true);
        }
      },
      onDisconnect: () => this.returnToPicker(),
    });
    if (this.documentMode) {
      return renderDesktopDocumentView({
        state: this.state,
        controlling: this.controlling,
        scaleViewport: this.scaleViewport,
        keyboardInputValue: this.mobileKeyboard.value,
        notice,
        picker,
        credentials,
        recovery,
        onControlToggle: () => {
          if (this.environmentId) {
            void this.connectEnvironment(this.environmentId, !this.controlling);
          }
        },
        onKeyboardFocus: () => this.mobileKeyboard.focus(),
        onKeyboardEvent: (event) => this.mobileKeyboard.handleKeyboardEvent(event),
        onKeyboardInput: (event) => this.mobileKeyboard.handleInput(event),
        onScaleToggle: () => {
          this.scaleViewport = !this.scaleViewport;
          this.connection.handle?.setScaleViewport?.(this.scaleViewport);
        },
        onClose: () => this.onDocumentClose?.(),
      });
    }
    if (!this.embedded && !this.dockLayout.open) {
      return nothing;
    }
    const dock = this.dockLayout.dock;
    const style = this.embedded
      ? ""
      : this.fullscreenMode.active
        ? ""
        : dock === "bottom"
          ? `height:${this.dockLayout.height}px`
          : `width:${this.dockLayout.width}px`;
    return html`
      <section
        class="bp bp--${this.embedded ? "embedded" : dock}"
        style=${style}
        aria-label=${t("desktop.title")}
      >
        ${this.embedded ? nothing : this.dockLayout.renderResizer("bp", t("desktop.resize"))}
        ${
          this.embedded
            ? nothing
            : renderDesktopPanelHeader({
                dock,
                fullscreenControl: this.fullscreenMode.renderButton(),
                onDock: (nextDock) => this.dockLayout.setDock(nextDock),
                onOpenWindow: () =>
                  openDesktopFocus(this.basePath, this.environmentId, this.controlling),
                onClose: () => this.closePanel(),
              })
        }
        ${renderDesktopPanelContent({
          state: this.state,
          notice,
          picker,
          recovery,
          credentials,
          connection,
        })}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-desktop-panel")) {
  customElements.define("openclaw-desktop-panel", OpenClawDesktopPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-desktop-panel": OpenClawDesktopPanel;
  }
}
