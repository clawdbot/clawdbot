import type {
  TerminalPanelAction,
  TerminalPanelCatalogReference,
} from "./terminal-panel-session-types.ts";
import {
  loadPersistedTerminalActions,
  persistTerminalActions,
} from "./terminal-session-storage.ts";
import type { TerminalTaskQueue } from "./terminal-task-queue.ts";

type TerminalPendingActionsOptions = {
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

/** Keeps admitted terminal actions owned across reconnect generations and document reloads. */
export class TerminalPendingActions {
  private readonly actions: TerminalPanelAction[];
  private refreshPending = false;
  private refreshTimedOut = false;
  private refreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private drainScheduled = false;

  constructor(private readonly options: TerminalPendingActionsOptions) {
    const persisted = loadPersistedTerminalActions();
    // Explicit user work supersedes a generic reconnect restore. Otherwise the
    // restored shell would open first and obscure the action the operator chose.
    this.actions = persisted.some((action) => action.kind !== "restore")
      ? persisted.filter((action) => action.kind !== "restore")
      : persisted;
    if (this.actions.length !== persisted.length) {
      persistTerminalActions(this.actions);
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

  beginRefreshFence(generation: number): void {
    this.refreshPending = true;
    this.clearRefreshFailure();
    this.clearRefreshTimer();
    this.armRefreshTimer(generation);
  }

  releaseRefreshFence(): void {
    this.clearRefreshTimer();
    this.refreshPending = false;
    this.clearRefreshFailure();
    void this.drain();
  }

  resetLifecycle(): void {
    this.clearRefreshTimer();
    this.refreshPending = false;
    this.clearRefreshFailure();
  }

  async queue(action: TerminalPanelAction): Promise<void> {
    let changed = false;
    if (action.kind !== "restore") {
      for (let index = this.actions.length - 1; index >= 0; index -= 1) {
        if (this.actions[index]?.kind === "restore") {
          this.actions.splice(index, 1);
          changed = true;
        }
      }
    }
    const key = JSON.stringify(action);
    if (!this.actions.some((pending) => JSON.stringify(pending) === key)) {
      this.actions.push(action);
      changed = true;
    }
    if (changed) {
      persistTerminalActions(this.actions);
    }
    this.armRefreshTimer(this.options.currentGeneration());
    if (this.refreshPending) {
      this.options.requestUpdate();
    } else if (!this.options.hasTabs()) {
      this.options.setBooting(true);
    }
    await this.drain();
  }

  async drain(): Promise<void> {
    if (this.drainScheduled || this.actions.length === 0 || !this.options.canRun()) {
      return;
    }
    this.drainScheduled = true;
    try {
      await this.options.bootQueue.enqueue(async (isCurrent) => {
        const action = this.actions[0];
        if (!action || !isCurrent() || !this.options.canRun()) {
          return;
        }
        const completed = await this.execute(action);
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
      if (this.actions.length > 0 && this.options.canRun()) {
        void this.drain();
      } else if (this.actions.length === 0 && !this.options.hasTabs()) {
        this.options.setBooting(false);
      }
    }
  }

  cancel(): void {
    this.actions.splice(0);
    persistTerminalActions(this.actions);
    this.options.setBooting(false);
    this.clearRefreshFailure();
  }

  private async execute(action: TerminalPanelAction): Promise<boolean> {
    if (action.kind === "attach") {
      return this.options.attach(action.sessionId, action.agentOwned);
    }
    if (action.kind === "open") {
      return this.options.open(undefined, action.agentId);
    }
    await this.options.reattach();
    if (!this.options.canRun()) {
      return false;
    }
    return action.kind === "catalog"
      ? this.options.open(action.catalog, action.agentId)
      : this.options.ensureInitial(action.agentId);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      globalThis.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private clearRefreshFailure(): void {
    if (this.refreshTimedOut) {
      this.options.clearTimeout();
      this.refreshTimedOut = false;
    }
  }

  private armRefreshTimer(generation: number): void {
    if (!this.refreshPending || this.refreshTimer !== null || this.actions.length === 0) {
      return;
    }
    this.refreshTimer = globalThis.setTimeout(() => {
      this.refreshTimer = null;
      if (
        generation !== this.options.currentGeneration() ||
        !this.refreshPending ||
        this.actions.length === 0
      ) {
        return;
      }
      this.refreshTimedOut = true;
      this.options.showTimeout();
      this.options.setBooting(false);
    }, this.options.timeoutMs());
  }
}
