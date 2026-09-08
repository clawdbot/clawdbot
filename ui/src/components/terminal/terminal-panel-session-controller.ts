import type { SessionsCatalogStartTerminalParams } from "@openclaw/gateway-protocol";
import type { ReactiveController } from "lit";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import {
  TerminalConnection,
  type TerminalGatewayClient,
  type TerminalOpenResult,
  type TerminalSessionInfo,
} from "./terminal-connection.ts";
import { disposeTerminalController } from "./terminal-controller-lifecycle.ts";
import { terminalOpenErrorText } from "./terminal-panel-chrome.ts";
import { bootTerminalPanelSession } from "./terminal-panel-session-boot.ts";
import { focusTerminalSession } from "./terminal-panel-session-rendering.ts";
import {
  resolveTerminalPanelOwnerSessionKey,
  shellBasename,
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
import { TerminalTabReadinessController } from "./terminal-tab-readiness.ts";
import { TerminalTaskQueue } from "./terminal-task-queue.ts";

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
    return (
      this.host.client !== null &&
      this.host.client === this.activeClient &&
      this.host.available &&
      // A lazy upgrade also mounts the closed shell. Only the visible owner
      // may consume intent; a viewport-less boot would discard it as failed.
      this.host.terminalPanelOpen &&
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
        if (this.activeId) {
          this.switchTo(this.activeId);
        }
        return true;
      }
      if (!this.isTerminalOperationCurrent(operation)) {
        return false;
      }
      this.host.terminalPanelErrorText ??= t("terminal.attachFailed");
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
    const boot = await bootTerminalPanelSession({
      panel: this.host,
      connection: this.connectionFor(operation),
      sequence: ++this.tabSequence,
      signal: operation.signal,
      awaitFirstOutput: options.awaitFirstOutput === true,
      isCurrent: () => this.isTerminalOperationCurrent(operation),
      onReady: (tab) => this.readiness.markReady(tab),
      onExit: (tab, info) => this.handleExit(tab.id, info),
    });
    if (!this.isTerminalOperationCurrent(operation)) {
      disposeTerminalController(boot.tab.controller, boot.tab.host);
      throw new Error("terminal operation cancelled");
    }
    this.updateControllerState("tabs", [...this.tabs, boot.tab]);
    this.updateControllerState("activeId", boot.tab.id);
    return boot;
  }

  /** Binds a freshly opened or attached gateway session to its tab. */
  private adoptSession(
    tab: TerminalPanelSessionTab,
    result: TerminalOpenResult,
    agentOwned = false,
  ): void {
    tab.gatewaySessionId = result.sessionId;
    tab.shellName = result.title ?? shellBasename(result.shell);
    tab.shell = result.shell;
    tab.agentId = result.agentId;
    tab.cwd = result.cwd;
    tab.agentOwned = result.owner !== undefined ? result.owner.startsWith("agent:") : agentOwned;
    // Libterminal observes layout before the Gateway session exists. Resync the
    // current grid now so a resize during the open/attach RPC is not lost.
    const pendingInput = tab.pendingInput.drain();
    if (tab.status !== "exited") {
      const { cols, rows } = tab.controller.terminal;
      void this.connection?.resize(result.sessionId, cols || 80, rows || 24);
      for (const data of pendingInput) {
        void this.connection?.input(result.sessionId, data);
      }
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
    try {
      return (await this.createSession(catalog, agentId)) !== null;
    } catch {
      // createSession reports the error; consume the failed queued intent.
      return true;
    }
  }

  async startCatalogSession(
    params: SessionsCatalogStartTerminalParams,
    isCurrent: () => boolean,
  ): Promise<TerminalOpenResult> {
    let result: TerminalOpenResult | null = null;
    await this.bootQueue.enqueue(async () => {
      result = await this.createSession(undefined, params.agentId, { params, isCurrent });
    });
    if (!result) {
      throw new Error(t("terminal.startCancelled"));
    }
    return result;
  }

  private async createSession(
    catalog: TerminalPanelCatalogReference | undefined,
    agentId: string | null,
    start?: { params: SessionsCatalogStartTerminalParams; isCurrent: () => boolean },
  ): Promise<TerminalOpenResult | null> {
    const operation = this.captureTerminalOperation();
    if (!operation || (start && !start.isCurrent())) {
      return null;
    }
    this.updateControllerState("booting", true);
    if (start) {
      this.openRetry.clear();
    } else {
      this.openRetry.remember(catalog, agentId);
    }
    this.host.terminalPanelErrorText = null;
    // Freeze the selection for this tab; later agent changes affect only new tabs.
    const ownerSessionKey = start
      ? undefined
      : resolveTerminalPanelOwnerSessionKey(this.host.sessionKey, catalog);
    // Tracked outside the try so the catch can dispose a tab whose open failed.
    let createdTab: TerminalPanelSessionTab | undefined;
    try {
      const boot = await this.bootTab(operation, { awaitFirstOutput: Boolean(catalog || start) });
      createdTab = boot.tab;
      if (start && !start.isCurrent()) {
        throw new Error(t("terminal.startCancelled"));
      }
      const result = start
        ? await boot.connection.start(start.params, boot.sink)
        : await boot.connection.open(
            {
              agentId: agentId ?? undefined,
              ...(ownerSessionKey ? { sessionKey: ownerSessionKey } : {}),
              cols: boot.cols,
              rows: boot.rows,
              ...(catalog ? { catalog } : {}),
            },
            boot.sink,
          );
      if (
        !this.isTerminalOperationCurrent(operation) ||
        boot.tab.cancelled ||
        (start && !start.isCurrent())
      ) {
        // The tab's close button was clicked while the open RPC was in flight.
        // The server session is live and its sink registered; close it now or
        // it survives invisibly (eating the session cap) until disconnect.
        void boot.connection.close(result.sessionId);
        if (this.tabs.includes(boot.tab)) {
          boot.tab.cancelled = "lifecycle";
          this.dropFailedTab(boot.tab);
        }
        return null;
      }
      this.adoptSession(boot.tab, result, ownerSessionKey !== undefined);
      boot.tab.controller.terminal.focus();
      return result;
    } catch (error) {
      // A failed open (e.g. terminal disabled or a sandboxed agent is refused)
      // must not leave a phantom "live" tab with no server session. Drop it but
      // keep the panel open so the error stays visible.
      if (createdTab && !createdTab.gatewaySessionId && this.tabs.includes(createdTab)) {
        this.dropFailedTab(createdTab);
      }
      if (!this.isTerminalOperationCurrent(operation) || (start && !start.isCurrent())) {
        return null;
      }
      this.openRetry.clearUnlessRetryable(error);
      this.host.terminalPanelErrorText = terminalOpenErrorText(error);
      throw error;
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
    } catch (error) {
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
      if (!confirmGoneOnFailure && this.isTerminalOperationCurrent(operation)) {
        this.host.terminalPanelErrorText = `${t("terminal.attachFailed")}: ${formatUiError(error)}`;
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
    info: { reason?: string; exitCode: number | null; signal?: number | null; error?: string },
  ): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }
    this.readiness.stop(tab);
    tab.status = "exited";
    tab.exitReason = info.reason;
    tab.exitCode = info.exitCode;
    tab.exitSignal = info.signal;
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
    void focusTerminalSession(tab, this.host.updateComplete);
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
