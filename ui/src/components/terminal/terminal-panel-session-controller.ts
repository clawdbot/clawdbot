import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import type { ReactiveController } from "lit";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import {
  TerminalConnection,
  type TerminalGatewayClient,
  type TerminalSessionInfo,
} from "./terminal-connection.ts";
import {
  disposeTerminalController,
  replaceTerminalController,
} from "./terminal-controller-lifecycle.ts";
import { terminalOpenErrorText } from "./terminal-panel-chrome.ts";
import {
  forceTerminalRender,
  shellBasename,
  TERMINAL_FONT_FAMILY,
  TERMINAL_OUTPUT_ENCODER,
  type TerminalOperation,
  type TerminalPanelCatalogReference,
  type TerminalPanelSessionControllerHost,
  type TerminalPanelSessionControllerState,
  type TerminalPanelSessionTab,
} from "./terminal-panel-session-types.ts";
import { TerminalOpenRetry, terminalIntentQueue } from "./terminal-pending-actions.ts";
import type { TerminalIntentHost } from "./terminal-pending-actions.ts";
import {
  loadPersistedTerminalSessionIds,
  persistLiveTerminalSessions,
} from "./terminal-session-storage.ts";
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
  private hadClient = false;
  private hadAvailable = false;
  private lifecycleGeneration = 0;
  private lifecycleAbortController = new AbortController();
  private lifecycleSyncToken = 0;
  private tabSequence = 0;
  readonly openRetry = new TerminalOpenRetry();
  private readonly bootQueue = new TerminalTaskQueue();
  private readonly intentHost: TerminalIntentHost;
  private readonly readiness: TerminalTabReadinessController<TerminalPanelSessionTab>;

  constructor(private readonly host: TerminalPanelSessionControllerHost) {
    host.addController(this);
    this.intentHost = {
      bootQueue: this.bootQueue,
      currentGeneration: () => this.lifecycleGeneration,
      canRun: () => this.terminalActionsCanRun(),
      attach: (sessionId, agentOwned) => this.attachSessionNow(sessionId, agentOwned),
      open: (catalog, agentId) => this.openSessionNow(catalog, agentId),
      reattach: () => this.reattachPersistedSessions(),
      ensureInitial: (agentId) => this.ensureInitialSession(agentId),
      hasTabs: () => this.tabs.length > 0,
      requestUpdate: () => this.host.requestUpdate(),
      setBooting: (booting) => this.updateControllerState("booting", booting),
      timeoutMs: () => this.host.catalogReadyTimeoutMs,
      showTimeout: () => (this.host.terminalPanelErrorText = t("terminal.refreshRequired")),
      clearTimeout: () => (this.host.terminalPanelErrorText = null),
    };
    this.readiness = new TerminalTabReadinessController<TerminalPanelSessionTab>({
      timeoutMs: () => this.host.catalogReadyTimeoutMs,
      isCurrent: (tab) => this.tabs.includes(tab),
      onReady: () => {
        this.openRetry.clear();
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
    this.hadClient = this.host.client !== null;
    this.hadAvailable = this.host.available;
    // Latest mount executes: on a session route the side-panel terminal takes
    // the queue over from the shell instance still held for the bottom dock.
    terminalIntentQueue.bindHost(this.intentHost);
    // Read after binding: the queue reloads its persisted record for the first
    // panel in a document, so an earlier read would miss a carried-over intent.
    this.updateControllerState("booting", terminalIntentQueue.hasActions);
  }

  disconnectHost(): void {
    terminalIntentQueue.releaseHost(this.intentHost);
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
    const becameAvailable = availabilityChanged && this.host.available && this.hadAvailable;
    const priorEpoch = (clientChanged && this.hadClient) || becameAvailable;
    const reconnecting = this.host.client !== null && priorEpoch;
    if (clientChanged) {
      this.activeClient = this.host.client;
      this.hadClient ||= this.host.client !== null;
    }
    this.activeAvailable = this.host.available;
    this.hadAvailable ||= this.host.available;
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
    if (reconnecting) {
      this.refreshBeforeReconnectRestore(shouldRestore);
    } else if (shouldRestore) {
      void this.restoreSessions();
    } else {
      void terminalIntentQueue.drain();
    }
  }

  private refreshBeforeReconnectRestore(restore: boolean): void {
    const generation = this.lifecycleGeneration;
    terminalIntentQueue.beginRefreshFence(this.intentHost, generation);
    if (restore) {
      void this.restoreSessions();
    }
    const release = () => {
      if (generation !== this.lifecycleGeneration || !this.host.isConnected) {
        return;
      }
      terminalIntentQueue.releaseRefreshFence(this.intentHost);
    };
    void import("../../app/sw-refresh.runtime.ts")
      .then(({ refreshControlUiServiceWorker }) => refreshControlUiServiceWorker())
      .then((replacementActivated) => {
        if (!replacementActivated) {
          release();
        }
      }, release);
  }

  async restoreSessions(): Promise<void> {
    const agentId = this.host.agentId?.trim() || null;
    await terminalIntentQueue.queue({ kind: "restore", agentId });
  }

  async openCatalogSession(catalog: TerminalPanelCatalogReference): Promise<void> {
    await terminalIntentQueue.queue({
      kind: "catalog",
      agentId: this.host.agentId?.trim() || null,
      catalog,
    });
  }

  async openRequestedSession(sessionId: string): Promise<void> {
    await terminalIntentQueue.queue({ kind: "attach", sessionId, agentOwned: true });
  }

  private terminalActionsCanRun(): boolean {
    const client = this.host.client;
    return (
      Boolean(client) &&
      client === this.activeClient &&
      this.host.available &&
      this.host.isConnected
    );
  }

  cancelPendingActions(): void {
    terminalIntentQueue.cancel(this.intentHost);
  }

  get waitingForRefresh(): boolean {
    return terminalIntentQueue.waitingForRefresh;
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

  private async ensureInitialSession(agentId: string | null): Promise<boolean> {
    if (this.tabs.length === 0) {
      return this.openSessionNow(undefined, agentId);
    }
    return this.terminalActionsCanRun();
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
    await terminalIntentQueue.queue({ kind: "attach", sessionId, agentOwned });
  }

  private async attachSessionNow(sessionId: string, agentOwned: boolean): Promise<boolean> {
    const existing = this.tabs.find((tab) => tab.gatewaySessionId === sessionId);
    if (existing) {
      this.switchTo(existing.id);
      return true;
    }
    const operation = this.captureTerminalOperation();
    if (!operation) {
      return false;
    }
    this.updateControllerState("booting", true);
    this.openRetry.clear();
    this.host.terminalPanelErrorText = null;
    try {
      const attached = await this.attachSession(sessionId, operation, agentOwned);
      if (attached) {
        return true;
      }
      if (!this.isTerminalOperationCurrent(operation)) {
        return false;
      }
      this.host.terminalPanelErrorText = t("terminal.attachFailed");
      return true;
    } finally {
      if (this.isTerminalOperationCurrent(operation)) {
        this.updateControllerState("booting", false);
      }
    }
  }

  /** Boots a tab with a libterminal controller, ready for an open or attach RPC. */
  private async bootTab(
    operation: TerminalOperation,
    options: { awaitFirstOutput?: boolean } = {},
  ) {
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
    const createController = (parent: HTMLElement, controllerOptions?: { readOnly?: boolean }) =>
      this.host.createTerminalController({
        parent,
        readOnly: controllerOptions?.readOnly ?? false,
        terminalOptions: {
          fontSize: 11,
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
    let controller: GhosttyTerminalController;
    try {
      controller = await createController(host);
    } catch (error) {
      host.remove();
      throw error;
    }
    if (!this.isTerminalOperationCurrent(operation)) {
      disposeTerminalController(controller, host);
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
    const sink: Parameters<TerminalConnection["open"]>[1] = {
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
      onReplay: ({ data, newlyObservedFrom, mode, signal }) => {
        if (tab.cancelled || signal.aborted) {
          return undefined;
        }
        // Suppress complete historical queries, then answer only the suffix
        // recovered after a sequence gap. A split query may cross the seam.
        tab.defaultColorQueries.primeFromReplay(data.slice(0, newlyObservedFrom));
        tab.defaultColorQueries.observe(data.slice(newlyObservedFrom));
        if (mode === "recovery") {
          return replaceTerminalController(tab, createController, data, signal).then((replaced) => {
            if (replaced && data) {
              this.readiness.markReady(tab);
            }
          });
        }
        if (data) {
          tab.controller.write(TERMINAL_OUTPUT_ENCODER.encode(data));
          this.readiness.markReady(tab);
        }
        return undefined;
      },
      onExit: (info: { reason?: string; exitCode: number | null; error?: string }) =>
        this.handleExit(tab.id, info),
    };
    this.updateControllerState("tabs", [...this.tabs, tab]);
    this.updateControllerState("activeId", id);
    const { terminal } = controller;
    return {
      tab,
      connection,
      cols: terminal.cols || 80,
      rows: terminal.rows || 24,
      sink,
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
    await terminalIntentQueue.queue(
      catalog
        ? { kind: "catalog", agentId: this.host.agentId?.trim() || null, catalog }
        : { kind: "open", agentId: this.host.agentId?.trim() || null },
    );
  }

  private async openSessionNow(
    catalog: TerminalPanelCatalogReference | undefined,
    agentId: string | null,
  ): Promise<boolean> {
    const operation = this.captureTerminalOperation();
    if (!operation) {
      return false;
    }
    this.updateControllerState("booting", true);
    this.openRetry.remember(catalog, agentId);
    this.host.terminalPanelErrorText = null;
    // Freeze the selection for this tab; later agent changes affect only new tabs.
    const ownerAgentId = agentId ?? undefined;
    // Tracked outside the try so the catch can dispose a tab whose open failed.
    let createdTab: TerminalPanelSessionTab | undefined;
    try {
      const boot = await this.bootTab(operation, { awaitFirstOutput: Boolean(catalog) });
      createdTab = boot.tab;
      const result = await boot.connection.open(
        {
          agentId: ownerAgentId,
          cols: boot.cols,
          rows: boot.rows,
          ...(catalog ? { catalog } : {}),
        },
        boot.sink,
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
        return false;
      }
      this.adoptSession(boot.tab, result);
      boot.tab.controller.terminal.focus();
      return true;
    } catch (error) {
      // A failed open (e.g. terminal disabled or a sandboxed agent is refused)
      // must not leave a phantom "live" tab with no server session. Drop it but
      // keep the panel open so the error stays visible.
      if (createdTab && !createdTab.gatewaySessionId && this.tabs.includes(createdTab)) {
        this.dropFailedTab(createdTab);
      }
      if (!this.isTerminalOperationCurrent(operation)) {
        return false;
      }
      this.openRetry.clearUnlessRetryable(error);
      this.host.terminalPanelErrorText = terminalOpenErrorText(error);
      return true;
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
      const result = await boot.connection.attach(sessionId, boot.sink);
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
      this.host.terminalPanelErrorText = formatUiExternalText(info.error);
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
    if (
      terminalIntentQueue.fenced ||
      !client ||
      client !== this.activeClient ||
      !this.host.available ||
      !this.host.isConnected
    ) {
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
    disposeTerminalController(tab.controller, tab.host);
  }

  private disposeAllTabs(): void {
    this.lifecycleGeneration += 1;
    terminalIntentQueue.resetLifecycle(this.intentHost);
    this.lifecycleAbortController.abort();
    this.lifecycleAbortController = new AbortController();
    this.bootQueue.reset();
    this.openRetry.clear();
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
