export const TERMINAL_PANEL_TOGGLE_EVENT = "openclaw:terminal-toggle";
export const BROWSER_PANEL_TOGGLE_EVENT = "openclaw:browser-toggle";

export type TerminalPanelToggleDetail = {
  dock?: "bottom" | "right";
  open?: boolean;
  catalog?: {
    catalogId: string;
    hostId: string;
    threadId: string;
  };
};

export type BrowserPanelToggleDetail = {
  dock?: "bottom" | "right";
  open?: boolean;
  url?: string;
};

export type PanelToggleElement = HTMLElement & {
  handleToggleRequest: (event: Event) => void;
};

export function isTerminalPanelShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Backquote";
}
