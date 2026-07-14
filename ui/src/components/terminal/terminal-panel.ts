import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
// Dockable operator terminal panel for the Control UI shell.
//
// Renders a VS Code-style shell dock (bottom by default, or right) with session
// tabs. Each tab hosts one libterminal Ghostty controller wired to a gateway PTY
// session. The browser runtime is dynamically imported on first open so it
// never weighs down the initial Control UI bundle.
import { css, html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import { createDockPanelLayout, type DockPanelSide } from "../dock-panel-layout.ts";
import {
  isTerminalPanelShortcut,
  TERMINAL_PANEL_TOGGLE_EVENT,
  type TerminalPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import { TerminalConnection, type TerminalGatewayClient } from "./terminal-connection.ts";
import { renderTerminalPanelTabs, type TerminalPanelTab } from "./terminal-panel-tabs.ts";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";
import { terminalTheme } from "./terminal-theme.ts";

// Inline icon set (self-contained; the Control UI blocks external asset loads).
const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const DOCK_BOTTOM_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 10h12" /></svg>`;
const DOCK_RIGHT_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>`;

type TerminalDock = DockPanelSide;
type TerminalTabState = TerminalPanelTab & {
  gatewaySessionId: string;
  controller: GhosttyTerminalController;
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
// Session ids for reattach after a reload/reconnect. Deliberately
// sessionStorage, not localStorage: attach is take-over, and a shared
// per-origin key would make multiple Control UI windows clobber each other's
// ids and steal each other's live shells. Per-tab storage survives exactly the
// cases reattach is for (reload, laptop sleep, transient disconnect).
const SESSIONS_KEY = "openclaw.terminal.sessions.v1";
const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Symbols Nerd Font Mono", "MesloLGLDZ Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "Liberation Mono", monospace';
const TERMINAL_INPUT_DECODER = new TextDecoder();
const TERMINAL_OUTPUT_ENCODER = new TextEncoder();

function loadPersistedSessionIds(): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(SESSIONS_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
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

  private connection: TerminalConnection | null = null;
  private activeClient: TerminalGatewayClient | null = null;
  private activeAvailable = false;
  private lifecycleGeneration = 0;
  private lifecycleAbortController = new AbortController();
  private lifecycleSyncToken = 0;
  private resizeCleanup: (() => void) | null = null;
  private tabSeq = 0;
  protected createTerminal = createIsolatedGhosttyTerminal;
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
          term.renderer.render(term.wasmTerm, true, term.viewportY, term);
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
        this.tabs.find((tab) => tab.id === this.activeId)?.controller.fit();
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
    if (detail?.open === true) {
      if (!this.available) {
        return;
      }
      this.open = true;
      this.syncLayoutReservation();
      this.persistLayout();
      void this.restoreSessions();
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
    const operation = this.captureTerminalOperation();
    if (!operation || this.booting || this.tabs.length > 0) {
      return;
    }
    const persisted = loadPersistedSessionIds();
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
    await this.ensureInitialSession();
  }

  private async ensureInitialSession(): Promise<void> {
    if (this.tabs.length === 0 && !this.booting) {
      await this.openSession();
    }
  }

  /** Boots a tab with a libterminal controller, ready for an open or attach RPC. */
  private async bootTab(operation: TerminalOperation): Promise<{
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
        // Ignore startup callbacks until the Gateway session is adopted.
        onData: (bytes) => {
          const sessionId = tabRef.current?.gatewaySessionId;
          if (sessionId) {
            void connection.input(sessionId, TERMINAL_INPUT_DECODER.decode(bytes));
          }
        },
        onResize: ({ columns, rows }) => {
          const sessionId = tabRef.current?.gatewaySessionId;
          if (sessionId) {
            void connection.resize(sessionId, columns, rows);
          }
        },
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
      shellName: null,
      agentId: null,
      cwd: null,
      controller,
      host,
      status: "live",
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
          tab.controller.write(TERMINAL_OUTPUT_ENCODER.encode(data));
        }
      },
      onExit: (info: { reason?: string; exitCode: number | null }) => this.handleExit(tab.id, info),
    };
  }

  /** Binds a freshly opened or attached gateway session to its tab. */
  private adoptSession(
    tab: TerminalTabState,
    result: { sessionId: string; shell: string; agentId: string; cwd: string },
  ): void {
    tab.gatewaySessionId = result.sessionId;
    tab.shellName = shellBasename(result.shell);
    tab.agentId = result.agentId;
    tab.cwd = result.cwd;
    // Libterminal observes layout before the Gateway session exists. Resync the
    // current grid now so a resize during the open/attach RPC is not lost.
    const { cols, rows } = tab.controller.terminal;
    void this.connection?.resize(result.sessionId, cols || 80, rows || 24);

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

  private async openSession(): Promise<void> {
    const operation = this.captureTerminalOperation();
    if (!operation || this.booting) {
      return;
    }
    this.booting = true;
    this.errorText = null;
    // Freeze the selection for this tab; later agent changes affect only new tabs.
    const agentId = this.agentId?.trim() || undefined;
    // Tracked outside the try so the catch can dispose a tab whose open failed.
    let createdTab: TerminalTabState | undefined;
    try {
      const boot = await this.bootTab(operation);
      createdTab = boot.tab;
      const result = await boot.connection.open(
        { agentId, cols: boot.cols, rows: boot.rows },
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
      this.errorText = err instanceof Error ? err.message : String(err);
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

  private handleExit(tabId: string, info: { reason?: string; exitCode: number | null }): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }
    tab.status = "exited";
    tab.exitReason = info.reason;
    tab.exitCode = info.exitCode;
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
    if (tab.gatewaySessionId && tab.status === "live") {
      void this.connection?.close(tab.gatewaySessionId);
    } else if (!tab.gatewaySessionId && tab.status === "live") {
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
    // Refit after the container becomes visible so cols/rows match the viewport.
    void this.updateComplete.then(() => {
      tab?.controller.fit();
      tab?.controller.terminal.focus();
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
    this.booting = false;
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
    try {
      globalThis.sessionStorage?.setItem(SESSIONS_KEY, JSON.stringify(ids));
    } catch {
      // Storage may be unavailable (private mode); reattach just won't work.
    }
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
        ? `height:${this.height}px`
        : `width:${this.width}px`;
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
          ${this.fullscreen
            ? nothing
            : html`<div class="tp-actions">
                <button
                  class="tp-icon ${this.dock === "bottom" ? "is-active" : ""}"
                  type="button"
                  title=${t("terminal.dockBottom")}
                  aria-label=${t("terminal.dockBottom")}
                  @click=${() => this.setDock("bottom")}
                >
                  ${DOCK_BOTTOM_GLYPH}
                </button>
                <button
                  class="tp-icon ${this.dock === "right" ? "is-active" : ""}"
                  type="button"
                  title=${t("terminal.dockRight")}
                  aria-label=${t("terminal.dockRight")}
                  @click=${() => this.setDock("right")}
                >
                  ${DOCK_RIGHT_GLYPH}
                </button>
                <button
                  class="tp-icon"
                  type="button"
                  title=${t("terminal.hide")}
                  aria-label=${t("terminal.hide")}
                  @click=${() => this.closePanel()}
                >
                  ${CLOSE_GLYPH}
                </button>
              </div>`}
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
        >
          ${this.booting && this.tabs.length === 0
            ? html`<div class="tp-empty">${t("terminal.starting")}</div>`
            : nothing}
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

  static override styles = css`
    :host {
      position: fixed;
      z-index: 60;
      color: var(--text, #d7dae0);
      font-family: var(--font-sans, system-ui, sans-serif);
    }
    .tp {
      position: fixed;
      display: flex;
      flex-direction: column;
      background: var(--bg, #0e1015);
      overflow: hidden;
    }
    /* A docked panel needs only a single hairline separator on its inner edge —
       no shadow, so it reads as part of the layout rather than a floating card. */
    .tp--bottom {
      left: var(--shell-nav-width, 0);
      right: 0;
      bottom: 0;
      border-top: 1px solid var(--border, #262b34);
    }
    .tp--right {
      top: var(--shell-topbar-height, 0);
      right: 0;
      bottom: 0;
      border-left: 1px solid var(--border, #262b34);
    }
    /* Terminal-only document (mobile WebViews): fill the viewport, no seams. */
    .tp--fullscreen {
      inset: 0;
    }
    .tp-resizer {
      position: absolute;
      z-index: 2;
      background: transparent;
    }
    .tp-resizer:hover {
      background: var(--accent, #ff5c5c);
      opacity: 0.5;
    }
    .tp-resizer--bottom {
      top: 0;
      left: 0;
      right: 0;
      height: 5px;
      cursor: ns-resize;
    }
    .tp-resizer--right {
      top: 0;
      bottom: 0;
      left: 0;
      width: 5px;
      cursor: ew-resize;
    }
    .tp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 6px 0 4px;
      border-bottom: 1px solid var(--border, #262b34);
      background: var(--bg, #0e1015);
      min-height: 36px;
    }
    .tp-tabs {
      --track-width: 0;
      display: block;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .tp-tabs::part(nav) {
      display: flex;
      align-items: stretch;
      gap: 1px;
    }
    .tp-tabs::part(body) {
      display: none;
    }
    .tp-tabs::-webkit-scrollbar {
      display: none;
    }
    .tp-tab::part(base) {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 10px;
      height: 36px;
      color: var(--muted, #8a919e);
      white-space: nowrap;
      font-size: 12.5px;
      /* Reserve the active underline height so tabs don't shift on selection. */
      border-bottom: 2px solid transparent;
      transition:
        color 0.12s ease,
        background 0.12s ease;
    }
    .tp-tab:hover::part(base) {
      color: var(--text, #d7dae0);
      background: color-mix(in srgb, var(--text, #d7dae0) 6%, transparent);
    }
    .tp-tab[active]::part(base) {
      color: var(--text, #d7dae0);
      border-bottom-color: var(--accent, #ff5c5c);
    }
    .tp-tab.is-exited::part(base) {
      opacity: 0.55;
    }
    .tp-tab__icon {
      display: inline-flex;
      color: var(--accent, #4ec9a8);
    }
    .tp-tab.is-exited .tp-tab__icon {
      color: var(--muted, #8a919e);
    }
    .tp-tab__label {
      font-variant-numeric: tabular-nums;
    }
    .tp-tab__status {
      font-size: 11px;
      color: var(--muted, #8a919e);
    }
    .tp-tab__close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      opacity: 0;
      border: none;
      background: transparent;
      color: inherit;
      border-radius: 4px;
      padding: 0;
    }
    .tp-tab:hover + .tp-tab__close,
    .tp-tab[active] + .tp-tab__close,
    .tp-tab__close:hover,
    .tp-tab__close:focus-visible {
      opacity: 0.7;
    }
    .tp-new,
    .tp-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: none;
      background: transparent;
      color: var(--muted, #8a919e);
      border-radius: 6px;
      padding: 0;
    }
    .tp-new {
      align-self: center;
    }
    .tp-tab__close:hover,
    .tp-new:hover,
    .tp-icon:hover {
      background: color-mix(in srgb, var(--text, #d7dae0) 12%, transparent);
      color: var(--text, #d7dae0);
    }
    .tp-icon.is-active {
      color: var(--text, #d7dae0);
      background: color-mix(in srgb, var(--text, #d7dae0) 10%, transparent);
    }
    .tp-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      padding-left: 6px;
    }
    .tp-viewport {
      position: relative;
      flex: 1;
      min-height: 0;
      background: var(--bg, #0e1015);
    }
    .tp-host {
      position: absolute;
      inset: 0;
      padding: 6px 8px;
      /* ghostty-web focuses this contenteditable host while drawing its own
         cursor on canvas; hide the otherwise duplicated browser caret. */
      caret-color: transparent;
    }
    .tp-empty,
    .tp-error {
      padding: 10px 12px;
      font-size: 12px;
      color: var(--muted, #8a919e);
    }
    .tp-error {
      color: var(--danger, #ff6b6b);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-terminal-panel": OpenClawTerminalPanel;
  }
}
