import type { UiCommandParams } from "@openclaw/gateway-protocol";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";

export const TERMINAL_PANEL_TOGGLE_EVENT = "openclaw:terminal-toggle";
export const TERMINAL_PANEL_DOCK_BOTTOM_EVENT = "openclaw:terminal-dock-bottom";
export const BROWSER_PANEL_TOGGLE_EVENT = "openclaw:browser-toggle";
export const DESKTOP_PANEL_TOGGLE_EVENT = "openclaw:desktop-toggle";
export const CUSTODIAN_PANEL_TOGGLE_EVENT = "openclaw:custodian-toggle";
export const DEBUG_OVERLAY_REQUEST_EVENT = "openclaw:debug-overlay-request";
export const KEYBOARD_SHORTCUTS_REQUEST_EVENT = "openclaw:keyboard-shortcuts-request";
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
  /** Existing tab to focus when the panel opens (browser-tab chat cards). */
  targetId?: string;
  url?: string;
};

export type DesktopPanelToggleDetail = {
  dock?: "bottom" | "right";
  open?: boolean;
  environmentId?: string;
};

export type PanelToggleElement = HTMLElement & {
  handleToggleRequest: (event: Event) => void;
};

export function isTerminalPanelShortcut(event: KeyboardEvent): boolean {
  return matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.terminalPanel, event);
}
