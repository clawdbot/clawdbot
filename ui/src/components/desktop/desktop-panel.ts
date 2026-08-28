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
import { DesktopClient, type DesktopConnectionHandle } from "./desktop-client.ts";
import { resolveDesktopDocumentInventoryTarget } from "./desktop-document-inventory.ts";
import { renderDesktopDocumentView } from "./desktop-document-view.ts";
import { openDesktopFocus } from "./desktop-focus-window.ts";
import { DesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type {
  DesktopAppId,
  DesktopCredentials,
  ObservedDesktopConnection,
  PendingDesktopConnection,
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
  renderDesktopPanelHeader,
  renderDesktopPicker,
} from "./desktop-panel-view.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

/** `<openclaw-desktop-panel>` — dockable RFB access to Gateway desktop sources. */
class OpenClawDesktopPanel extends OpenClawLitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) available = false;
  @property({ type: Boolean }) suppressed = false;
  @property({ type: Boolean }) documentMode = false;
  @property({ attribute: false }) documentSource: string | null = null;
  @property({ attribute: false }) documentSession: string | null = null;
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

  private connection: DesktopConnectionHandle | null = null;
  private credentials: DesktopCredentials | undefined;
  private credentialAuth: "vnc-password" | "ard-account" | undefined;
  private pendingConnection: PendingDesktopConnection | null = null;
  private operationId = 0;
  private launchOperationId = 0;
  private controlTakeoverRecoveryUsed = false;
  private documentSourceResolved = false;
  private readonly mobileKeyboard = new DesktopMobileKeyboard({
    connection: () => this.connection,
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
    if (changed.has("documentSource") || changed.has("documentSession")) {
      this.documentSourceResolved = false;
    }
    const gatewayAvailabilityChanged = changed.has("client") || changed.has("available");
    const embeddedPresentationChanged =
      this.embedded && (changed.has("embedded") || changed.has("presented"));
    const documentPresentationChanged =
      changed.has("documentMode") ||
      changed.has("documentSource") ||
      changed.has("documentSession") ||
      changed.has("documentControl");
    if (this.documentMode && (gatewayAvailabilityChanged || documentPresentationChanged)) {
      if (!this.available) {
        this.documentSourceResolved = false;
        this.returnToPicker();
      } else {
        void this.refreshEnvironments();
      }
    } else if (this.embedded && (embeddedPresentationChanged || gatewayAvailabilityChanged)) {
      this.returnToPicker();
      if (this.presented && this.available && this.client && this.refreshOnPresentation) {
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

  private disconnectConnection(): void {
    this.operationId += 1;
    this.pendingConnection = null;
    const connection = this.connection;
    this.connection = null;
    connection?.disconnect();
    this.mobileKeyboard.reset();
  }

  private clearLaunchState(): void {
    this.launchOperationId += 1;
    this.launchingApp = null;
    this.launchErrorText = null;
  }

  private async refreshEnvironments(expectedOperationId?: number): Promise<boolean> {
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
        if (this.documentMode && (this.documentSource !== null || this.documentSession !== null)) {
          // A session key only names a machine once the inventory loads, so it stays out of
          // `environmentId`; document-mode retry refreshes the inventory rather than reconnecting.
          this.environmentId = this.documentSource;
          this.state = "inventory-error";
        }
      }
    } finally {
      if (operationId === this.operationId) {
        this.loading = false;
      }
    }
    if (refreshed) {
      await this.resolveDocumentSource(operationId);
    }
    return refreshed;
  }

  private async resolveDocumentSource(operationId: number): Promise<void> {
    if (!this.documentMode || this.documentSourceResolved || operationId !== this.operationId) {
      return;
    }
    this.documentSourceResolved = true;
    const requestedSource = await resolveDesktopDocumentInventoryTarget({
      client: this.client,
      source: this.documentSource,
      sessionKey: this.documentSession,
      environments: this.environments,
    });
    if (operationId !== this.operationId) {
      return;
    }
    if (requestedSource === null) {
      if (this.documentSource !== null || this.documentSession !== null) {
        this.state = "picker";
        this.noticeText = t("desktop.sourceUnavailable");
      }
      return;
    }
    await this.connectEnvironment(requestedSource, this.documentControl);
  }

  private async connectRequestedEnvironment(environmentId: string): Promise<void> {
    this.returnToPicker();
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
    this.desktopApps = [
      ...(this.environments.find((environment) => environment.id === environmentId)?.worker
        ?.desktopApps ?? []),
    ];
    this.disconnectConnection();
    const operationId = this.operationId;
    const environment = this.environments.find((candidate) => candidate.id === environmentId) ?? {
      id: environmentId,
    };
    const source = desktopSourceForEnvironment(environment);
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
        wsUrl: pending.observed.wsPath,
        gatewayUrl: client.gatewayUrl,
        credentials,
        viewOnly: !pending.observed.control,
        scaleViewport: this.scaleViewport,
        target,
        onConnect: () => {
          if (pending.operationId === this.operationId) {
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
            this.errorText = t("desktop.errors.securityFailed", {
              reason: formatUiExternalText(detail.reason, t("desktop.unknownReason")),
            });
          }
        },
      });
      if (pending.operationId !== this.operationId) {
        connection.disconnect();
        return;
      }
      this.connection = connection;
    } catch (error) {
      this.failConnection(pending.operationId, error);
    }
  }

  private failConnection(operationId: number, error: unknown): void {
    if (operationId !== this.operationId) {
      return;
    }
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
    this.connection = null;
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
        if (this.state === "inventory-error" && this.documentMode) {
          this.documentSourceResolved = false;
          this.state = "connecting";
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
          this.connection?.setScaleViewport?.(this.scaleViewport);
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
        ${this.embedded
          ? nothing
          : renderDesktopPanelHeader({
              dock,
              fullscreenControl: this.fullscreenMode.renderButton(),
              onDock: (nextDock) => this.dockLayout.setDock(nextDock),
              onOpenWindow: () =>
                openDesktopFocus(this.basePath, this.environmentId, this.controlling),
              onClose: () => this.closePanel(),
            })}
        <div class="desktop-content">
          ${notice}
          ${this.state === "picker"
            ? picker
            : this.state === "inventory-error" || this.state === "disconnected"
              ? recovery
              : this.state === "credentials"
                ? credentials
                : connection}
        </div>
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
