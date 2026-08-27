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

export function shellNavDrawerTriggerFromEvent(event: Event): HTMLElement | undefined {
  const trigger = (event as CustomEvent<ShellNavDrawerToggleDetail>).detail?.trigger;
  return trigger instanceof HTMLElement ? trigger : undefined;
}

export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette, event);
}

export type CommandPaletteTargetDetail = {
  owner: Element;
  onSlashCommand: ((command: string) => void) | null;
};

export function commandPaletteTargetFromEvent(
  current: CommandPaletteTargetDetail | undefined,
  event: Event,
): CommandPaletteTargetDetail | null | undefined {
  const detail = (event as CustomEvent<CommandPaletteTargetDetail>).detail;
  if (!detail || !(detail.owner instanceof Element)) {
    return null;
  }
  return detail.onSlashCommand ? detail : current?.owner === detail.owner ? undefined : current;
}

export function applyCommandPaletteTargetEvent(
  host: HTMLElement & {
    commandPaletteTarget: CommandPaletteTargetDetail | undefined;
    requestUpdate(): void;
  },
  event: Event,
): void {
  const target = commandPaletteTargetFromEvent(host.commandPaletteTarget, event);
  if (target !== null) {
    host.commandPaletteTarget = target;
    host.requestUpdate();
  }
}

export type CommandPaletteElement = HTMLElement & {
  custodianAvailable: boolean;
  desktopAvailable: boolean;
  isOpen: boolean;
  openPalette: () => void;
  togglePalette: () => void;
};
