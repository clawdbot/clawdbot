export const COMMAND_PALETTE_TARGET_EVENT = "openclaw-command-palette-target";

export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k";
}

export type CommandPaletteTargetDetail = {
  owner: Element;
  onSlashCommand: ((command: string) => void) | null;
};

export type CommandPaletteElement = HTMLElement & {
  isOpen: boolean;
  openPalette: () => void;
  togglePalette: () => void;
};
