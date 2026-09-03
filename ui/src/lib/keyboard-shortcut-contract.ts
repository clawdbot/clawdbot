import { resolveAsciiShortcutKey } from "./keyboard-shortcuts.ts";

type KeyboardShortcutModifier = "mod" | "ctrl" | "shift" | "alt";
type KeyboardShortcutKey =
  | "k"
  | "b"
  | "d"
  | "f"
  | "h"
  | "/"
  | "+"
  | "-"
  | "0"
  | "Backquote"
  | "Comma"
  | "Enter"
  | "Escape"
  | "ArrowUp"
  | "ArrowDown"
  // Display-only mouse chord for the overview dialog; never keyboard-matched.
  | "Click";

export type KeyboardShortcutCombo = {
  readonly modifiers: readonly KeyboardShortcutModifier[];
  readonly key: KeyboardShortcutKey;
};

export const KEYBOARD_SHORTCUT_COMBOS = {
  commandPalette: { modifiers: ["mod"], key: "k" },
  keyboardShortcuts: { modifiers: ["mod"], key: "/" },
  toggleSidebar: { modifiers: ["mod"], key: "b" },
  debugOverlay: { modifiers: ["mod", "shift"], key: "d" },
  appearanceSettings: { modifiers: ["mod", "shift"], key: "Comma" },
  escape: { modifiers: [], key: "Escape" },
  sendMessage: { modifiers: [], key: "Enter" },
  modifiedEnter: { modifiers: ["mod"], key: "Enter" },
  newline: { modifiers: ["shift"], key: "Enter" },
  transcriptSearch: { modifiers: ["mod"], key: "f" },
  terminalPanel: { modifiers: ["ctrl"], key: "Backquote" },
  homePanel: { modifiers: ["mod", "shift"], key: "h" },
  workspaceFiles: { modifiers: ["mod", "shift"], key: "b" },
  approveAlways: { modifiers: ["mod", "shift"], key: "Enter" },
  denyApproval: { modifiers: ["mod"], key: "d" },
  historyPrevious: { modifiers: [], key: "ArrowUp" },
  historyNext: { modifiers: [], key: "ArrowDown" },
  zoomIn: { modifiers: [], key: "+" },
  zoomOut: { modifiers: [], key: "-" },
  zoomReset: { modifiers: [], key: "0" },
  toggleSessionSelect: { modifiers: ["mod"], key: "Click" },
  extendSessionSelect: { modifiers: ["shift"], key: "Click" },
} as const satisfies Record<string, KeyboardShortcutCombo>;

export function isApplePlatform(platform = globalThis.navigator?.platform ?? ""): boolean {
  return /Mac|iPhone|iPad|iPod/u.test(platform);
}

export function formatKeyboardShortcutParts(
  combo: KeyboardShortcutCombo,
  applePlatform = isApplePlatform(),
): string[] {
  const modifiers: Record<KeyboardShortcutModifier, string> = applePlatform
    ? { mod: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥" }
    : { mod: "Ctrl", ctrl: "Ctrl", shift: "Shift", alt: "Alt" };
  const keys: Partial<Record<KeyboardShortcutKey, string>> = {
    Backquote: "`",
    Comma: ",",
    Enter: applePlatform ? "⏎" : "Enter",
    Escape: applePlatform ? "esc" : "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Click: "Click",
  };
  return [
    ...combo.modifiers.map((modifier) => modifiers[modifier]),
    keys[combo.key] ?? combo.key.toUpperCase(),
  ];
}

export function formatKeyboardShortcutCombo(
  combo: KeyboardShortcutCombo,
  applePlatform = isApplePlatform(),
): string {
  return formatKeyboardShortcutParts(combo, applePlatform).join(applePlatform ? "" : "+");
}

// "mod" = exactly one of Meta/Ctrl, matching the command palette's shipped
// either-modifier behavior; it also makes mod-chords reachable on non-Apple
// platforms where the previously meta-only sidebar/workspace chords were dead.
export function matchesShortcutCombo(combo: KeyboardShortcutCombo, event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) {
    return false;
  }
  const wantsMod = combo.modifiers.includes("mod");
  const wantsCtrl = combo.modifiers.includes("ctrl");
  const primaryModifierMatches = wantsMod
    ? event.metaKey !== event.ctrlKey
    : !event.metaKey && event.ctrlKey === wantsCtrl;
  // "/" and Backquote ignore Shift: some layouts need Shift to produce "/",
  // and the shipped terminal chord accepts Ctrl+Shift+` (layouts where the
  // Backquote key is shifted, e.g. producing ~, must keep working).
  const shiftInsensitiveKey = combo.key === "/" || combo.key === "Backquote";
  if (
    !primaryModifierMatches ||
    event.altKey !== combo.modifiers.includes("alt") ||
    (!shiftInsensitiveKey && event.shiftKey !== combo.modifiers.includes("shift"))
  ) {
    return false;
  }
  if (combo.key === "/") {
    if (event.key === "/" || event.key === "?") {
      return true;
    }
    // Physical fallback only for non-Latin layouts. Latin layouts that put a
    // different printable on the Slash key (German "-") keep that chord's own
    // meaning — Cmd+"-" must stay browser zoom, not open the overview.
    return event.code === "Slash" && !/^[\x20-\x7e]$/u.test(event.key);
  }
  if (combo.key === "Backquote" || combo.key === "Comma") {
    return event.code === combo.key;
  }
  if (
    combo.key === "Enter" ||
    combo.key === "Escape" ||
    combo.key === "ArrowUp" ||
    combo.key === "ArrowDown"
  ) {
    return event.key === combo.key;
  }
  return resolveAsciiShortcutKey(event) === combo.key;
}
