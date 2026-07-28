import type { TerminalPanelTab } from "./terminal-panel-tabs.ts";

export type TerminalTabReadinessState = {
  awaitFirstOutput: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
};

type ReadyTab = TerminalPanelTab & TerminalTabReadinessState;

export class TerminalTabReadinessController<T extends ReadyTab> {
  constructor(
    private readonly options: {
      timeoutMs: () => number;
      isCurrent: (tab: T) => boolean;
      onReady: (tab: T) => void;
      onTimeout: (tab: T) => void;
    },
  ) {}

  markReady(tab: T): void {
    this.stop(tab);
    if (tab.status !== "connecting") {
      return;
    }
    tab.status = "live";
    this.options.onReady(tab);
  }

  arm(tab: T): void {
    if (tab.readyTimer || tab.status !== "connecting" || !tab.awaitFirstOutput) {
      return;
    }
    // PTY creation only proves transport setup. Native CLIs are ready once they
    // emit their first byte; otherwise a broken relay looks like a blank shell.
    tab.readyTimer = setTimeout(() => {
      tab.readyTimer = null;
      if (!this.options.isCurrent(tab) || tab.status !== "connecting" || !tab.awaitFirstOutput) {
        return;
      }
      tab.awaitFirstOutput = false;
      this.options.onTimeout(tab);
    }, this.options.timeoutMs());
  }

  stop(tab: T): void {
    if (tab.readyTimer) {
      clearTimeout(tab.readyTimer);
      tab.readyTimer = null;
    }
    tab.awaitFirstOutput = false;
  }
}
