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
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  const trigger =
    detail && typeof detail === "object" && "trigger" in detail ? detail.trigger : null;
  return trigger instanceof HTMLElement ? trigger : undefined;
}

export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette, event);
}

export type CommandPaletteTargetDetail = {
  owner: Element;
  onSlashCommand: ((command: string) => void) | null;
};

function isCommandPaletteTargetDetail(value: unknown): value is CommandPaletteTargetDetail {
  return (
    value !== null &&
    typeof value === "object" &&
    "owner" in value &&
    value.owner instanceof Element &&
    "onSlashCommand" in value &&
    (value.onSlashCommand === null || typeof value.onSlashCommand === "function")
  );
}

function commandPaletteTargetFromEvent(
  current: CommandPaletteTargetDetail | undefined,
  event: Event,
): CommandPaletteTargetDetail | null | undefined {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  if (!isCommandPaletteTargetDetail(detail)) {
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
