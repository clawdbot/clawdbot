import type {
  DesktopObserveResult,
  DesktopSource,
  EnvironmentSummary,
  EnvironmentsListResult,
  WorkerDesktopAppId,
  WorkerDesktopLaunchResult,
} from "@openclaw/gateway-protocol";
import { html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import { DockLayoutController, dockPanelStyles } from "../dock-layout-controller.ts";
import { createDockPanelLayout } from "../dock-panel-layout.ts";
import { icons } from "../icons.ts";
import {
  DESKTOP_PANEL_TOGGLE_EVENT,
  type DesktopPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import { desktopAppIcon, desktopAppLabel } from "./desktop-app-presentation.ts";
import { DesktopClient, type DesktopConnectionHandle } from "./desktop-client.ts";
import { desktopCredentialRequirement } from "./desktop-panel-credentials.ts";
import { desktopPanelLauncherStyles } from "./desktop-panel-launcher-styles.ts";
import { type DesktopPanelState, renderDesktopPanelRecovery } from "./desktop-panel-state.ts";
import { desktopPanelStyles } from "./desktop-panel-styles.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const DOCK_BOTTOM_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 10h12" /></svg>`;
const DOCK_RIGHT_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>`;

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

/** `<openclaw-desktop-panel>` — dockable RFB access to Gateway desktop sources. */
class OpenClawDesktopPanel extends OpenClawLitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) available = false;
  @property({ type: Boolean }) suppressed = false;

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

  private connection: DesktopConnectionHandle | null = null;
  private credentials: DesktopCredentials | undefined;
  private credentialAuth: "vnc-password" | "ard-account" | undefined;
  private pendingConnection: PendingDesktopConnection | null = null;
  private operationId = 0;
  private launchOperationId = 0;
  private controlTakeoverRecoveryUsed = false;
  private readonly dockLayout = new DockLayoutController(this, {
    layout: panelLayout,
    reservationPrefix: "desktop",
    isAvailable: () => this.available,
  });
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);

  static override styles = [dockPanelStyles, desktopPanelLauncherStyles, desktopPanelStyles];

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.dockLayout.setSuppressed(this.suppressed);
    if (this.dockLayout.open) {
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
    if (changed.has("client") || changed.has("available")) {
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
    try {
      const result = await client.request<EnvironmentsListResult>("environments.list", {});
      if (operationId !== this.operationId) {
        return false;
      }
      this.environments = result.environments.filter((environment) => environment.desktop === true);
      return true;
    } catch (error) {
      if (operationId === this.operationId) {
        this.errorText = t("desktop.errors.listFailed", { error: formatUiError(error) });
      }
      return false;
    } finally {
      if (operationId === this.operationId) {
        this.loading = false;
      }
    }
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

  private renderHeader() {
    const dock = this.dockLayout.dock;
    return html`
      <header class="bp-header">
        <div class="bp-title">${t("desktop.title")}</div>
        <div class="bp-actions">
          <button
            class="bp-icon ${dock === "bottom" ? "is-active" : ""}"
            type="button"
            title=${t("desktop.dockBottom")}
            aria-label=${t("desktop.dockBottom")}
            @click=${() => this.dockLayout.setDock("bottom")}
          >
            ${DOCK_BOTTOM_GLYPH}
          </button>
          <button
            class="bp-icon ${dock === "right" ? "is-active" : ""}"
            type="button"
            title=${t("desktop.dockRight")}
            aria-label=${t("desktop.dockRight")}
            @click=${() => this.dockLayout.setDock("right")}
          >
            ${DOCK_RIGHT_GLYPH}
          </button>
          <button
            class="bp-icon"
            type="button"
            title=${t("desktop.hide")}
            aria-label=${t("desktop.hide")}
            @click=${() => this.closePanel()}
          >
            ${CLOSE_GLYPH}
          </button>
        </div>
      </header>
    `;
  }

  private renderPicker() {
    return html`
      <div class="desktop-toolbar">
        <span>${t("desktop.pickerTitle")}</span>
        <span class="desktop-toolbar__spacer"></span>
        <button
          class="desktop-button"
          type="button"
          ?disabled=${this.loading}
          @click=${() => void this.refreshEnvironments()}
        >
          ${this.loading ? t("desktop.refreshing") : t("desktop.refresh")}
        </button>
      </div>
      <div class="desktop-picker">
        ${this.loading && this.environments.length === 0
          ? html`<div class="desktop-status">${t("desktop.loading")}</div>`
          : this.environments.length === 0
            ? html`<div class="desktop-status">${t("desktop.empty")}</div>`
            : this.environments.map((environment) => this.renderEnvironment(environment))}
      </div>
    `;
  }

  private renderEnvironment(environment: EnvironmentSummary) {
    const worker = environment.worker;
    const source = desktopSourceForEnvironment(environment);
    return html`
      <div class="desktop-environment">
        <div class="desktop-environment__details">
          <div class="desktop-environment__id">
            ${source.kind === "host" ? t("desktop.thisMachine") : environment.id}
          </div>
          <div class="desktop-environment__meta">
            <span>${worker?.state ?? environment.status}</span>
          </div>
          ${worker && worker.attachedSessionIds.length > 0
            ? html`<div class="desktop-environment__sessions">
                ${worker.attachedSessionIds.map(
                  (sessionId) => html`<span class="desktop-session">${sessionId}</span>`,
                )}
              </div>`
            : nothing}
        </div>
        <button
          class="desktop-button desktop-button--primary"
          type="button"
          @click=${() => void this.connectEnvironment(environment.id, false)}
        >
          ${t("desktop.connect")}
        </button>
      </div>
    `;
  }

  private renderConnection() {
    return html`
      <div class="desktop-toolbar desktop-toolbar--connection">
        ${this.source?.kind === "environment" && this.desktopApps.length > 0
          ? html`<div class="desktop-apps">
              ${this.desktopApps.map((app) => {
                const launching = this.launchingApp === app;
                const label = desktopAppLabel(app);
                return html`<button
                  class="desktop-app-button"
                  type="button"
                  title=${label}
                  aria-label=${label}
                  aria-busy=${launching ? "true" : "false"}
                  ?disabled=${!this.environmentId || launching}
                  @click=${() => void this.launchApp(app)}
                >
                  <span
                    class="desktop-app-button__icon ${launching
                      ? "desktop-app-button__icon--launching"
                      : ""}"
                    aria-hidden="true"
                  >
                    ${desktopAppIcon(app)}
                  </span>
                  <span>${label}</span>
                </button>`;
              })}
            </div>`
          : nothing}
        <span class="desktop-toolbar__spacer"></span>
        <button
          class="desktop-toolbar-action"
          type="button"
          title=${t("desktop.disconnect")}
          aria-label=${t("desktop.disconnect")}
          @click=${() => this.returnToPicker()}
        >
          ${t("desktop.disconnect")}
        </button>
      </div>
      <div class="desktop-stage">
        <div class="desktop-surface"></div>
        ${!this.controlling
          ? html`<button
              class="desktop-stage__take-control"
              type="button"
              title=${t("desktop.takeControl")}
              aria-label=${t("desktop.takeControl")}
              @click=${() =>
                this.environmentId && void this.connectEnvironment(this.environmentId, true)}
            ></button>`
          : nothing}
        ${this.state === "connecting"
          ? html`<div class="desktop-connecting" role="status" aria-live="polite">
              <span class="desktop-connecting__monitor" aria-hidden="true">${icons.monitor}</span>
              <span class="desktop-connecting__copy">
                ${t("desktop.connecting")}
                <span class="desktop-connecting__dots" aria-hidden="true">
                  <span class="desktop-connecting__dot"></span>
                  <span class="desktop-connecting__dot"></span>
                  <span class="desktop-connecting__dot"></span>
                </span>
              </span>
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderCredentials() {
    const ardAccount = this.credentialAuth === "ard-account";
    return html`
      <div class="desktop-status">
        <form
          class="desktop-credentials"
          @submit=${(event: SubmitEvent) => this.handleCredentialsSubmit(event)}
        >
          <div>${t(ardAccount ? "desktop.accountPrompt" : "desktop.passwordPrompt")}</div>
          ${ardAccount
            ? html`<label class="desktop-credentials__label">
                ${t("desktop.usernameLabel")}
                <input
                  class="desktop-credentials__input"
                  name="username"
                  type="text"
                  autocomplete="off"
                  .value=${this.credentials?.username ?? ""}
                  required
                />
              </label>`
            : nothing}
          <label class="desktop-credentials__label">
            ${t(ardAccount ? "desktop.accountPasswordLabel" : "desktop.passwordLabel")}
            <input
              class="desktop-credentials__input"
              name="password"
              type="password"
              autocomplete="off"
              required
            />
          </label>
          <button class="desktop-button desktop-button--primary" type="submit">
            ${t("desktop.connect")}
          </button>
        </form>
      </div>
    `;
  }

  override render() {
    if (!this.available || !this.dockLayout.open) {
      return nothing;
    }
    const dock = this.dockLayout.dock;
    const style =
      dock === "bottom" ? `height:${this.dockLayout.height}px` : `width:${this.dockLayout.width}px`;
    const visibleErrorText = this.launchErrorText ?? this.errorText;
    return html`
      <section class="bp bp--${dock}" style=${style} aria-label=${t("desktop.title")}>
        ${this.dockLayout.renderResizer("bp", t("desktop.resize"))} ${this.renderHeader()}
        <div class="desktop-content">
          ${visibleErrorText
            ? html`<div class="desktop-note desktop-note--error" role="alert">
                ${visibleErrorText}
              </div>`
            : this.noticeText
              ? html`<div class="desktop-note" role="status">${this.noticeText}</div>`
              : nothing}
          ${this.state === "picker"
            ? this.renderPicker()
            : this.state === "inventory-error" || this.state === "disconnected"
              ? renderDesktopPanelRecovery({
                  inventoryError: this.state === "inventory-error",
                  reason: this.disconnectedReason,
                  onRetry: () =>
                    this.environmentId &&
                    void (this.state === "inventory-error"
                      ? this.connectRequestedEnvironment(this.environmentId)
                      : this.connectEnvironment(this.environmentId, this.controlling)),
                })
              : this.state === "credentials"
                ? this.renderCredentials()
                : this.renderConnection()}
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
