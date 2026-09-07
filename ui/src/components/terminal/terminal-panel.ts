// Dockable operator terminal panel for the Control UI shell.
//
// Renders a VS Code-style shell dock (bottom by default, right, or main) with session
// tabs. Each tab hosts one libterminal Ghostty controller wired to a gateway PTY
// session. The browser runtime is dynamically imported on first open so it
// never weighs down the initial Control UI bundle.
import { initialState, Task, TaskStatus } from "@lit/task";
import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import { scrollbarShadowStyles } from "../../lit/scrollbar-styles.ts";
import { DockLayoutController, dockPanelStyles } from "../dock-layout-controller.ts";
import { terminalPanelLayout, type DockPanelPlacement } from "../dock-panel-layout.ts";
import { panelTabStripStyles } from "../panel-tab-strip.ts";
import {
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  type TerminalPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import type { TerminalGatewayClient, TerminalSessionInfo } from "./terminal-connection.ts";
import {
  renderTerminalPanelHeader,
  renderTerminalPanelToolbar,
  renderTerminalPanelViewport,
} from "./terminal-panel-chrome.ts";
import { TerminalPanelSessionController } from "./terminal-panel-session-controller.ts";
import {
  fitActiveTerminalSession,
  fitAllTerminalSessions,
  prepareTerminalSessionHostVisibility,
  reattachTerminalSessionHosts,
  updateTerminalSessionTheme,
} from "./terminal-panel-session-rendering.ts";
import type { TerminalPanelSessionTab } from "./terminal-panel-session-types.ts";
import { terminalPanelStyles } from "./terminal-panel-styles.ts";
import { terminalPanelUploadStyles } from "./terminal-panel-upload-styles.ts";
import { TerminalPanelUploadController } from "./terminal-panel-upload.ts";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";
import { renderTerminalSessionPicker } from "./terminal-session-picker.ts";

type TerminalDock = Exclude<DockPanelPlacement, "left">;

const CATALOG_TERMINAL_READY_TIMEOUT_MS = 30_000;

/** `<openclaw-terminal-panel>` — the dockable Control UI shell surface. */
export class OpenClawTerminalPanel extends OpenClawLitElement {
  /** Gateway client used for terminal.* RPCs; null until connected. */
  @property({ attribute: false }) client: TerminalGatewayClient | null = null;
  /** Agent whose workspace and sandbox policy own newly opened sessions. */
  @property({ attribute: false }) agentId: string | null = null;
  /** Conversation that owns newly opened session-scoped terminals. */
  @property({ attribute: false }) sessionKey: string | null = null;
  /** Whether the connected gateway advertises the terminal surface. */
  @property({ type: Boolean }) available = false;
  /** Full-page route takeovers (settings) own the viewport; the dock hides while one renders. */
  @property({ type: Boolean }) suppressed = false;
  /** Active Control UI color mode, mirrored into the terminal theme. */
  @property({ attribute: false }) themeMode: "dark" | "light" = "dark";
  /** Configured Control UI mount prefix used by document links. */
  @property({ attribute: false }) basePath = "";
  /**
   * Focused terminal document mode (`/focus/terminal`): fills the
   * viewport, stays open while available, and omits dock chrome.
   */
  @property({ type: Boolean }) fullscreen = false;
  /** Hosted by the chat side panel, which owns visibility and geometry. */
  @property({ type: Boolean }) embedded = false;

  @state() terminalPanelErrorText: string | null = null;
  @state() private sessionPickerOpen = false;
  @state() private pickerSessions: TerminalSessionInfo[] = [];

  private readonly sessionPickerTask = new Task(this, {
    autoRun: false,
    // The controller reads the host client; carrying its identity retires stale picker loads.
    args: () => [this.available ? this.client : null] as const,
    task: ([client]) => (client ? this.terminalSessions.listSessions() : initialState),
    onComplete: (sessions) => {
      if (sessions !== null) {
        this.pickerSessions = sessions;
      }
    },
  });
  readonly terminalPanelUploadController = new TerminalPanelUploadController({
    activeTab: () =>
      this.terminalSessions.tabs.find(
        (tab) =>
          tab.id === this.terminalSessions.activeId &&
          tab.status === "live" &&
          tab.gatewaySessionId,
      ),
    client: () => this.client,
    isCurrent: (tab) =>
      this.terminalSessions.tabs.includes(tab as TerminalPanelSessionTab) && tab.status === "live",
    fileInput: () => this.renderRoot.querySelector<HTMLInputElement>(".tp-file-input"),
    setError: (message) => (this.terminalPanelErrorText = message),
    requestUpdate: () => this.requestUpdate(),
  });
  createTerminalController = createIsolatedGhosttyTerminal;
  catalogReadyTimeoutMs = CATALOG_TERMINAL_READY_TIMEOUT_MS;
  private readonly terminalSessions = new TerminalPanelSessionController(this);
  private readonly dockLayout = new DockLayoutController(this, {
    layout: terminalPanelLayout,
    reservationPrefix: "terminal",
    isAvailable: () => this.isDockLayoutAvailable(),
    isFullscreen: () => this.fullscreen,
    onResize: () =>
      fitActiveTerminalSession(this.terminalSessions.tabs, this.terminalSessions.activeId),
  });
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);
  private readonly onDockBottomRequest = (event: Event) => this.handleToggleRequest(event);
  private readonly onDocumentPointerDown = (event: PointerEvent) =>
    this.handleDocumentPointerDown(event);
  private themeObserver: MutationObserver | null = null;

  private get sessionBottomOnly(): boolean {
    return !this.embedded && this.sessionKey !== null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.terminalSessions.connectHost();
    // A settings takeover can already own the viewport when the panel mounts.
    // Suppress before the restored open state boots a session nobody can see.
    this.dockLayout.setSuppressed(this.suppressed);
    if (!this.fullscreen && !this.embedded && !this.sessionBottomOnly) {
      window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    }
    if (!this.fullscreen && !this.embedded) {
      window.addEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, this.onDockBottomRequest);
    }
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    if (typeof MutationObserver !== "undefined") {
      this.themeObserver = new MutationObserver(() =>
        updateTerminalSessionTheme(this.terminalSessions.tabs, this.themeMode),
      );
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-theme-mode", "style"],
      });
    }
    if (this.dockLayout.open) {
      void this.terminalSessions.restoreSessions();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.removeEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, this.onDockBottomRequest);
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.terminalSessions.disconnectHost();
  }

  override updated(changed: Map<string, unknown>): void {
    if ((changed.has("embedded") || changed.has("sessionKey")) && !this.fullscreen) {
      if (this.embedded || this.sessionBottomOnly) {
        window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.onToggleRequest);
      } else {
        window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.onToggleRequest);
      }
      if (this.embedded) {
        window.removeEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, this.onDockBottomRequest);
      } else {
        window.addEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, this.onDockBottomRequest);
      }
    }
    if (changed.has("suppressed") && this.dockLayout.setSuppressed(this.suppressed)) {
      // Restoring after a takeover: a reconnect during settings disposed the tabs
      // without restoring them, so re-run the normal open path.
      void this.terminalSessions.restoreSessions();
    }
    if (changed.has("client") || changed.has("available")) {
      this.terminalSessions.scheduleLifecycleSync();
    }
    if (changed.has("themeMode")) {
      updateTerminalSessionTheme(this.terminalSessions.tabs, this.themeMode);
    }
    if (changed.has("embedded") && this.embedded) {
      void this.terminalSessions.restoreSessions();
    }
    if (this.embedded || this.dockLayout.open) {
      reattachTerminalSessionHosts(
        this.terminalSessions.tabs,
        this.terminalSessions.activeId,
        this.findTerminalPanelViewport(),
      );
    }
    this.dockLayout.syncReservation();
  }

  /** Opens the panel if closed, closes it if open. */
  toggle(): void {
    if (!this.available) {
      return;
    }
    if (this.dockLayout.open) {
      this.closeTerminalPanel();
    } else {
      this.dockLayout.setOpen(true);
      void this.terminalSessions.restoreSessions();
    }
  }

  handleToggleRequest(event: Event): void {
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as TerminalPanelToggleDetail)
        : null;
    const dock = detail?.dock === "right" || detail?.dock === "bottom" ? detail.dock : null;
    if (detail?.agentId !== undefined) {
      this.agentId = detail.agentId;
    }
    if (dock) {
      this.dockLayout.setDock(dock, false);
    }
    if (detail?.open === false) {
      this.closeTerminalPanel();
      return;
    }
    if (detail?.catalogStart) {
      event.stopImmediatePropagation();
      this.dockLayout.setOpen(true);
      detail.catalogStart.respondWith(
        this.terminalSessions.startCatalogSession(
          detail.catalogStart.params,
          detail.catalogStart.isCurrent,
        ),
      );
      return;
    }
    if (detail?.terminalSessionId || detail?.catalog || detail?.open === true) {
      if (!this.available) {
        return;
      }
      if (detail.catalog) {
        this.dockLayout.setDock("main");
      }
      this.dockLayout.setOpen(true);
      void (detail.terminalSessionId
        ? this.terminalSessions.openRequestedSession(detail.terminalSessionId)
        : detail.catalog
          ? this.terminalSessions.openCatalogSession(detail.catalog)
          : this.terminalSessions.restoreSessions());
      return;
    }
    this.toggle();
  }

  closeTerminalPanel(): void {
    this.closeSessionPicker(false);
    this.terminalSessions.cancelPendingActions();
    this.dockLayout.setOpen(false);
  }

  get terminalPanelOpen(): boolean {
    return this.embedded ? this.available : this.dockLayout.open && this.isDockLayoutAvailable();
  }

  hideTerminalPanelForUnavailableSurface(): void {
    // The surface disappeared (gateway disconnect/disable). Hide the panel
    // WITHOUT persisting: a disconnect must not overwrite the user's open
    // preference, or the reconnect path would never auto-reopen. Server
    // sessions survive for the detach grace period and reattach afterwards.
    this.dockLayout.hideWithoutPersisting();
  }

  restoreTerminalPanelOpenState(): boolean {
    return this.dockLayout.restoreOpenState();
  }

  private isDockLayoutAvailable(): boolean {
    return this.available && (!this.sessionBottomOnly || this.dockLayout.dock === "bottom");
  }

  private toggleSessionPicker(): void {
    if (this.sessionPickerOpen) {
      this.closeSessionPicker(true);
      return;
    }
    this.sessionPickerOpen = true;
    void this.refreshSessionPicker();
    void this.updateComplete.then(() => {
      if (this.sessionPickerOpen) {
        this.renderRoot.querySelector<HTMLButtonElement>(".tp-session-refresh")?.focus();
      }
    });
  }

  private closeSessionPicker(restoreFocus: boolean): void {
    if (!this.sessionPickerOpen) {
      return;
    }
    this.sessionPickerOpen = false;
    if (restoreFocus) {
      void this.updateComplete.then(() => {
        this.renderRoot
          .querySelector<HTMLButtonElement>('[aria-controls="terminal-session-picker-dialog"]')
          ?.focus();
      });
    }
  }

  private handleDocumentPointerDown(event: PointerEvent): void {
    if (!this.sessionPickerOpen) {
      return;
    }
    const picker = this.renderRoot.querySelector(".tp-session-picker");
    // Document capture sees retargeted shadow-DOM events. The composed path
    // preserves the picker wrapper so its trigger and actions stay clickable.
    const path = event.composedPath();
    if (picker && !path.includes(picker)) {
      this.closeSessionPicker(false);
    }
  }

  private handleSessionPickerFocusOut(event: FocusEvent): void {
    const picker = event.currentTarget;
    const next = event.relatedTarget;
    if (picker instanceof HTMLElement && next instanceof Node && picker.contains(next)) {
      return;
    }
    queueMicrotask(() => {
      if (
        picker instanceof HTMLElement &&
        !picker.contains(this.shadowRoot?.activeElement ?? null) &&
        this.sessionPickerOpen
      ) {
        this.closeSessionPicker(false);
      }
    });
  }

  private refreshSessionPicker(): Promise<void> {
    return this.sessionPickerTask.run();
  }

  private async attachPickedSession(
    sessionId: string,
    owner?: TerminalSessionInfo["owner"],
  ): Promise<void> {
    this.sessionPickerOpen = false;
    await this.terminalSessions.attachSessionById(sessionId, owner?.startsWith("agent:") === true);
  }

  private setDock(dock: TerminalDock): void {
    // Embedded chrome cannot dock itself: it asks the host to take the panel
    // out to the bottom slot. Every other target stays with the dock layout,
    // where "main" toggles instead of pinning.
    if (this.embedded && dock === "bottom") {
      window.dispatchEvent(
        new CustomEvent<TerminalPanelToggleDetail>(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, {
          detail: { agentId: this.agentId, dock: "bottom", open: true },
        }),
      );
      return;
    }
    this.dockLayout.setDock(dock);
    void this.updateComplete.then(() => fitAllTerminalSessions(this.terminalSessions.tabs));
  }

  private openFullscreen(): void {
    const focusPath = buildControlUiFocusPath({ kind: "terminal" }, this.basePath);
    if (focusPath) {
      openExternalUrlSafe(focusPath);
    }
  }

  resetTerminalSessionPicker(): void {
    this.closeSessionPicker(false);
    void this.sessionPickerTask.run([null]);
    this.pickerSessions = [];
  }

  findTerminalPanelViewport(): Element | null {
    return this.renderRoot.querySelector(".tp-viewport");
  }

  private retryTerminalOpen(): void {
    this.terminalPanelErrorText = null;
    this.terminalSessions.openRetry.run();
  }

  override render() {
    if (!this.terminalPanelOpen) {
      return nothing;
    }
    const mode = this.embedded ? "embedded" : this.fullscreen ? "fullscreen" : this.dockLayout.dock;
    const style =
      this.embedded || this.fullscreen || this.dockLayout.dock === "main"
        ? nothing
        : this.dockLayout.dock === "bottom"
          ? `height:${this.dockLayout.height}px;--tp-panel-height:${this.dockLayout.height}px`
          : `width:${this.dockLayout.width}px`;
    const activeTab = this.terminalSessions.tabs.find(
      (tab) => tab.id === this.terminalSessions.activeId,
    );
    const connecting =
      this.terminalSessions.waitingForRefresh ||
      (this.terminalSessions.booting && this.terminalSessions.tabs.length === 0) ||
      activeTab?.status === "connecting";
    const terminalError = this.terminalPanelErrorText
      ? {
          text: this.terminalPanelErrorText,
          retry: this.terminalSessions.openRetry.available
            ? () => this.retryTerminalOpen()
            : undefined,
        }
      : null;
    const sessionPicker = renderTerminalSessionPicker({
      open: this.sessionPickerOpen,
      loading: this.sessionPickerTask.status === TaskStatus.PENDING,
      sessions: this.pickerSessions,
      currentSessionIds: new Set(
        this.terminalSessions.tabs
          .map((tab) => tab.gatewaySessionId)
          .filter(
            (sessionId): sessionId is string =>
              typeof sessionId === "string" && sessionId.length > 0,
          ),
      ),
      onToggle: () => this.toggleSessionPicker(),
      onDismiss: (restoreFocus) => this.closeSessionPicker(restoreFocus),
      onFocusOut: (event) => this.handleSessionPickerFocusOut(event),
      onRefresh: () => void this.refreshSessionPicker(),
      onAttach: (sessionId, owner) => void this.attachPickedSession(sessionId, owner),
    });
    const toolbar = renderTerminalPanelToolbar(
      this.fullscreen,
      this.embedded,
      this.dockLayout.dock,
      this.terminalPanelUploadController,
      sessionPicker,
      (dock) => this.setDock(dock),
      () => this.openFullscreen(),
      () => this.closeTerminalPanel(),
    );
    return html`
      <section class="tp tp--${mode}" style=${style} aria-label=${t("terminal.title")}>
        ${this.embedded ? nothing : this.dockLayout.renderResizer("tp", t("terminal.resize"))}
        ${renderTerminalPanelHeader(
          this.terminalSessions.tabs,
          this.terminalSessions.activeId,
          this.terminalSessions.booting,
          toolbar,
          (id) => this.terminalSessions.switchTo(id),
          (id) => {
            this.terminalSessions.closeTab(id);
            return this.updateComplete.then(() => undefined);
          },
          () => void this.terminalSessions.openSession(),
        )}
        ${renderTerminalPanelViewport({
          activeId: this.terminalSessions.activeId,
          connecting,
          error: terminalError,
          uploadController: this.terminalPanelUploadController,
        })}
      </section>
    `;
  }

  override willUpdate(): void {
    prepareTerminalSessionHostVisibility(
      this.terminalSessions.tabs,
      this.terminalSessions.activeId,
    );
  }

  static override styles = [
    panelTabStripStyles,
    dockPanelStyles,
    terminalPanelStyles,
    terminalPanelUploadStyles,
    scrollbarShadowStyles,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-terminal-panel": OpenClawTerminalPanel;
  }
}
