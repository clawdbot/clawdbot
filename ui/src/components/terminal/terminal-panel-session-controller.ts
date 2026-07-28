import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import type { ReactiveController } from "lit";
import { t } from "../../i18n/index.ts";
import {
  TerminalConnection,
  type TerminalGatewayClient,
  TerminalOpenTimeoutError,
  type TerminalSessionInfo,
} from "./terminal-connection.ts";
import {
  forceTerminalRender,
  persistLiveTerminalSessions,
  shellBasename,
  TERMINAL_FONT_FAMILY,
  TERMINAL_OUTPUT_ENCODER,
  type TerminalOperation,
  type TerminalPanelCatalogReference,
  type TerminalPanelSessionControllerHost,
  type TerminalPanelSessionControllerState,
  type TerminalPanelSessionTab,
} from "./terminal-panel-session-types.ts";
import { loadPersistedTerminalSessionIds } from "./terminal-session-storage.ts";
import { createTerminalStartupInput } from "./terminal-startup-input.ts";
import { TerminalTabReadinessController } from "./terminal-tab-readiness.ts";
import { TerminalTaskQueue } from "./terminal-task-queue.ts";
import { terminalDynamicColors, terminalTheme } from "./terminal-theme.ts";

/** Owns gateway PTY sessions and the Ghostty controllers bound to them. */
export class TerminalPanelSessionController
  implements ReactiveController, TerminalPanelSessionControllerState
{
  tabs: TerminalPanelSessionTab[] = [];
  activeId: string | null = null;
  booting = false;

  private connection: TerminalConnection | null = null;
  private activeClient: TerminalGatewayClient | null = null;
  private activeAvailable = false;
  private lifecycleGeneration = 0;
  private lifecycleAbortController = new AbortController();
  private lifecycleSyncToken = 0;
  private tabSequence = 0;
  private readonly bootQueue = new TerminalTaskQueue();
  private readonly readiness: TerminalTabReadinessController<TerminalPanelSessionTab>;

  constructor(private readonly host: TerminalPanelSessionControllerHost) {
    host.addController(this);
    this.readiness = new TerminalTabReadinessController<TerminalPanelSessionTab>({
      timeoutMs: () => this.host.catalogReadyTimeoutMs,
      isCurrent: (tab) => this.tabs.includes(tab),
      onReady: () => {
        this.updateControllerState("tabs", [...this.tabs]);
        persistLiveTerminalSessions(this.tabs);
      },
      onTimeout: (tab) => {
        this.host.terminalPanelErrorText = t("terminal.connectionTimedOut");
        void this.connection?.close(tab.gatewaySessionId);
        this.dropFailedTab(tab);
        persistLiveTerminalSessions(this.tabs);
      },
    });
  }

  hostConnected(): void {}

  private updateControllerState<Key extends keyof TerminalPanelSessionControllerState>(
    key: Key,
    value: TerminalPanelSessionControllerState[Key],
  ): void {
    Object.assign(this, { [key]: value });
    this.host.requestUpdate();
  }

  connectHost(): void {
    this.activeClient = this.host.client;
    this.activeAvailable = this.host.available;
  }

  disconnectHost(): void {
    this.disposeAllTabs();
    this.activeClient = null;
    this.activeAvailable = false;
  }

  scheduleLifecycleSync(): void {
    const token = ++this.lifecycleSyncToken;
    const generation = this.lifecycleGeneration;
    // State teardown inside Lit's updated hook schedules a nested update.
    // Defer it; token + generation reject superseded connection epochs.
    queueMicrotask(() => {
      if (
        token !== this.lifecycleSyncToken ||
        generation !== this.lifecycleGeneration ||
        !this.host.isConnected
      ) {
        return;
      }
      this.synchronizeLifecycle();
    });
  }

  private synchronizeLifecycle(): void {
    const clientChanged = this.host.client !== this.activeClient;
    const availabilityChanged = this.host.available !== this.activeAvailable;
    if (!clientChanged && !availabilityChanged) {
      return;
    }
    if (clientChanged) {
      this.activeClient = this.host.client;
    }
    this.activeAvailable = this.host.available;
    const becameUnavailable = availabilityChanged && !this.host.available;
    if (clientChanged || becameUnavailable) {
      this.disposeAllTabs();
    }
    let shouldRestore = clientChanged && this.host.available && this.host.terminalPanelOpen;
    if (availabilityChanged) {
      if (!this.host.available) {
        this.host.hideTerminalPanelForUnavailableSurface();
      } else if (this.host.restoreTerminalPanelOpenState()) {
        shouldRestore = true;
      }
    }
    if (shouldRestore) {
      void this.restoreSessions();
    }
  }

  async restoreSessions(): Promise<void> {
    await this.bootQueue.enqueueSteps(
      () => this.reattachPersistedSessions(),
      () => this.ensureInitialSession(),
    );
  }

  async openCatalogSession(catalog: TerminalPanelCatalogReference): Promise<void> {
    await this.bootQueue.enqueueSteps(
      () => this.reattachPersistedSessions(),
      () => this.openSessionNow(catalog),
    );
  }

  async openRequestedSession(sessionId: string): Promise<void> {
    await this.enqueueAttachSession(sessionId, true);
  }

  private async reattachPersistedSessions(): Promise<void> {
    const operation = this.captureTerminalOperation();
    if (!operation || this.tabs.length > 0) {
      return;
    }
    const persisted = loadPersistedTerminalSessionIds();
    if (persisted.length === 0) {
      return;
    }
    this.updateControllerState("booting", true);
    try {
      const connection = this.connectionFor(operation);
      const listed = await connection.list();
      if (!this.isTerminalOperationCurrent(operation)) {
        return;
      }
      const known = new Map(listed.map((session) => [session.sessionId, session]));
      for (const sessionId of persisted) {
        const session = known.get(sessionId);
        if (!session) {
          await this.restoreExitedSession(sessionId, operation);
        } else {
          await this.attachSession(
            sessionId,
            operation,
            session.owner?.startsWith("agent:") === true,
            true,
          );
        }
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
        this.updateControllerState("booting", false);
      }
    }
    if (!this.isTerminalOperationCurrent(operation)) {
      return;
    }
    // Prune ids the gateway no longer knows (reaped or externally closed).
    persistLiveTerminalSessions(this.tabs);
  }

  private async ensureInitialSession(): Promise<void> {
    if (this.tabs.length === 0 && !this.booting) {
      await this.openSessionNow();
    }
  }

  async listSessions(): Promise<TerminalSessionInfo[] | null> {
    const operation = this.captureTerminalOperation();
    if (!operation) {
      return null;
    }
    try {
      const sessions = await this.connectionFor(operation).list();
      return this.isTerminalOperationCurrent(operation) ? sessions : null;
    } catch {
      return this.isTerminalOperationCurrent(operation) ? [] : null;
    }
  }

  async attachSessionById(sessionId: string, agentOwned = false): Promise<void> {
    await this.enqueueAttachSession(sessionId, agentOwned);
  }

  private async enqueueAttachSession(sessionId: string, agentOwned: boolean): Promise<void> {
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
      this.updateControllerState("booting", true);
      this.host.terminalPanelErrorText = null;
      try {
        const attached = await this.attachSession(sessionId, operation, agentOwned);
        if (!attached && this.isTerminalOperationCurrent(operation)) {
          this.host.terminalPanelErrorText = t("terminal.attachFailed");
        }
      } finally {
        if (this.isTerminalOperationCurrent(operation)) {
          this.updateControllerState("booting", false);
        }
      }
    });
  }

  /** Boots a tab with a libterminal controller, ready for an open or attach RPC. */
  private async bootTab(
    operation: TerminalOperation,
    options: { awaitFirstOutput?: boolean } = {},
  ): Promise<{
    tab: TerminalPanelSessionTab;
    connection: TerminalConnection;
    cols: number;
    rows: number;
  }> {
    const connection = this.connectionFor(operation);
    // Preserve the connection so cancelled-open cleanup still closes the in-flight session.
    const host = document.createElement("div");
    host.className = "tp-host";
    const id = `tab-${++this.tabSequence}`;
    // Wait for the panel (and its .tp-viewport) to render before attaching the
    // ghostty host, so the terminal opens into a laid-out, measurable node.
    await this.host.updateComplete;
    if (!this.isTerminalOperationCurrent(operation)) {
      throw new Error("terminal operation cancelled");
    }
    const viewport = this.host.findTerminalPanelViewport();
    if (!viewport) {
      throw new Error("terminal viewport unavailable");
    }
    viewport.append(host);
    const tabReference = { current: undefined as TerminalPanelSessionTab | undefined };
    const startupInput = createTerminalStartupInput(
      connection,
      () => tabReference.current?.gatewaySessionId,
    );
    const { createTerminalDefaultColorQueryResponder } =
      await import("@openclaw/libterminal/browser");
    const defaultColorQueries = createTerminalDefaultColorQueryResponder({
      getColors: () => terminalDynamicColors(this.host.themeMode),
      reply: (data) => startupInput.onData(TERMINAL_OUTPUT_ENCODER.encode(data)),
    });
    let controller: GhosttyTerminalController;
    try {
      controller = await this.host.createTerminalController({
        parent: host,
        readOnly: false,
        terminalOptions: {
          fontSize: 13,
          fontFamily: TERMINAL_FONT_FAMILY,
          cursorBlink: true,
          theme: terminalTheme(this.host.themeMode),
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
    const tab: TerminalPanelSessionTab = {
      id,
      sequence: this.tabSequence,
      gatewaySessionId: "",
      pendingInput: startupInput.buffer,
      defaultColorQueries,
      shellName: null,
      shell: "",
      agentId: null,
      cwd: null,
      agentOwned: false,
      controller,
      host,
      status: "connecting",
      awaitFirstOutput: options.awaitFirstOutput === true,
      readyTimer: null,
    };
    tabReference.current = tab;
    this.updateControllerState("tabs", [...this.tabs, tab]);
    this.updateControllerState("activeId", id);
    const { terminal } = controller;
    return { tab, connection, cols: terminal.cols || 80, rows: terminal.rows || 24 };
  }

  /** Output/exit sink for one tab, shared by open and attach. */
  private tabSink(tab: TerminalPanelSessionTab) {
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
    tab: TerminalPanelSessionTab,
    result: { sessionId: string; shell: string; agentId: string; cwd: string; title?: string },
    agentOwned = false,
  ): void {
    tab.gatewaySessionId = result.sessionId;
    tab.shellName = result.title ?? shellBasename(result.shell);
    tab.shell = result.shell;
    tab.agentId = result.agentId;
    tab.cwd = result.cwd;
    tab.agentOwned = agentOwned;
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
    this.updateControllerState("tabs", [...this.tabs]);
    persistLiveTerminalSessions(this.tabs);
  }

  /** Removes a tab whose open/attach never produced a server session. */
  private dropFailedTab(tab: TerminalPanelSessionTab): void {
    this.disposeTab(tab);
    this.updateControllerState(
      "tabs",
      this.tabs.filter((entry) => entry.id !== tab.id),
    );
    if (this.activeId === tab.id) {
      this.updateControllerState("activeId", this.tabs.at(-1)?.id ?? null);
    }
  }

  async openSession(catalog?: TerminalPanelCatalogReference): Promise<void> {
    await this.bootQueue.enqueue(() => this.openSessionNow(catalog));
  }

  private async openSessionNow(catalog?: TerminalPanelCatalogReference): Promise<void> {
    const operation = this.captureTerminalOperation();
    if (!operation) {
      return;
    }
    this.updateControllerState("booting", true);
    this.host.terminalPanelErrorText = null;
    // Freeze the selection for this tab; later agent changes affect only new tabs.
    const agentId = this.host.agentId?.trim() || undefined;
    // Tracked outside the try so the catch can dispose a tab whose open failed.
    let createdTab: TerminalPanelSessionTab | undefined;
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
    } catch (error) {
      // A failed open (e.g. terminal disabled or a sandboxed agent is refused)
      // must not leave a phantom "live" tab with no server session. Drop it but
      // keep the panel open so the error stays visible.
      if (createdTab && !createdTab.gatewaySessionId && this.tabs.includes(createdTab)) {
        this.dropFailedTab(createdTab);
      }
      if (!this.isTerminalOperationCurrent(operation)) {
        return;
      }
      this.host.terminalPanelErrorText =
        error instanceof TerminalOpenTimeoutError
          ? t("terminal.connectionTimedOut")
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      if (this.isTerminalOperationCurrent(operation)) {
        this.updateControllerState("booting", false);
      }
    }
  }

  /** Reattaches one session and reports whether adoption succeeded. */
  private async attachSession(
    sessionId: string,
    operation: TerminalOperation,
    agentOwned = false,
    confirmGoneOnFailure = false,
  ): Promise<boolean> {
    let createdTab: TerminalPanelSessionTab | undefined;
    let createdConnection: TerminalConnection | undefined;
    try {
      const boot = await this.bootTab(operation);
      createdTab = boot.tab;
      createdConnection = boot.connection;
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
      this.adoptSession(boot.tab, result, agentOwned);
      return true;
    } catch {
      const sessionGone =
        confirmGoneOnFailure && createdConnection
          ? await this.confirmRestoredSessionGone(createdConnection, sessionId, operation)
          : false;
      if (createdTab && !createdTab.gatewaySessionId && this.tabs.includes(createdTab)) {
        if (sessionGone) {
          this.markRestoredSessionExited(createdTab, sessionId);
        } else {
          this.dropFailedTab(createdTab);
        }
      }
      return false;
    }
  }

  private async confirmRestoredSessionGone(
    connection: TerminalConnection,
    sessionId: string,
    operation: TerminalOperation,
  ): Promise<boolean> {
    try {
      const sessions = await connection.list();
      return (
        this.isTerminalOperationCurrent(operation) &&
        !sessions.some((session) => session.sessionId === sessionId)
      );
    } catch {
      // A failed confirmation cannot turn a transport or authorization error
      // into an authoritative terminal exit.
      return false;
    }
  }

  /** Keeps a dead persisted session visible without replaying bytes from a missing PTY. */
  private async restoreExitedSession(
    sessionId: string,
    operation: TerminalOperation,
  ): Promise<void> {
    const boot = await this.bootTab(operation);
    if (!this.isTerminalOperationCurrent(operation) || boot.tab.cancelled) {
      if (this.tabs.includes(boot.tab)) {
        boot.tab.cancelled = "lifecycle";
        this.dropFailedTab(boot.tab);
      }
      return;
    }
    this.markRestoredSessionExited(boot.tab, sessionId);
  }

  private markRestoredSessionExited(tab: TerminalPanelSessionTab, sessionId: string): void {
    tab.gatewaySessionId = sessionId;
    this.handleExit(tab.id, { reason: "disconnected", exitCode: null });
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
      this.host.terminalPanelErrorText = info.error.trim();
    }
    // The connection drops its own sink on exit delivery, so no release() here —
    // the session id may not be recorded yet when an early exit is replayed.
    this.updateControllerState("tabs", [...this.tabs]);
    persistLiveTerminalSessions(this.tabs);
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }
    this.host.terminalPanelUploadController.cancelForTab(tab);
    if (tab.gatewaySessionId && tab.status !== "exited") {
      void this.connection?.close(tab.gatewaySessionId);
    } else if (!tab.gatewaySessionId && tab.status !== "exited") {
      // Open still in flight: no session id to close yet. Flag it so the open
      // continuation closes the server session as soon as the RPC resolves.
      tab.cancelled = "close";
    }
    this.disposeTab(tab);
    this.updateControllerState(
      "tabs",
      this.tabs.filter((entry) => entry.id !== tabId),
    );
    if (this.activeId === tabId) {
      this.updateControllerState("activeId", this.tabs.at(-1)?.id ?? null);
    }
    persistLiveTerminalSessions(this.tabs);
    // Fullscreen documents (mobile WebViews) have no toggle to reopen a closed
    // panel, so closing the last tab keeps the panel with an empty tab strip
    // (the "+" button stays reachable) instead of leaving a dead blank page.
    if (this.tabs.length === 0 && !this.host.fullscreen) {
      this.host.closeTerminalPanel();
    }
  }

  switchTo(tabId: string): void {
    this.updateControllerState("activeId", tabId);
    const tab = this.tabs.find((entry) => entry.id === tabId);
    // Refit and repaint after the container becomes visible. A same-size tab
    // switch otherwise leaves the newly shown canvas without dirty rows.
    void this.host.updateComplete.then(() => {
      if (tab) {
        tab.controller.fit();
        forceTerminalRender(tab.controller);
        tab.controller.terminal.focus();
      }
    });
  }

  private captureTerminalOperation(): TerminalOperation | null {
    const client = this.host.client;
    if (!client || client !== this.activeClient || !this.host.available || !this.host.isConnected) {
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
      this.host.isConnected &&
      this.host.available &&
      this.host.client === operation.client &&
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

  private disposeTab(tab: TerminalPanelSessionTab): void {
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
    this.updateControllerState("booting", false);
    this.host.terminalPanelUploadController.dispose();
    this.host.clearTerminalPanelResizeListeners();
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
    this.updateControllerState("tabs", []);
    this.updateControllerState("activeId", null);
    this.host.resetTerminalSessionPicker();
    // Drop the gateway subscription with the tabs so the listener never outlives
    // the connection (disconnect/disable/element-removal all route through here).
    this.connection?.dispose();
    this.connection = null;
  }
}
