import type { TerminalPanelToggleDetail } from "../panel-toggle-contract.ts";
import type {
  TerminalPanelAction,
  TerminalPanelCatalogReference,
} from "./terminal-panel-session-types.ts";
import {
  loadPersistedTerminalActions,
  persistTerminalActions,
} from "./terminal-session-storage.ts";
import type { TerminalTaskQueue } from "./terminal-task-queue.ts";

export type TerminalIntentHost = {
  bootQueue: Pick<TerminalTaskQueue, "enqueue">;
  currentGeneration: () => number;
  canRun: () => boolean;
  attach: (sessionId: string, agentOwned: boolean) => Promise<boolean>;
  open: (
    catalog: TerminalPanelCatalogReference | undefined,
    agentId: string | null,
  ) => Promise<boolean>;
  reattach: () => Promise<void>;
  ensureInitial: (agentId: string | null) => Promise<boolean>;
  hasTabs: () => boolean;
  requestUpdate: () => void;
  setBooting: (booting: boolean) => void;
  timeoutMs: () => number;
  showTimeout: () => void;
  clearTimeout: () => void;
};

/**
 * One terminal intent queue per document. Panels come and go — a session route
 * mounts the side-panel terminal beside the shell's bottom-dock instance — but
 * the queue, its persisted copy, and the reconnect fence must not: two owners
 * over one storage key drop each other's intents and run the same open twice.
 * Hosts bind while connected; the most recent binding executes.
 */
class TerminalIntentQueue {
  private readonly actions: TerminalPanelAction[];
  private refreshPending = false;
  private refreshTimedOut = false;
  private refreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private drainScheduled = false;
  private hosts: TerminalIntentHost[] = [];
  private fenceHost: TerminalIntentHost | null = null;
  private fenceGeneration = 0;
  private timeoutHost: TerminalIntentHost | null = null;

  constructor() {
    this.actions = [];
    this.rehydrate();
  }

  /**
   * Mirrors the persisted record whenever no panel is bound, so a document with
   * its terminals unmounted resumes exactly like a freshly loaded one.
   */
  private rehydrate(): void {
    const persisted = loadPersistedTerminalActions();
    // Explicit user work supersedes a generic reconnect restore. Otherwise the
    // restored shell would open first and obscure the action the operator chose.
    const admitted = persisted.some((action) => action.kind !== "restore")
      ? persisted.filter((action) => action.kind !== "restore")
      : persisted;
    this.actions.splice(0, this.actions.length, ...admitted);
    if (admitted.length !== persisted.length) {
      persistTerminalActions(this.actions);
    }
  }

  private get host(): TerminalIntentHost | null {
    return this.hosts.at(-1) ?? null;
  }

  bindHost(host: TerminalIntentHost): void {
    if (this.hosts.length === 0) {
      this.rehydrate();
    }
    this.hosts = [...this.hosts.filter((bound) => bound !== host), host];
    void this.drain();
  }

  releaseHost(host: TerminalIntentHost): void {
    this.hosts = this.hosts.filter((bound) => bound !== host);
    // A fence outlives its opener only as a deadlock: nothing else can release it.
    if (this.fenceHost === host) {
      this.resetLifecycle(host);
    }
    if (this.hosts.length === 0) {
      this.clearRefreshTimer();
      this.refreshTimedOut = false;
      this.timeoutHost = null;
      this.rehydrate();
    }
  }

  get hasActions(): boolean {
    return this.actions.length > 0;
  }

  get fenced(): boolean {
    return this.refreshPending;
  }

  get waitingForRefresh(): boolean {
    return this.refreshPending && !this.refreshTimedOut && this.actions.length > 0;
  }

  beginRefreshFence(host: TerminalIntentHost, generation: number): void {
    this.refreshPending = true;
    this.fenceHost = host;
    this.fenceGeneration = generation;
    this.clearRefreshFailure();
    this.clearRefreshTimer();
    this.armRefreshTimer();
  }

  releaseRefreshFence(host: TerminalIntentHost): void {
    if (this.fenceHost !== host) {
      return;
    }
    this.clearRefreshTimer();
    this.refreshPending = false;
    this.fenceHost = null;
    this.clearRefreshFailure();
    void this.drain();
  }

  // Only the panel that opened the fence may drop it; another panel disposing
  // its tabs must not unblock a refresh it knows nothing about.
  resetLifecycle(host: TerminalIntentHost): void {
    if (this.fenceHost !== null && this.fenceHost !== host) {
      return;
    }
    this.clearRefreshTimer();
    this.refreshPending = false;
    this.fenceHost = null;
    this.clearRefreshFailure();
  }

  async queue(
    action: TerminalPanelAction,
    options: { deferUntilHostChange?: boolean } = {},
  ): Promise<void> {
    let changed = false;
    if (action.kind !== "restore") {
      for (let index = this.actions.length - 1; index >= 0; index -= 1) {
        if (this.actions[index]?.kind === "restore") {
          this.actions.splice(index, 1);
          changed = true;
        }
      }
    }
    const explicitIntentPending = this.actions.some((pending) => pending.kind !== "restore");
    const key = JSON.stringify(action);
    if (
      !(action.kind === "restore" && explicitIntentPending) &&
      !this.actions.some((pending) => JSON.stringify(pending) === key)
    ) {
      this.actions.push(action);
      changed = true;
    }
    if (changed) {
      persistTerminalActions(this.actions);
    }
    // A session-route intent is persisted before its embedded panel mounts.
    // The shell's bottom-only panel must not claim it in that gap; the next
    // host binding drains it from the canonical document queue.
    if (options.deferUntilHostChange) {
      return;
    }
    this.armRefreshTimer();
    const host = this.host;
    if (this.refreshPending) {
      host?.requestUpdate();
    } else if (host && !host.hasTabs()) {
      host.setBooting(true);
    }
    await this.drain();
  }

  async drain(): Promise<void> {
    const host = this.host;
    if (this.drainScheduled || this.actions.length === 0 || !host || !this.canRun(host)) {
      return;
    }
    this.drainScheduled = true;
    try {
      await host.bootQueue.enqueue(async (isCurrent) => {
        const action = this.actions[0];
        if (!action || !isCurrent() || !this.canRun(host)) {
          return;
        }
        const completed = await this.execute(host, action);
        if (!completed || !isCurrent()) {
          return;
        }
        const index = this.actions.indexOf(action);
        if (index !== -1) {
          this.actions.splice(index, 1);
          persistTerminalActions(this.actions);
        }
      });
    } finally {
      this.drainScheduled = false;
      const current = this.host;
      if (this.actions.length > 0 && current && this.canRun(current)) {
        void this.drain();
      } else if (this.actions.length === 0 && current && !current.hasTabs()) {
        current.setBooting(false);
      }
    }
  }

  // Closing a terminal drops the intents queued for it, but only the panel the
  // operator is actually looking at may do that to the shared queue.
  cancel(host: TerminalIntentHost): void {
    if (this.host !== host) {
      return;
    }
    this.actions.splice(0);
    persistTerminalActions(this.actions);
    host.setBooting(false);
    this.clearRefreshFailure();
  }

  private canRun(host: TerminalIntentHost): boolean {
    return !this.refreshPending && host.canRun();
  }

  private async execute(host: TerminalIntentHost, action: TerminalPanelAction): Promise<boolean> {
    if (action.kind === "attach") {
      return host.attach(action.sessionId, action.agentOwned);
    }
    if (action.kind === "open") {
      return host.open(undefined, action.agentId);
    }
    await host.reattach();
    // A second panel mounting mid-flight must not strand this action: the host
    // that started it is still connected, so it finishes what it began.
    if (!this.canRun(host)) {
      return false;
    }
    return action.kind === "catalog"
      ? host.open(action.catalog, action.agentId)
      : host.ensureInitial(action.agentId);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      globalThis.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private clearRefreshFailure(): void {
    if (this.refreshTimedOut) {
      // The panel that surfaced the timeout owns the text that clears it.
      this.timeoutHost?.clearTimeout();
      this.timeoutHost = null;
      this.refreshTimedOut = false;
    }
  }

  private armRefreshTimer(): void {
    const fenceHost = this.fenceHost;
    if (!this.refreshPending || !fenceHost || this.refreshTimer !== null) {
      return;
    }
    if (this.actions.length === 0) {
      return;
    }
    const generation = this.fenceGeneration;
    this.refreshTimer = globalThis.setTimeout(() => {
      this.refreshTimer = null;
      if (
        this.fenceHost !== fenceHost ||
        generation !== fenceHost.currentGeneration() ||
        !this.refreshPending ||
        this.actions.length === 0
      ) {
        return;
      }
      this.refreshTimedOut = true;
      this.timeoutHost = fenceHost;
      fenceHost.showTimeout();
      fenceHost.setBooting(false);
    }, fenceHost.timeoutMs());
  }
}

/** Document-scoped owner; panels bind to it, they do not own copies. */
export const terminalIntentQueue = new TerminalIntentQueue();

/**
 * The durable intent a toggle implies, if any. Observers record it here rather
 * than handing the raw event to a panel that may not be mounted yet: a reload
 * between the request and that mount would otherwise lose it with no trace.
 */
export function terminalToggleIntent(
  event: Event,
  fallbackAgentId: string | null,
): TerminalPanelAction | null {
  const detail =
    event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
      ? (event.detail as TerminalPanelToggleDetail)
      : null;
  if (!detail || detail.open === false) {
    return null;
  }
  const agentId = detail.agentId?.trim() || fallbackAgentId;
  if (detail.terminalSessionId) {
    return { kind: "attach", sessionId: detail.terminalSessionId, agentOwned: true };
  }
  if (detail.catalog) {
    return { kind: "catalog", agentId, catalog: detail.catalog };
  }
  return detail.open === true ? { kind: "restore", agentId } : null;
}
