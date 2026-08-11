import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  WorkerDesktopAppId,
  WorkerDesktopLaunchResult,
  WorkerDesktopObserveResult,
} from "@openclaw/gateway-protocol";
import { css, html, nothing, svg } from "lit";
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
import { desktopPanelLauncherStyles } from "./desktop-panel-launcher-styles.ts";

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

type DesktopPanelState = "picker" | "connecting" | "connected" | "disconnected";
type DesktopAppId = WorkerDesktopAppId;

/** `<openclaw-desktop-panel>` — dockable RFB access to cloud-worker desktops. */
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
  @state() private controlling = false;
  @state() private errorText: string | null = null;
  @state() private noticeText: string | null = null;
  @state() private disconnectedReason: string | null = null;
  @state() private launchingApp: DesktopAppId | null = null;
  @state() private launchErrorText: string | null = null;
  @state() private desktopApps: DesktopAppId[] = [];

  private connection: DesktopConnectionHandle | null = null;
  private operationId = 0;
  private launchOperationId = 0;
  private controlTakeoverRecoveryUsed = false;
  private readonly dockLayout = new DockLayoutController(this, {
    layout: panelLayout,
    reservationPrefix: "desktop",
    isAvailable: () => this.available,
  });
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);

  static override styles = [
    dockPanelStyles,
    desktopPanelLauncherStyles,
    css`
      .bp--bottom {
        left: var(--shell-nav-width, 0);
        right: calc(var(--oc-terminal-reserve-right, 0px) + var(--oc-browser-reserve-right, 0px));
        bottom: calc(
          var(--oc-terminal-reserve-bottom, 0px) + var(--oc-browser-reserve-bottom, 0px)
        );
      }
      .bp--right {
        top: var(--shell-topbar-height, 0);
        right: calc(var(--oc-terminal-reserve-right, 0px) + var(--oc-browser-reserve-right, 0px));
        bottom: var(--oc-terminal-reserve-bottom, 0px);
      }
      .bp-title {
        min-width: 0;
        padding-left: 8px;
        font-size: 13px;
        font-weight: 600;
      }
      .bp-icon.is-active {
        color: var(--accent, #ff5c5c);
        background: color-mix(in srgb, var(--accent, #ff5c5c) 14%, transparent);
      }
      .desktop-content {
        display: flex;
        flex: 1;
        min-height: 0;
        flex-direction: column;
      }
      .desktop-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--border, #262b34);
      }
      .desktop-toolbar--connection {
        min-height: 42px;
        gap: 12px;
      }
      .desktop-toolbar__spacer {
        flex: 1;
      }
      .desktop-button {
        border: 1px solid var(--border, #262b34);
        border-radius: 6px;
        padding: 5px 10px;
        background: transparent;
        color: var(--text, #d7dae0);
        font: inherit;
        font-size: 12px;
      }
      .desktop-button:hover:not(:disabled) {
        background: color-mix(in srgb, var(--text, #d7dae0) 10%, transparent);
      }
      .desktop-button--primary {
        border-color: var(--accent, #ff5c5c);
        color: var(--accent, #ff5c5c);
      }
      .desktop-button:disabled {
        opacity: 0.5;
      }
      .desktop-session {
        overflow: hidden;
        max-width: 100%;
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .desktop-note {
        padding: 7px 12px;
        border-bottom: 1px solid var(--border, #262b34);
        color: var(--muted, #8a919e);
        font-size: 12px;
      }
      .desktop-note--error {
        color: var(--danger, #ff6b6b);
      }
      .desktop-picker,
      .desktop-status {
        display: flex;
        flex: 1;
        min-height: 0;
        flex-direction: column;
        gap: 10px;
        overflow: auto;
        padding: 14px;
        background: var(--panel);
      }
      .desktop-status {
        align-items: center;
        justify-content: center;
        text-align: center;
        color: var(--muted, #8a919e);
      }
      .desktop-environment {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px;
        border: 1px solid var(--border, #262b34);
        border-radius: 8px;
      }
      .desktop-environment__details {
        display: flex;
        flex: 1;
        min-width: 0;
        flex-direction: column;
        gap: 5px;
      }
      .desktop-environment__id {
        overflow: hidden;
        color: var(--text, #d7dae0);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .desktop-environment__meta,
      .desktop-environment__sessions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 5px;
        color: var(--muted, #8a919e);
        font-size: 11px;
      }
      .desktop-stage {
        position: relative;
        flex: 1;
        min-height: 0;
        overflow: hidden;
        background: var(--bg);
      }
      .desktop-surface {
        position: absolute;
        inset: 0;
        background: var(--bg);
      }
    `,
  ];

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
      void this.connectEnvironment(detail.environmentId, false);
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
    this.desktopApps = [];
    this.controlling = false;
    this.disconnectedReason = null;
  }

  private disconnectConnection(): void {
    this.operationId += 1;
    const connection = this.connection;
    this.connection = null;
    connection?.disconnect();
  }

  private clearLaunchState(): void {
    this.launchOperationId += 1;
    this.launchingApp = null;
    this.launchErrorText = null;
  }

  private async refreshEnvironments(): Promise<void> {
    const client = this.client;
    if (!client || !this.available) {
      return;
    }
    const operationId = ++this.operationId;
    this.loading = true;
    this.errorText = null;
    try {
      const result = await client.request<EnvironmentsListResult>("environments.list", {});
      if (operationId !== this.operationId) {
        return;
      }
      this.environments = result.environments.filter(
        (environment) => environment.worker?.desktop === true,
      );
    } catch (error) {
      if (operationId === this.operationId) {
        this.errorText = t("desktop.errors.listFailed", { error: formatUiError(error) });
      }
    } finally {
      if (operationId === this.operationId) {
        this.loading = false;
      }
    }
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
      this.desktopApps = [
        ...(this.environments.find((environment) => environment.id === environmentId)?.worker
          ?.desktopApps ?? []),
      ];
    }
    this.disconnectConnection();
    const operationId = this.operationId;
    this.environmentId = environmentId;
    this.controlling = control;
    this.state = "connecting";
    this.errorText = null;
    this.disconnectedReason = null;
    if (!options.preserveNotice) {
      this.noticeText = null;
    }
    this.controlTakeoverRecoveryUsed = options.takeoverRecovery === true;
    try {
      const observed = await client.request<WorkerDesktopObserveResult>("worker.desktop.observe", {
        environmentId,
        control,
      });
      if (operationId !== this.operationId) {
        return;
      }
      await this.updateComplete;
      const target = this.shadowRoot?.querySelector<HTMLElement>(".desktop-surface");
      if (!target) {
        throw new Error("Desktop render target is unavailable");
      }
      const desktopClient = this.desktopClientFactory();
      const background = getComputedStyle(target).backgroundColor;
      const connection = await desktopClient.connect({
        background,
        wsUrl: observed.wsPath,
        gatewayUrl: client.gatewayUrl,
        password: observed.vncPassword,
        viewOnly: !observed.control,
        target,
        onConnect: () => {
          if (operationId === this.operationId) {
            this.state = "connected";
          }
        },
        onDisconnect: (detail) => {
          if (operationId === this.operationId) {
            this.handleDesktopDisconnect(environmentId, detail.code, detail.reason);
          }
        },
        onSecurityFailure: (detail) => {
          if (operationId === this.operationId) {
            this.errorText = t("desktop.errors.securityFailed", {
              reason: detail.reason ?? t("desktop.unknownReason"),
            });
          }
        },
      });
      if (operationId !== this.operationId) {
        connection.disconnect();
        return;
      }
      this.connection = connection;
    } catch (error) {
      if (operationId === this.operationId) {
        this.state = "disconnected";
        this.disconnectedReason = formatUiError(error);
        this.clearLaunchState();
      }
    }
  }

  private handleDesktopDisconnect(environmentId: string, code?: number, reason?: string): void {
    this.connection = null;
    this.clearLaunchState();
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
    const environmentId = this.environmentId;
    if (
      !client ||
      !environmentId ||
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
      await client.request<WorkerDesktopLaunchResult>("worker.desktop.launch", {
        environmentId,
        app,
      });
      if (operationId !== this.launchOperationId || environmentId !== this.environmentId) {
        return;
      }
      this.launchingApp = null;
    } catch (error) {
      if (operationId !== this.launchOperationId || environmentId !== this.environmentId) {
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
    return html`
      <div class="desktop-environment">
        <div class="desktop-environment__details">
          <div class="desktop-environment__id">${environment.id}</div>
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
        ${this.desktopApps.length > 0
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
        ${!this.controlling
          ? html`<button
              class="desktop-toolbar-action"
              type="button"
              title=${t("desktop.takeControl")}
              aria-label=${t("desktop.takeControl")}
              @click=${() =>
                this.environmentId && void this.connectEnvironment(this.environmentId, true)}
            >
              ${t("desktop.takeControl")}
            </button>`
          : nothing}
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

  private renderDisconnected() {
    return html`
      <div class="desktop-status">
        <div>
          ${t("desktop.disconnected", {
            reason: this.disconnectedReason ?? t("desktop.unknownReason"),
          })}
        </div>
        <button
          class="desktop-button desktop-button--primary"
          type="button"
          @click=${() =>
            this.environmentId &&
            void this.connectEnvironment(this.environmentId, this.controlling)}
        >
          ${t("desktop.reconnect")}
        </button>
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
            : this.state === "disconnected"
              ? this.renderDisconnected()
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
