import type {
  createTerminalDefaultColorQueryResponder,
  CreateGhosttyTerminalOptions,
  GhosttyTerminalController,
} from "@openclaw/libterminal/browser";
import type { ReactiveControllerHost } from "lit";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import type { TerminalPanelTab } from "./terminal-panel-tabs.ts";
import type { TerminalPanelUploadController } from "./terminal-panel-upload.ts";
import { persistTerminalSessionIds } from "./terminal-session-storage.ts";
import type { StartupInputBuffer } from "./terminal-startup-input.ts";
import type { TerminalTabReadinessState } from "./terminal-tab-readiness.ts";

export type TerminalPanelSessionTab = TerminalPanelTab &
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

export type TerminalOperation = {
  generation: number;
  client: TerminalGatewayClient;
  signal: AbortSignal;
};

export type TerminalPanelCatalogReference = {
  catalogId: string;
  hostId: string;
  threadId: string;
};

export type TerminalPanelSessionControllerState = {
  tabs: TerminalPanelSessionTab[];
  activeId: string | null;
  booting: boolean;
};

export interface TerminalPanelSessionControllerHost extends ReactiveControllerHost {
  readonly isConnected: boolean;
  readonly client: TerminalGatewayClient | null;
  readonly agentId: string | null;
  readonly available: boolean;
  readonly themeMode: "dark" | "light";
  readonly fullscreen: boolean;
  readonly terminalPanelOpen: boolean;
  readonly catalogReadyTimeoutMs: number;
  terminalPanelErrorText: string | null;
  readonly terminalPanelUploadController: TerminalPanelUploadController;
  createTerminalController(
    options: CreateGhosttyTerminalOptions,
  ): Promise<GhosttyTerminalController>;
  closeTerminalPanel(): void;
  clearTerminalPanelResizeListeners(): void;
  findTerminalPanelViewport(): Element | null;
  hideTerminalPanelForUnavailableSurface(): void;
  resetTerminalSessionPicker(): void;
  restoreTerminalPanelOpenState(): boolean;
}

export const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Symbols Nerd Font Mono", "MesloLGLDZ Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "Liberation Mono", monospace';
export const TERMINAL_OUTPUT_ENCODER = new TextEncoder();

/** Reduces a shell path to a tab label, e.g. "/bin/zsh" -> "zsh". */
export function shellBasename(shell: string): string {
  const base = shell.split(/[\\/]/).pop()?.trim();
  return base && base.length > 0 ? base : "shell";
}

export function forceTerminalRender(controller: GhosttyTerminalController): void {
  const term = controller.terminal;
  if (term.renderer && term.wasmTerm) {
    // An omitted opacity defaults to 1; repaint without inventing a visible scrollbar.
    term.renderer.render(term.wasmTerm, true, term.viewportY, term, 0);
  }
}

export function persistLiveTerminalSessions(tabs: readonly TerminalPanelSessionTab[]): void {
  persistTerminalSessionIds(
    tabs
      .filter((tab) => tab.status === "live" && tab.gatewaySessionId)
      .map((tab) => tab.gatewaySessionId),
  );
}
