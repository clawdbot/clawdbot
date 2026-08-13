import type {
  DesktopObserveResult,
  DesktopSource,
  EnvironmentSummary,
  EnvironmentsListResult,
  WorkerDesktopAppId,
  WorkerDesktopLaunchResult,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import { DockLayoutController, dockPanelStyles } from "../dock-layout-controller.ts";
import { createDockPanelLayout } from "../dock-panel-layout.ts";
import {
  DESKTOP_PANEL_TOGGLE_EVENT,
  type DesktopPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import { DesktopClient, type DesktopConnectionHandle } from "./desktop-client.ts";
import { desktopDocumentStyles } from "./desktop-document-styles.ts";
import { renderDesktopDocumentView } from "./desktop-document-view.ts";
import { desktopCredentialRequirement } from "./desktop-panel-credentials.ts";
import { desktopPanelLauncherStyles } from "./desktop-panel-launcher-styles.ts";
import { type DesktopPanelState, renderDesktopPanelRecovery } from "./desktop-panel-state.ts";
import { desktopPanelStyles } from "./desktop-panel-styles.ts";
import {
  renderDesktopConnection,
  renderDesktopCredentials,
  renderDesktopNotice,
  renderDesktopPanelHeader,
  renderDesktopPicker,
} from "./desktop-panel-view.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

const panelLayout = createDockPanelLayout({
  storageKey: "openclaw.desktopPanel",
  minHeight: 240,
  minWidth: 380,
  defaultDock: "right",
  supportedDocks: ["bottom", "right"],
  defaultHeight: 420,
  defaultWidth: 560,
});
type DesktopAppId = WorkerDesktopAppId;
type DesktopCredentials = { username?: string; password?: string };
type PendingDesktopConnection = {
  environmentId: string;
  control: boolean;
  observed?: DesktopObserveResult;
  operationId: number;
};
type ObservedDesktopConnection = PendingDesktopConnection & { observed: DesktopObserveResult };
const MOBILE_KEYBOARD_SENTINEL = "________________";

/** `<openclaw-desktop-panel>` — dockable RFB access to Gateway desktop sources. */
class OpenClawDesktopPanel extends OpenClawLitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) available = false;
  @property({ type: Boolean }) suppressed = false;
  @property({ type: Boolean }) documentMode = false;
  @property({ attribute: false }) documentSource: string | null = null;
  @property({ type: Boolean }) documentControl = false;
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
  private keyboardInputValue = MOBILE_KEYBOARD_SENTINEL;
  private readonly dockLayout = new DockLayoutController(this, {
    layout: panelLayout,
    reservationPrefix: "desktop",
    isAvailable: () => this.available,
  });
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);

  static override styles = [
    dockPanelStyles,
    desktopPanelLauncherStyles,
    desktopPanelStyles,
    desktopDocumentStyles,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.dockLayout.setSuppressed(this.suppressed);
    if (this.documentMode && this.available) {
      void this.refreshEnvironments();
    } else if (this.dockLayout.open) {
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
    if (changed.has("suppressed")) {
      const restored = this.dockLayout.setSuppressed(this.suppressed);
      if (this.suppressed) {
        this.returnToPicker();
      } else if (restored) {
        void this.refreshEnvironments();
      }
    }
    if (changed.has("documentSource")) {
      this.documentSourceResolved = false;
    }
    const gatewayAvailabilityChanged = changed.has("client") || changed.has("available");
    const documentPresentationChanged =
      changed.has("documentMode") ||
      changed.has("documentSource") ||
      changed.has("documentControl");
    if (this.documentMode && (gatewayAvailabilityChanged || documentPresentationChanged)) {
      if (!this.available) {
        this.documentSourceResolved = false;
        this.returnToPicker();
      } else {
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
    this.resetDocumentKeyboardInput();
  }

  private clearLaunchState(): void {
    this.launchOperationId += 1;
    this.launchingApp = null;
    this.launchErrorText = null;
  }

  private async refreshEnvironments(expectedOperationId?: number): Promise<boolean> {
    const client = this.client;
    if (!client || !this.available) {
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
        if (this.documentMode && this.documentSource !== null) {
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
    const requestedSource = this.documentSource;
    if (requestedSource === null) {
      return;
    }
    if (!this.environments.some((environment) => environment.id === requestedSource)) {
      this.state = "picker";
      this.noticeText = t("desktop.sourceUnavailable");
      return;
    }
    await this.connectEnvironment(requestedSource, this.documentControl);
  }

  private retryDocumentInventory(): void {
    this.documentSourceResolved = false;
    this.state = "connecting";
    void this.refreshEnvironments();
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
    if (!client || !this.available) {
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
              reason: detail.reason ?? t("desktop.unknownReason"),
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
        reason: reason || t("desktop.unknownReason"),
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
      reason || (code ? t("desktop.closeCode", { code: String(code) }) : null);
  }

  private async launchApp(app: DesktopAppId): Promise<void> {
    const client = this.client;
    const source = this.source;
    if (
      !client ||
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

  private handleDocumentKeyboardEvent(event: KeyboardEvent): void {
    if (!this.controlling || !this.connection?.sendKeyboardEvent) {
      return;
    }
    this.connection.sendKeyboardEvent(event);
    event.preventDefault();
  }

  private handleDocumentKeyboardInput(event: InputEvent): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    if (!this.controlling) {
      this.resetDocumentKeyboardInput(input);
      return;
    }
    const previousValue = this.keyboardInputValue;
    const nextValue = input.value;
    let prefixLength = 0;
    const comparableLength = Math.min(previousValue.length, nextValue.length);
    while (
      prefixLength < comparableLength &&
      previousValue.charAt(prefixLength) === nextValue.charAt(prefixLength)
    ) {
      prefixLength += 1;
    }
    const removedCount = previousValue.length - prefixLength;
    for (let index = 0; index < removedCount; index += 1) {
      this.connection?.sendBackspace?.();
    }
    this.connection?.sendText?.(nextValue.slice(prefixLength));
    if (nextValue.length < 1 || nextValue.length > MOBILE_KEYBOARD_SENTINEL.length * 2) {
      this.resetDocumentKeyboardInput(input);
      return;
    }
    this.keyboardInputValue = nextValue;
  }

  private resetDocumentKeyboardInput(input?: HTMLTextAreaElement): void {
    this.keyboardInputValue = MOBILE_KEYBOARD_SENTINEL;
    const target =
      input ?? this.shadowRoot?.querySelector<HTMLTextAreaElement>(".desktop-keyboard-input");
    if (target) {
      target.value = MOBILE_KEYBOARD_SENTINEL;
    }
  }

  private focusDocumentKeyboard(): void {
    const input = this.shadowRoot?.querySelector<HTMLTextAreaElement>(".desktop-keyboard-input");
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(input.value.length, input.value.length);
  }

  private toggleDocumentScale(): void {
    this.scaleViewport = !this.scaleViewport;
    this.connection?.setScaleViewport?.(this.scaleViewport);
  }

  override render() {
    if (!this.available) {
      return nothing;
    }
    const notice = renderDesktopNotice(this.launchErrorText ?? this.errorText, this.noticeText);
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
        if (!this.environmentId) {
          return;
        }
        if (this.state === "inventory-error") {
          if (this.documentMode) {
            this.retryDocumentInventory();
          } else {
            void this.connectRequestedEnvironment(this.environmentId);
          }
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
        keyboardInputValue: this.keyboardInputValue,
        notice,
        picker,
        credentials,
        recovery,
        onControlToggle: () => {
          if (this.environmentId) {
            void this.connectEnvironment(this.environmentId, !this.controlling);
          }
        },
        onKeyboardFocus: () => this.focusDocumentKeyboard(),
        onKeyboardEvent: (event) => this.handleDocumentKeyboardEvent(event),
        onKeyboardInput: (event) => this.handleDocumentKeyboardInput(event),
        onScaleToggle: () => this.toggleDocumentScale(),
        onClose: () => this.onDocumentClose?.(),
      });
    }
    if (!this.dockLayout.open) {
      return nothing;
    }
    const dock = this.dockLayout.dock;
    const style =
      dock === "bottom" ? `height:${this.dockLayout.height}px` : `width:${this.dockLayout.width}px`;
    return html`
      <section class="bp bp--${dock}" style=${style} aria-label=${t("desktop.title")}>
        ${this.dockLayout.renderResizer("bp", t("desktop.resize"))}
        ${renderDesktopPanelHeader({
          dock,
          onDock: (nextDock) => this.dockLayout.setDock(nextDock),
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
