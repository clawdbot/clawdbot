import {
  KEYBOARD_SHORTCUT_COMBOS,
  type KeyboardShortcutCombo,
} from "./keyboard-shortcut-contract.ts";

export {
  formatKeyboardShortcutCombo,
  formatKeyboardShortcutParts,
  isApplePlatform,
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "./keyboard-shortcut-contract.ts";

type KeyboardShortcutEntry = {
  readonly id: string;
  readonly label: string;
  readonly combos: readonly KeyboardShortcutCombo[];
};

type KeyboardShortcutSection = {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly KeyboardShortcutEntry[];
};

function keyboardShortcutEntry(
  id: string,
  ...combos: KeyboardShortcutCombo[]
): KeyboardShortcutEntry {
  return { id, label: `shortcutsOverlay.labels.${id}`, combos };
}

function keyboardShortcutSection(
  id: string,
  entries: readonly KeyboardShortcutEntry[],
): KeyboardShortcutSection {
  return { id, label: `shortcutsOverlay.sections.${id}`, entries };
}

const KEYBOARD_SHORTCUT_SECTIONS = [
  keyboardShortcutSection("general", [
    keyboardShortcutEntry("commandPalette", KEYBOARD_SHORTCUT_COMBOS.commandPalette),
    keyboardShortcutEntry("keyboardShortcuts", KEYBOARD_SHORTCUT_COMBOS.keyboardShortcuts),
    keyboardShortcutEntry("toggleSidebar", KEYBOARD_SHORTCUT_COMBOS.toggleSidebar),
    keyboardShortcutEntry("debugOverlay", KEYBOARD_SHORTCUT_COMBOS.debugOverlay),
    keyboardShortcutEntry("appearanceSettings", KEYBOARD_SHORTCUT_COMBOS.appearanceSettings),
    keyboardShortcutEntry("closeDialog", KEYBOARD_SHORTCUT_COMBOS.escape),
  ]),
  keyboardShortcutSection("chat", [
    keyboardShortcutEntry("sendMessage", KEYBOARD_SHORTCUT_COMBOS.sendMessage),
    keyboardShortcutEntry("newline", KEYBOARD_SHORTCUT_COMBOS.newline),
    keyboardShortcutEntry("steerImmediately", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter),
    keyboardShortcutEntry("transcriptSearch", KEYBOARD_SHORTCUT_COMBOS.transcriptSearch),
    keyboardShortcutEntry("clearReply", KEYBOARD_SHORTCUT_COMBOS.escape),
    keyboardShortcutEntry("stopResponse", KEYBOARD_SHORTCUT_COMBOS.escape),
    keyboardShortcutEntry("saveQueuedMessage", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter),
  ]),
  keyboardShortcutSection("panels", [
    keyboardShortcutEntry("terminalPanel", KEYBOARD_SHORTCUT_COMBOS.terminalPanel),
    keyboardShortcutEntry("workspaceFiles", KEYBOARD_SHORTCUT_COMBOS.workspaceFiles),
  ]),
  keyboardShortcutSection("approvals", [
    keyboardShortcutEntry("approveOnce", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter),
    keyboardShortcutEntry("approveAlways", KEYBOARD_SHORTCUT_COMBOS.approveAlways),
    keyboardShortcutEntry("denyApproval", KEYBOARD_SHORTCUT_COMBOS.denyApproval),
  ]),
] as const satisfies readonly KeyboardShortcutSection[];

export function resolveKeyboardShortcutSections(
  sendShortcut: "enter" | "modifier-enter" = "enter",
): readonly KeyboardShortcutSection[] {
  if (sendShortcut !== "modifier-enter") {
    return KEYBOARD_SHORTCUT_SECTIONS;
  }
  return KEYBOARD_SHORTCUT_SECTIONS.map((section) =>
    section.id !== "chat"
      ? section
      : keyboardShortcutSection(
          "chat",
          section.entries.map((entry) =>
            entry.id === "sendMessage"
              ? keyboardShortcutEntry("sendMessage", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter)
              : entry,
          ),
        ),
  );
}
