import type {
  createTerminalDefaultColorQueryResponder,
  GhosttyTerminalController,
} from "@openclaw/libterminal/browser";
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
import {
  TerminalConnection,
  type TerminalGatewayClient,
  TerminalOpenTimeoutError,
  type TerminalSessionInfo,
} from "./terminal-connection.ts";
import { terminalPanelStyles } from "./terminal-panel-styles.ts";
import { renderTerminalPanelTabs, type TerminalPanelTab } from "./terminal-panel-tabs.ts";
import { terminalPanelUploadStyles } from "./terminal-panel-upload-styles.ts";
import {
  renderTerminalPanelActions,
  renderTerminalUploadLayer,
  TerminalPanelUploadController,
} from "./terminal-panel-upload.ts";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";
import { renderTerminalSessionPicker } from "./terminal-session-picker.ts";
import {
  loadPersistedTerminalSessionIds,
  persistTerminalSessionIds,
} from "./terminal-session-storage.ts";
import { createTerminalStartupInput, type StartupInputBuffer } from "./terminal-startup-input.ts";
import {
  TerminalTabReadinessController,
  type TerminalTabReadinessState,
} from "./terminal-tab-readiness.ts";
import { TerminalTaskQueue } from "./terminal-task-queue.ts";
import { terminalDynamicColors, terminalTheme } from "./terminal-theme.ts";

type TerminalDock = DockPanelSide;
type TerminalTabState = TerminalPanelTab &
  TerminalTabReadinessState & {
    gatewaySessionId: string;
    pendingInput: StartupInputBuffer;
    defaultColorQueries: ReturnType<typeof createTerminalDefaultColorQueryResponder>;
    controller: GhosttyTerminalController;
    shell: string;
    host: HTMLDivElement;
    /** Why an in-flight open/attach must not adopt this disposed terminal. */
    cancelled?: "close" | "lifecycle";
  };

type TerminalOperation = {
  generation: number;
  client: TerminalGatewayClient;
  signal: AbortSignal;
};

/** Reduces a shell path to a tab label, e.g. "/bin/zsh" -> "zsh". */
function shellBasename(shell: string): string {
  const base = shell.split(/[\\/]/).pop()?.trim();
  return base && base.length > 0 ? base : "shell";
}

const panelLayout = createDockPanelLayout({
  storageKey: "openclaw.terminal.panel.v1",
  minHeight: 140,
  minWidth: 320,
  defaultDock: "bottom",
  defaultHeight: 320,
  defaultWidth: 520,
});
const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Symbols Nerd Font Mono", "MesloLGLDZ Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "Liberation Mono", monospace';
const TERMINAL_OUTPUT_ENCODER = new TextEncoder();
const CATALOG_TERMINAL_READY_TIMEOUT_MS = 30_000;

function forceTerminalRender(controller: GhosttyTerminalController): void {
  const term = controller.terminal;
  if (term.renderer && term.wasmTerm) {
    // An omitted opacity defaults to 1; repaint without inventing a visible scrollbar.
    term.renderer.render(term.wasmTerm, true, term.viewportY, term, 0);
  }
}

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
  @state() private tabs: TerminalTabState[] = [];
  @state() private activeId: string | null = null;
  @state() private booting = false;
  @state() private errorText: string | null = null;
  @state() private sessionPickerOpen = false;
  @state() private sessionPickerLoading = false;
  @state() private pickerSessions: TerminalSessionInfo[] = [];

  private connection: TerminalConnection | null = null;
  private activeClient: TerminalGatewayClient | null = null;
  private activeAvailable = false;
  private lifecycleGeneration = 0;
  private sessionPickerRefreshGeneration = 0;
  private lifecycleAbortController = new AbortController();
  private lifecycleSyncToken = 0;
  private resizeCleanup: (() => void) | null = null;
  private tabSeq = 0;
  private readonly upload = new TerminalPanelUploadController({
    activeTab: () =>
      this.tabs.find(
        (tab) => tab.id === this.activeId && tab.status === "live" && tab.gatewaySessionId,
      ),
    client: () => this.client,
    isCurrent: (tab) => this.tabs.includes(tab as TerminalTabState) && tab.status === "live",
    fileInput: () => this.renderRoot.querySelector<HTMLInputElement>(".tp-file-input"),
    setError: (message) => (this.errorText = message),
    requestUpdate: () => this.requestUpdate(),
  });
  private readonly bootQueue = new TerminalTaskQueue();
  protected createTerminal = createIsolatedGhosttyTerminal;
  protected catalogReadyTimeoutMs = CATALOG_TERMINAL_READY_TIMEOUT_MS;
  private readonly readiness = new TerminalTabReadinessController<TerminalTabState>({
    timeoutMs: () => this.catalogReadyTimeoutMs,
    isCurrent: (tab) => this.tabs.includes(tab),
    onReady: () => {
      this.tabs = [...this.tabs];
      this.persistLiveSessions();
    },
    onTimeout: (tab) => {
      this.errorText = t("terminal.connectionTimedOut");
      void this.connection?.close(tab.gatewaySessionId);
      this.dropFailedTab(tab);
      this.persistLiveSessions();
    },
  });
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
    this.tabs.find((tab) => tab.id === this.activeId)?.controller.fit();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.activeClient = this.client;
    this.activeAvailable = this.available;
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
      void this.restoreSessions();
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
    this.disposeAllTabs();
    this.activeClient = null;
    this.activeAvailable = false;
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("client") || changed.has("available")) {
      this.scheduleLifecycleSync();
    }
    if (changed.has("themeMode")) {
      const theme = terminalTheme(this.themeMode);
      for (const tab of this.tabs) {
        // ghostty-web 0.4.0 ignores options.theme after open() (its option
        // handler only warns), so update the renderer directly and force one
        // full render — the frame loop repaints only dirty rows, which would
        // leave a static screen on the old palette.
        const term = tab.controller.terminal;
        if (term.renderer && term.wasmTerm) {
          term.renderer.setTheme(theme);
          forceTerminalRender(tab.controller);
        }
      }
    }
    // Hiding the panel returns `nothing`, which detaches each session's ghostty
    // host. Re-attach live hosts whenever the viewport is rendered so a
    // hide/show cycle keeps the terminals intact instead of blanking them.
    if (this.open) {
      const viewport = this.renderRoot.querySelector(".tp-viewport");
      if (viewport) {
        for (const tab of this.tabs) {
          if (tab.host.parentElement !== viewport) {
            viewport.append(tab.host);
          }
        }
        const activeTab = this.tabs.find((tab) => tab.id === this.activeId);
        if (activeTab) {
          activeTab.controller.fit();
          // FitAddon skips unchanged dimensions; force dirty-row rendering to
          // repair a canvas that was detached while the panel was hidden.
          forceTerminalRender(activeTab.controller);
        }
      }
    }
    this.syncLayoutReservation();
  }

  private scheduleLifecycleSync(): void {
    const token = ++this.lifecycleSyncToken;
    const generation = this.lifecycleGeneration;
    // State teardown inside Lit's updated hook schedules a nested update.
    // Defer it; token + generation reject superseded connection epochs.
    queueMicrotask(() => {
      if (
        token !== this.lifecycleSyncToken ||
        generation !== this.lifecycleGeneration ||
        !this.isConnected
      ) {
        return;
      }
      this.synchronizeLifecycle();
    });
  }

  private synchronizeLifecycle(): void {
    const clientChanged = this.client !== this.activeClient;
    const availabilityChanged = this.available !== this.activeAvailable;
    if (!clientChanged && !availabilityChanged) {
      return;
    }
    if (clientChanged) {
      this.activeClient = this.client;
    }
    this.activeAvailable = this.available;
    const becameUnavailable = availabilityChanged && !this.available;
    if (clientChanged || becameUnavailable) {
      this.disposeAllTabs();
    }
    let shouldRestore = clientChanged && this.available && this.open;
    if (availabilityChanged) {
      if (!this.available) {
        // The surface disappeared (gateway disconnect/disable). Tear down local
        // tabs and the connection (disposeAllTabs drops the gateway
        // subscription too). Server sessions survive a disconnect for the
        // detach grace period, and their ids stay persisted, so the restore on
        // reconnect reattaches them instead of opening fresh shells. Hide the
        // panel WITHOUT persisting: a disconnect must not overwrite the user's
        // open preference, or the reconnect path would never auto-reopen.
        this.open = false;
      } else if (!this.open && (this.fullscreen || panelLayout.load().open)) {
        // Hello arrived after mount (or a reconnect); restore the persisted
        // open state (fullscreen documents are always open while available)
        // and reattach persisted sessions where possible.
        this.open = true;
        shouldRestore = true;
      }
    }
    if (shouldRestore) {
      void this.restoreSessions();
    }
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
      this.closePanel();
    } else {
      this.open = true;
      this.syncLayoutReservation();
      this.persistLayout();
      void this.restoreSessions();
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
      this.closePanel();
      return;
    }
    if (detail?.catalog || detail?.open === true) {
      if (!this.available) {
        return;
      }
      this.open = true;
      this.syncLayoutReservation();
      this.persistLayout();
      void (detail.catalog ? this.openCatalogSession(detail.catalog) : this.restoreSessions());
      return;
    }
    this.toggle();
  }

  private closePanel(): void {
    this.open = false;
    this.syncLayoutReservation();
    this.persistLayout();
  }

  private handleGlobalKey(event: KeyboardEvent): void {
    // Ctrl+` toggles the terminal, matching common IDE shells.
    if (isTerminalPanelShortcut(event)) {
      event.preventDefault();
      this.toggle();
    }
  }

  /**
   * Entry point whenever the panel (re)opens: reattach persisted sessions if
   * the gateway still has them, otherwise fall back to one fresh session.
   */
  private async restoreSessions(): Promise<void> {
    await this.bootQueue.enqueueSteps(
      () => this.reattachPersistedSessions(),
      () => this.ensureInitialSession(),
    );
  }

  private async openCatalogSession(catalog: NonNullable<TerminalPanelToggleDetail["catalog"]>) {
    await this.bootQueue.enqueueSteps(
      () => this.reattachPersistedSessions(),
      () => this.openSessionNow(catalog),
    );
  }

  private async reattachPersistedSessions(): Promise<void> {
    const operation = this.captureTerminalOperation();
    if (!operation || this.tabs.length > 0) {
      return;
    }
    const persisted = loadPersistedTerminalSessionIds();
    if (persisted.length > 0) {
      this.booting = true;
      try {
        const connection = this.connectionFor(operation);
        const listed = await connection.list();
        if (!this.isTerminalOperationCurrent(operation)) {
          return;
        }
        const known = new Set(listed.map((session) => session.sessionId));
        for (const sessionId of persisted.filter((id) => known.has(id))) {
          await this.attachSession(sessionId, operation);
          if (!this.isTerminalOperationCurrent(operation)) {
            return;
          }
        }
      } catch {
        if (!this.isTerminalOperationCurrent(operation)) {
          return;
        }
        // terminal.list failed (older gateway, surface flapping): fall through
        // to a fresh session below.
      } finally {
        if (this.isTerminalOperationCurrent(operation)) {
          this.booting = false;
        }
      }
      if (!this.isTerminalOperationCurrent(operation)) {
        return;
      }
      // Prune ids the gateway no longer knows (reaped or externally closed).
      this.persistLiveSessions();
    }
  }

  private async ensureInitialSession(): Promise<void> {
    if (this.tabs.length === 0 && !this.booting) {
      await this.openSessionNow();
    }
  }

  private toggleSessionPicker(): void {
    this.sessionPickerOpen = !this.sessionPickerOpen;
    if (this.sessionPickerOpen) {
      void this.refreshSessionPicker();
    }
  }

  private async refreshSessionPicker(): Promise<void> {
    const operation = this.captureTerminalOperation();
    if (!operation) {
      return;
    }
    const refreshGeneration = ++this.sessionPickerRefreshGeneration;
    const isCurrentRefresh = () =>
      refreshGeneration === this.sessionPickerRefreshGeneration &&
      this.isTerminalOperationCurrent(operation);
    this.sessionPickerLoading = true;
    try {
      const sessions = await this.connectionFor(operation).list();
      if (isCurrentRefresh()) {
        this.pickerSessions = sessions;
      }
    } catch {
      if (isCurrentRefresh()) {
        this.pickerSessions = [];
      }
    } finally {
      if (isCurrentRefresh()) {
        this.sessionPickerLoading = false;
      }
    }
  }

  private async attachPickedSession(sessionId: string): Promise<void> {
    this.sessionPickerOpen = false;
    await this.bootQueue.enqueue(async () => {
      const existing = this.tabs.find((tab) => tab.gatewaySessionId === sessionId);
      if (existing) {
        this.switchTo(existing.id);
        return;
      }
      const operation = this.captureTerminalOperation();
      if (!operation) {
        return;
      }
      this.booting = true;
      this.errorText = null;
      try {
        const attached = await this.attachSession(sessionId, operation);
        if (!attached && this.isTerminalOperationCurrent(operation)) {
          this.errorText = t("terminal.attachFailed");
        }
      } finally {
        if (this.isTerminalOperationCurrent(operation)) {
          this.booting = false;
        }
      }
    });
  }

  /** Boots a tab with a libterminal controller, ready for an open or attach RPC. */
  private async bootTab(
    operation: TerminalOperation,
    options: { awaitFirstOutput?: boolean } = {},
  ): Promise<{
    tab: TerminalTabState;
    connection: TerminalConnection;
    cols: number;
    rows: number;
  }> {
    const connection = this.connectionFor(operation);
    // Preserve the connection so cancelled-open cleanup still closes the in-flight session.
    const host = document.createElement("div");
    host.className = "tp-host";
    const id = `tab-${++this.tabSeq}`;
    // Wait for the panel (and its .tp-viewport) to render before attaching the
    // ghostty host, so the terminal opens into a laid-out, measurable node.
    await this.updateComplete;
    if (!this.isTerminalOperationCurrent(operation)) {
      throw new Error("terminal operation cancelled");
    }
    const viewport = this.renderRoot.querySelector(".tp-viewport");
    if (!viewport) {
      throw new Error("terminal viewport unavailable");
    }
    viewport.append(host);
    const tabRef = { current: undefined as TerminalTabState | undefined };
    const startupInput = createTerminalStartupInput(
      connection,
      () => tabRef.current?.gatewaySessionId,
    );
    const { createTerminalDefaultColorQueryResponder } =
      await import("@openclaw/libterminal/browser");
    const defaultColorQueries = createTerminalDefaultColorQueryResponder({
      getColors: () => terminalDynamicColors(this.themeMode),
      reply: (data) => startupInput.onData(TERMINAL_OUTPUT_ENCODER.encode(data)),
    });
    let controller: GhosttyTerminalController;
    try {
      controller = await this.createTerminal({
        parent: host,
        readOnly: false,
        terminalOptions: {
          fontSize: 13,
          fontFamily: TERMINAL_FONT_FAMILY,
          cursorBlink: true,
          theme: terminalTheme(this.themeMode),
          scrollback: 5000,
        },
        signal: operation.signal,
        // The browser controller owns these subscriptions and their teardown.
        onData: startupInput.onData,
        onResize: startupInput.onResize,
      });
    } catch (error) {
      host.remove();
      throw error;
    }
    if (!this.isTerminalOperationCurrent(operation)) {
      try {
        controller.dispose();
      } finally {
        host.remove();
      }
      throw new Error("terminal operation cancelled");
    }
    const tab: TerminalTabState = {
      id,
      sequence: this.tabSeq,
      gatewaySessionId: "",
      pendingInput: startupInput.buffer,
      defaultColorQueries,
      shellName: null,
      shell: "",
      agentId: null,
      cwd: null,
      controller,
      host,
      status: "connecting",
      awaitFirstOutput: options.awaitFirstOutput === true,
      readyTimer: null,
    };
    tabRef.current = tab;
    this.tabs = [...this.tabs, tab];
    this.activeId = id;
    const { terminal } = controller;
    return { tab, connection, cols: terminal.cols || 80, rows: terminal.rows || 24 };
  }

  /** Output/exit sink for one tab, shared by open and attach. */
  private tabSink(tab: TerminalTabState) {
    return {
      // The cancelled guard also protects the buffered-event replay inside
      // connection.open/attach from writing to an already-disposed terminal.
      onData: (data: string) => {
        if (!tab.cancelled) {
          tab.defaultColorQueries.observe(data);
          tab.controller.write(TERMINAL_OUTPUT_ENCODER.encode(data));
          if (data.length > 0) {
            this.readiness.markReady(tab);
          }
        }
      },
      // A replay is authoritative. Reset parser, screen, and scrollback so a
      // gap cannot leave stale cells or a partial escape sequence behind.
      onReplay: (data: string, newlyObservedFrom: number) => {
        if (!tab.cancelled) {
          // Suppress complete historical queries, then answer only the suffix
          // recovered after a sequence gap. A split query may cross the seam.
          tab.defaultColorQueries.primeFromReplay(data.slice(0, newlyObservedFrom));
          tab.defaultColorQueries.observe(data.slice(newlyObservedFrom));
          tab.controller.terminal.reset();
          if (data) {
            tab.controller.write(TERMINAL_OUTPUT_ENCODER.encode(data));
            this.readiness.markReady(tab);
          }
        }
      },
      onExit: (info: { reason?: string; exitCode: number | null; error?: string }) =>
        this.handleExit(tab.id, info),
    };
  }

  /** Binds a freshly opened or attached gateway session to its tab. */
  private adoptSession(
    tab: TerminalTabState,
    result: { sessionId: string; shell: string; agentId: string; cwd: string; title?: string },
  ): void {
    tab.gatewaySessionId = result.sessionId;
    tab.shellName = result.title ?? shellBasename(result.shell);
    tab.shell = result.shell;
    tab.agentId = result.agentId;
    tab.cwd = result.cwd;
    // Libterminal observes layout before the Gateway session exists. Resync the
    // current grid now so a resize during the open/attach RPC is not lost.
    const { cols, rows } = tab.controller.terminal;
    void this.connection?.resize(result.sessionId, cols || 80, rows || 24);
    for (const data of tab.pendingInput.drain()) {
      void this.connection?.input(result.sessionId, data);
    }

    if (tab.status === "connecting") {
      if (tab.awaitFirstOutput) {
        this.readiness.arm(tab);
      } else {
        this.readiness.markReady(tab);
      }
    }

    this.tabs = [...this.tabs];
    this.persistLiveSessions();
  }

  /** Removes a tab whose open/attach never produced a server session. */
  private dropFailedTab(tab: TerminalTabState): void {
    this.disposeTab(tab);
    this.tabs = this.tabs.filter((entry) => entry.id !== tab.id);
    if (this.activeId === tab.id) {
      this.activeId = this.tabs.at(-1)?.id ?? null;
    }
  }

  private async openSession(catalog?: TerminalPanelToggleDetail["catalog"]): Promise<void> {
    await this.bootQueue.enqueue(() => this.openSessionNow(catalog));
  }

  private async openSessionNow(catalog?: TerminalPanelToggleDetail["catalog"]): Promise<void> {
    const operation = this.captureTerminalOperation();
    if (!operation) {
      return;
    }
    this.booting = true;
    this.errorText = null;
    // Freeze the selection for this tab; later agent changes affect only new tabs.
    const agentId = this.agentId?.trim() || undefined;
    // Tracked outside the try so the catch can dispose a tab whose open failed.
    let createdTab: TerminalTabState | undefined;
    try {
      const boot = await this.bootTab(operation, { awaitFirstOutput: Boolean(catalog) });
      createdTab = boot.tab;
      const result = await boot.connection.open(
        { agentId, cols: boot.cols, rows: boot.rows, ...(catalog ? { catalog } : {}) },
        this.tabSink(boot.tab),
      );
      if (!this.isTerminalOperationCurrent(operation) || boot.tab.cancelled) {
        // The tab's close button was clicked while the open RPC was in flight.
        // The server session is live and its sink registered; close it now or
        // it survives invisibly (eating the session cap) until disconnect.
        void boot.connection.close(result.sessionId);
        if (this.tabs.includes(boot.tab)) {
          boot.tab.cancelled = "lifecycle";
          this.dropFailedTab(boot.tab);
        }
        return;
      }
      this.adoptSession(boot.tab, result);
      boot.tab.controller.terminal.focus();
    } catch (err) {
      // A failed open (e.g. terminal disabled or a sandboxed agent is refused)
      // must not leave a phantom "live" tab with no server session. Drop it but
      // keep the panel open so the error stays visible.
      if (createdTab && !createdTab.gatewaySessionId && this.tabs.includes(createdTab)) {
        this.dropFailedTab(createdTab);
      }
      if (!this.isTerminalOperationCurrent(operation)) {
        return;
      }
      this.errorText =
        err instanceof TerminalOpenTimeoutError
          ? t("terminal.connectionTimedOut")
          : err instanceof Error
            ? err.message
            : String(err);
    } finally {
      if (this.isTerminalOperationCurrent(operation)) {
        this.booting = false;
      }
    }
  }

  /** Reattaches one persisted session; returns false when it is gone. */
  private async attachSession(sessionId: string, operation: TerminalOperation): Promise<boolean> {
    let createdTab: TerminalTabState | undefined;
    try {
      const boot = await this.bootTab(operation);
      createdTab = boot.tab;
      const result = await boot.connection.attach(sessionId, this.tabSink(boot.tab));
      if (!this.isTerminalOperationCurrent(operation) || boot.tab.cancelled) {
        // A user close is deliberate; lifecycle cancellation leaves the existing
        // server session available for the next reconnect to reattach.
        if (boot.tab.cancelled === "close") {
          void boot.connection.close(result.sessionId);
        }
        if (this.tabs.includes(boot.tab)) {
          boot.tab.cancelled = "lifecycle";
          this.dropFailedTab(boot.tab);
        }
        return false;
      }
      this.adoptSession(boot.tab, result);
      return true;
    } catch {
      // Session expired between list and attach (reaper race) or an older
      // gateway: quietly drop the placeholder tab; restore falls back to a
      // fresh session when nothing could be reattached.
      if (createdTab && !createdTab.gatewaySessionId && this.tabs.includes(createdTab)) {
        this.dropFailedTab(createdTab);
      }
      return false;
    }
  }

  private handleExit(
    tabId: string,
    info: { reason?: string; exitCode: number | null; error?: string },
  ): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }
    this.readiness.stop(tab);
    tab.status = "exited";
    tab.exitReason = info.reason;
    tab.exitCode = info.exitCode;
    if (info.error?.trim()) {
      this.errorText = info.error.trim();
    }
    // The connection drops its own sink on exit delivery, so no release() here —
    // the session id may not be recorded yet when an early exit is replayed.
    this.tabs = [...this.tabs];
    this.persistLiveSessions();
  }

  private closeTab(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }
    this.upload.cancelForTab(tab);
    if (tab.gatewaySessionId && tab.status !== "exited") {
      void this.connection?.close(tab.gatewaySessionId);
    } else if (!tab.gatewaySessionId && tab.status !== "exited") {
      // Open still in flight: no session id to close yet. Flag it so the open
      // continuation closes the server session as soon as the RPC resolves.
      tab.cancelled = "close";
    }
    this.disposeTab(tab);
    this.tabs = this.tabs.filter((entry) => entry.id !== tabId);
    if (this.activeId === tabId) {
      this.activeId = this.tabs.at(-1)?.id ?? null;
    }
    this.persistLiveSessions();
    // Fullscreen documents (mobile WebViews) have no toggle to reopen a closed
    // panel, so closing the last tab keeps the panel with an empty tab strip
    // (the "+" button stays reachable) instead of leaving a dead blank page.
    if (this.tabs.length === 0 && !this.fullscreen) {
      this.closePanel();
    }
  }

  private switchTo(tabId: string): void {
    this.activeId = tabId;
    const tab = this.tabs.find((entry) => entry.id === tabId);
    // Refit and repaint after the container becomes visible. A same-size tab
    // switch otherwise leaves the newly shown canvas without dirty rows.
    void this.updateComplete.then(() => {
      if (tab) {
        tab.controller.fit();
        forceTerminalRender(tab.controller);
        tab.controller.terminal.focus();
      }
    });
  }

  private captureTerminalOperation(): TerminalOperation | null {
    const client = this.client;
    if (!client || client !== this.activeClient || !this.available || !this.isConnected) {
      return null;
    }
    return {
      generation: this.lifecycleGeneration,
      client,
      signal: this.lifecycleAbortController.signal,
    };
  }

  private isTerminalOperationCurrent(operation: TerminalOperation): boolean {
    return (
      this.isConnected &&
      this.available &&
      this.client === operation.client &&
      this.activeClient === operation.client &&
      this.lifecycleGeneration === operation.generation &&
      !operation.signal.aborted
    );
  }

  private connectionFor(operation: TerminalOperation): TerminalConnection {
    if (!this.isTerminalOperationCurrent(operation)) {
      throw new Error("terminal operation cancelled");
    }
    this.connection ??= new TerminalConnection(operation.client);
    return this.connection;
  }

  private disposeTab(tab: TerminalTabState): void {
    this.readiness.stop(tab);
    try {
      tab.controller.dispose();
    } catch {
      // Best-effort teardown; a partially-initialized tab may throw.
    } finally {
      // DOM ownership is independent of controller cleanup; never strand a
      // Ghostty canvas when dependency disposal fails partway through.
      tab.host.remove();
    }
  }

  private disposeAllTabs(): void {
    this.lifecycleGeneration += 1;
    this.lifecycleAbortController.abort();
    this.lifecycleAbortController = new AbortController();
    this.bootQueue.reset();
    this.booting = false;
    this.upload.dispose();
    this.clearResizeListeners();
    for (const tab of this.tabs) {
      // No terminal.close here: this teardown runs for disconnects,
      // availability loss, and element removal — exactly the sessions the
      // persisted-id reattach flow recovers afterwards. Deliberate closes go
      // through closeTab(); sessions nobody reattaches are bounded by the
      // server's detach reaper.
      // The cancelled flag covers a tab whose open RPC is still in flight; its
      // continuation closes the fresh session instead of adopting the
      // disposed terminal.
      tab.cancelled = "lifecycle";
      this.disposeTab(tab);
    }
    this.tabs = [];
    this.activeId = null;
    this.sessionPickerOpen = false;
    this.sessionPickerLoading = false;
    this.sessionPickerRefreshGeneration += 1;
    this.pickerSessions = [];
    // Drop the gateway subscription with the tabs so the listener never outlives
    // the connection (disconnect/disable/element-removal all route through here).
    this.connection?.dispose();
    this.connection = null;
  }

  private setDock(dock: TerminalDock): void {
    this.dock = dock;
    this.syncLayoutReservation();
    this.persistLayout();
    void this.updateComplete.then(() => {
      for (const tab of this.tabs) {
        tab.controller.fit();
      }
    });
  }

  /**
   * Records which gateway sessions this window's live tabs own so a reload or
   * reconnect can reattach them. Intentionally NOT cleared on disconnect
   * teardown (disposeAllTabs) — surviving ids are the reattach memory.
   */
  private persistLiveSessions(): void {
    const ids = this.tabs
      .filter((tab) => tab.status === "live" && tab.gatewaySessionId)
      .map((tab) => tab.gatewaySessionId);
    persistTerminalSessionIds(ids);
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
    this.clearResizeListeners();
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
      const active = this.tabs.find((tab) => tab.id === this.activeId);
      active?.controller.fit();
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

  private clearResizeListeners(): void {
    this.resizeCleanup?.();
    this.resizeCleanup = null;
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
    const activeTab = this.tabs.find((tab) => tab.id === this.activeId);
    const connecting =
      (this.booting && this.tabs.length === 0) || activeTab?.status === "connecting";
    return html`
      <section class="tp tp--${mode}" style=${style} aria-label=${t("terminal.title")}>
        ${this.fullscreen
          ? nothing
          : html`<div
              class="tp-resizer tp-resizer--${this.dock}"
              @pointerdown=${(e: PointerEvent) => this.startResize(e)}
              role="separator"
              aria-label=${t("terminal.resize")}
            ></div>`}
        <header class="tp-header">
          ${renderTerminalPanelTabs({
            tabs: this.tabs,
            activeId: this.activeId,
            booting: this.booting,
            onSelect: (id) => this.switchTo(id),
            onClose: (id) => this.closeTab(id),
            onNew: () => void this.openSession(),
          })}
          ${renderTerminalPanelActions({
            fullscreen: this.fullscreen,
            dock: this.dock,
            upload: this.upload,
            sessionPicker: renderTerminalSessionPicker({
              open: this.sessionPickerOpen,
              loading: this.sessionPickerLoading,
              sessions: this.pickerSessions,
              currentSessionIds: new Set(
                this.tabs
                  .map((tab) => tab.gatewaySessionId)
                  .filter(
                    (sessionId): sessionId is string =>
                      typeof sessionId === "string" && sessionId.length > 0,
                  ),
              ),
              onToggle: () => this.toggleSessionPicker(),
              onRefresh: () => void this.refreshSessionPicker(),
              onAttach: (sessionId) => void this.attachPickedSession(sessionId),
            }),
            onDock: (dock) => this.setDock(dock),
            onHide: () => this.closePanel(),
          })}
        </header>
        ${this.errorText
          ? html`<div class="tp-error" role="alert">${this.errorText}</div>`
          : nothing}
        <wa-tab-panel
          id="terminal-tab-panel"
          class="tp-viewport"
          name=${this.activeId ?? "terminal"}
          active
          aria-labelledby=${this.activeId ? `terminal-tab-${this.activeId}` : nothing}
          @dragenter=${this.upload.handleDragEnter}
          @dragover=${this.upload.handleDragOver}
          @dragleave=${this.upload.handleDragLeave}
          @drop=${this.upload.handleDrop}
        >
          ${connecting
            ? html`<div class="tp-connecting" role="status">
                <span class="tp-connecting__spinner" aria-hidden="true"></span>
                <span>${t("terminal.connecting")}</span>
              </div>`
            : nothing}
          ${renderTerminalUploadLayer(this.upload)}
        </wa-tab-panel>
      </section>
    `;
  }

  override willUpdate(): void {
    // Keep only the active session's host visible; ghostty renders to a canvas
    // that must be laid out to measure correctly.
    for (const tab of this.tabs) {
      tab.host.style.display = tab.id === this.activeId ? "block" : "none";
    }
  }

  static override styles = [panelTabStripStyles, terminalPanelStyles, terminalPanelUploadStyles];
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-terminal-panel": OpenClawTerminalPanel;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
