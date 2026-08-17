import type { UiCommandParams } from "@openclaw/gateway-protocol";

export const TERMINAL_PANEL_TOGGLE_EVENT = "openclaw:terminal-toggle";
export const TERMINAL_PANEL_DOCK_BOTTOM_EVENT = "openclaw:terminal-dock-bottom";
export const BROWSER_PANEL_TOGGLE_EVENT = "openclaw:browser-toggle";
export const DESKTOP_PANEL_TOGGLE_EVENT = "openclaw:desktop-toggle";
export const CUSTODIAN_PANEL_TOGGLE_EVENT = "openclaw:custodian-toggle";
export const UI_COMMAND_EVENT = "openclaw:ui-command";

export type UiCommandDetail = UiCommandParams;

export type TerminalPanelToggleDetail = {
  agentId?: string | null;
  dock?: "bottom" | "right";
  open?: boolean;
  terminalSessionId?: string;
  catalog?: {
    catalogId: string;
    hostId: string;
    threadId: string;
  };
};

export type BrowserPanelToggleDetail = {
  dock?: "bottom" | "right";
  newTab?: boolean;
  open?: boolean;
  url?: string;
};

export type DesktopPanelToggleDetail = {
  dock?: "bottom" | "right";
  open?: boolean;
  environmentId?: string;
};

export type CustodianPanelToggleDetail = {
  open?: boolean;
  dock?: "bottom" | "right";
};

export type PanelToggleElement = HTMLElement & {
  handleToggleRequest: (event: Event) => void;
};

export function isTerminalPanelShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Backquote";
}
