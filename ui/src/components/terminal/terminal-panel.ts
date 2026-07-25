// Dockable operator terminal panel for the Control UI shell.
//
// Renders a VS Code-style shell dock (bottom by default, or right) with session
// tabs. Each tab hosts one libterminal Ghostty controller wired to a gateway PTY
// session. The browser runtime is dynamically imported on first open so it
// never weighs down the initial Control UI bundle.
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import { createDockPanelLayout, type DockPanelSide } from "../dock-panel-layout.ts";
import { panelTabStripStyles } from "../panel-tab-strip.ts";
import {
  isTerminalPanelShortcut,
  TERMINAL_PANEL_TOGGLE_EVENT,
  type TerminalPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import type { TerminalGatewayClient, TerminalSessionInfo } from "./terminal-connection.ts";
import {
  renderTerminalPanelHeader,
  renderTerminalPanelResizer,
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

type TerminalDock = Exclude<DockPanelSide, "left">;

const panelLayout = createDockPanelLayout({
  storageKey: "openclaw.terminal.panel.v1",
  minHeight: 140,
  minWidth: 320,
  defaultDock: "bottom",
  supportedDocks: ["bottom", "right"],
  defaultHeight: 320,
  defaultWidth: 520,
});
const CATALOG_TERMINAL_READY_TIMEOUT_MS = 30_000;

/** `<openclaw-terminal-panel>` — the dockable Control UI shell surface. */
export class OpenClawTerminalPanel extends OpenClawLitElement {
  /** Gateway client used for terminal.* RPCs; null until connected. */
  @property({ attribute: false }) client: TerminalGatewayClient | null = null;
  /** Agent whose workspace and sandbox policy own newly opened sessions. */
  @property({ attribute: false }) agentId: string | null = null;
  /** Whether the connected gateway advertises the terminal surface. */
  @property({ type: Boolean }) available = false;
  /** Active Control UI color mode, mirrored into the terminal theme. */
  @property({ attribute: false }) themeMode: "dark" | "light" = "dark";
  /**
   * Terminal-only document mode (`?view=terminal`), used by the mobile apps'
   * WebViews: fills the viewport, always open while available, no dock chrome.
   */
  @property({ type: Boolean }) fullscreen = false;

  @state() private open = false;
  @state() private dock: TerminalDock = "bottom";
  @state() private height = panelLayout.defaults.height;
  @state() private width = panelLayout.defaults.width;
  @state() terminalPanelErrorText: string | null = null;
  @state() private sessionPickerOpen = false;
  @state() private sessionPickerLoading = false;
  @state() private pickerSessions: TerminalSessionInfo[] = [];

  private sessionPickerRefreshGeneration = 0;
  private resizeCleanup: (() => void) | null = null;
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
  private readonly onGlobalKeyDown = (event: KeyboardEvent) => this.handleGlobalKey(event);
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);
  // Re-clamp a dock sized on a larger window so the header/resizer never end
  // up off-screen after the viewport shrinks (e.g. rotate, window resize).
  private readonly onViewportResize = () => {
    const height = Math.min(this.height, panelLayout.maxHeight());
    const width = Math.min(this.width, panelLayout.maxWidth());
    if (height === this.height && width === this.width) {
      return;
    }
    this.height = height;
    this.width = width;
    this.syncLayoutReservation();
    fitActiveTerminalSession(this.terminalSessions.tabs, this.terminalSessions.activeId);
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.terminalSessions.connectHost();
    if (!this.fullscreen) {
      const layout = panelLayout.load();
      this.dock = layout.dock;
      this.height = layout.height;
      this.width = layout.width;
      // Only restore the open state when the surface is actually available.
      this.open = layout.open && this.available;
      window.addEventListener("keydown", this.onGlobalKeyDown);
      window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.onToggleRequest);
      window.addEventListener("resize", this.onViewportResize);
    } else {
      // Fullscreen documents have no toggle/dock chrome; the panel is simply
      // open whenever the terminal surface is available.
      this.open = this.available;
    }
    if (this.open) {
      void this.terminalSessions.restoreSessions();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onGlobalKeyDown);
    window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.removeEventListener("resize", this.onViewportResize);
    // Release the content-area reservation so the shell reflows to full size.
    document.documentElement.style.setProperty("--oc-terminal-reserve-bottom", "0px");
    document.documentElement.style.setProperty("--oc-terminal-reserve-right", "0px");
    this.terminalSessions.disconnectHost();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("client") || changed.has("available")) {
      this.terminalSessions.scheduleLifecycleSync();
    }
    if (changed.has("themeMode")) {
      updateTerminalSessionTheme(this.terminalSessions.tabs, this.themeMode);
    }
    if (this.open) {
      reattachTerminalSessionHosts(
        this.terminalSessions.tabs,
        this.terminalSessions.activeId,
        this.findTerminalPanelViewport(),
      );
    }
    this.syncLayoutReservation();
  }

  /**
   * Publishes the dock's footprint as CSS variables on the document root so the
   * Control UI shell reserves space for it (via `.content` margins) instead of
   * letting the terminal overlay the chat. The panel itself stays fixed; the
   * content simply shrinks to make room, so this reads as a real dock.
   */
  private syncLayoutReservation(): void {
    if (this.fullscreen) {
      // No shell content to reserve space for in a terminal-only document.
      return;
    }
    const root = document.documentElement.style;
    const bottom =
      this.available && this.open && this.dock === "bottom" ? `${this.height}px` : "0px";
    const right = this.available && this.open && this.dock === "right" ? `${this.width}px` : "0px";
    root.setProperty("--oc-terminal-reserve-bottom", bottom);
    root.setProperty("--oc-terminal-reserve-right", right);
  }

  /** Opens the panel if closed, closes it if open. */
  toggle(): void {
    if (!this.available) {
      return;
    }
    if (this.open) {
      this.closeTerminalPanel();
    } else {
      this.open = true;
      this.syncLayoutReservation();
      this.persistLayout();
      void this.terminalSessions.restoreSessions();
    }
  }

  handleToggleRequest(event: Event): void {
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as TerminalPanelToggleDetail)
        : null;
    const dock = detail?.dock === "right" || detail?.dock === "bottom" ? detail.dock : null;
    if (dock) {
      this.dock = dock;
    }
    if (detail?.open === false) {
      this.closeTerminalPanel();
      return;
    }
    if (detail?.terminalSessionId || detail?.catalog || detail?.open === true) {
      if (!this.available) {
        return;
      }
      this.open = true;
      this.syncLayoutReservation();
      this.persistLayout();
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
    this.open = false;
    this.syncLayoutReservation();
    this.persistLayout();
  }

  get terminalPanelOpen(): boolean {
    return this.open;
  }

  hideTerminalPanelForUnavailableSurface(): void {
    // The surface disappeared (gateway disconnect/disable). Hide the panel
    // WITHOUT persisting: a disconnect must not overwrite the user's open
    // preference, or the reconnect path would never auto-reopen. Server
    // sessions survive for the detach grace period and reattach afterwards.
    this.open = false;
  }

  restoreTerminalPanelOpenState(): boolean {
    if (this.open || (!this.fullscreen && !panelLayout.load().open)) {
      return false;
    }
    // Hello arrived after mount (or a reconnect); fullscreen documents are
    // always open while available, while docked panels restore user state.
    this.open = true;
    return true;
  }

  private handleGlobalKey(event: KeyboardEvent): void {
    // Ctrl+` toggles the terminal, matching common IDE shells.
    if (isTerminalPanelShortcut(event)) {
      event.preventDefault();
      this.toggle();
    }
  }

  private toggleSessionPicker(): void {
    this.sessionPickerOpen = !this.sessionPickerOpen;
    if (this.sessionPickerOpen) {
      void this.refreshSessionPicker();
    }
  }

  private async refreshSessionPicker(): Promise<void> {
    const refreshGeneration = ++this.sessionPickerRefreshGeneration;
    this.sessionPickerLoading = true;
    const sessions = await this.terminalSessions.listSessions();
    if (refreshGeneration !== this.sessionPickerRefreshGeneration || sessions === null) {
      return;
    }
    this.pickerSessions = sessions;
    this.sessionPickerLoading = false;
  }

  private async attachPickedSession(
    sessionId: string,
    owner?: TerminalSessionInfo["owner"],
  ): Promise<void> {
    this.sessionPickerOpen = false;
    await this.terminalSessions.attachSessionById(sessionId, owner?.startsWith("agent:") === true);
  }

  private setDock(dock: TerminalDock): void {
    this.dock = dock;
    this.syncLayoutReservation();
    this.persistLayout();
    void this.updateComplete.then(() => fitAllTerminalSessions(this.terminalSessions.tabs));
  }

  private persistLayout(): void {
    panelLayout.save({
      open: this.open,
      dock: this.dock,
      height: this.height,
      width: this.width,
    });
  }

  private startResize(event: PointerEvent): void {
    event.preventDefault();
    this.clearTerminalPanelResizeListeners();
    const startX = event.clientX;
    const startY = event.clientY;
    const startHeight = this.height;
    const startWidth = this.width;
    const onMove = (move: PointerEvent) => {
      if (this.dock === "bottom") {
        const next = Math.max(panelLayout.minHeight, startHeight + (startY - move.clientY));
        this.height = Math.min(next, panelLayout.maxHeight());
      } else {
        const next = Math.max(panelLayout.minWidth, startWidth + (startX - move.clientX));
        this.width = Math.min(next, panelLayout.maxWidth());
      }
      // Reflow the content reservation live so the shell tracks the drag.
      this.syncLayoutReservation();
      fitActiveTerminalSession(this.terminalSessions.tabs, this.terminalSessions.activeId);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      if (this.resizeCleanup === cleanup) {
        this.resizeCleanup = null;
      }
    };
    const onUp = () => {
      cleanup();
      if (!this.isConnected) {
        return;
      }
      this.persistLayout();
    };
    this.resizeCleanup = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  }

  clearTerminalPanelResizeListeners(): void {
    this.resizeCleanup?.();
    this.resizeCleanup = null;
  }

  resetTerminalSessionPicker(): void {
    this.sessionPickerOpen = false;
    this.sessionPickerLoading = false;
    this.sessionPickerRefreshGeneration += 1;
    this.pickerSessions = [];
  }

  findTerminalPanelViewport(): Element | null {
    return this.renderRoot.querySelector(".tp-viewport");
  }

  override render() {
    if (!this.available || !this.open) {
      return nothing;
    }
    const mode = this.fullscreen ? "fullscreen" : this.dock;
    const style = this.fullscreen
      ? nothing
      : this.dock === "bottom"
        ? `height:${this.height}px;--tp-panel-height:${this.height}px`
        : `width:${this.width}px`;
    const activeTab = this.terminalSessions.tabs.find(
      (tab) => tab.id === this.terminalSessions.activeId,
    );
    const connecting =
      (this.terminalSessions.booting && this.terminalSessions.tabs.length === 0) ||
      activeTab?.status === "connecting";
    const sessionPicker = renderTerminalSessionPicker({
      open: this.sessionPickerOpen,
      loading: this.sessionPickerLoading,
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
      onRefresh: () => void this.refreshSessionPicker(),
      onAttach: (sessionId, owner) => void this.attachPickedSession(sessionId, owner),
    });
    const toolbar = renderTerminalPanelToolbar(
      this.fullscreen,
      this.dock,
      this.terminalPanelUploadController,
      sessionPicker,
      (dock) => this.setDock(dock),
      () => this.closeTerminalPanel(),
    );
    return html`
      <section class="tp tp--${mode}" style=${style} aria-label=${t("terminal.title")}>
        ${renderTerminalPanelResizer(this.fullscreen, this.dock, (event) =>
          this.startResize(event),
        )}
        ${renderTerminalPanelHeader(
          this.terminalSessions.tabs,
          this.terminalSessions.activeId,
          this.terminalSessions.booting,
          toolbar,
          (id) => this.terminalSessions.switchTo(id),
          (id) => this.terminalSessions.closeTab(id),
          () => void this.terminalSessions.openSession(),
        )}
        ${renderTerminalPanelViewport(
          this.terminalSessions.activeId,
          connecting,
          this.terminalPanelErrorText,
          this.terminalPanelUploadController,
        )}
      </section>
    `;
  }

  override willUpdate(): void {
    prepareTerminalSessionHostVisibility(
      this.terminalSessions.tabs,
      this.terminalSessions.activeId,
    );
  }

  static override styles = [panelTabStripStyles, terminalPanelStyles, terminalPanelUploadStyles];
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-terminal-panel": OpenClawTerminalPanel;
  }
}
