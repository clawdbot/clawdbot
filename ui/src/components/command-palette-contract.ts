import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";

export const COMMAND_PALETTE_TARGET_EVENT = "openclaw-command-palette-target";
export const COMMAND_PALETTE_OPEN_EVENT = "openclaw:command-palette-open";
export const SHELL_NAV_DRAWER_TOGGLE_EVENT = "openclaw:shell-nav-drawer-toggle";

export type ShellNavDrawerToggleDetail = {
  trigger: HTMLElement;
};

export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette, event);
}

export type CommandPaletteTargetDetail = {
  owner: Element;
  onSlashCommand: ((command: string) => void) | null;
};

export type CommandPaletteElement = HTMLElement & {
  custodianAvailable: boolean;
  desktopAvailable: boolean;
  isOpen: boolean;
  openPalette: () => void;
  togglePalette: () => void;
};
