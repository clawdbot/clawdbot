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

type KeyboardShortcutEntry = ReturnType<typeof keyboardShortcutEntry>;
type KeyboardShortcutSection = ReturnType<typeof keyboardShortcutSection>;

function keyboardShortcutEntry(id: string, ...combos: readonly KeyboardShortcutCombo[]) {
  return { id, label: `shortcutsOverlay.labels.${id}`, combos } as const;
}

function keyboardShortcutSection(id: string, entries: readonly KeyboardShortcutEntry[]) {
  return { id, label: `shortcutsOverlay.sections.${id}`, entries } as const;
}

const KEYBOARD_SHORTCUT_SECTIONS = [
  keyboardShortcutSection("general", [
    keyboardShortcutEntry("commandPalette", KEYBOARD_SHORTCUT_COMBOS.commandPalette),
    keyboardShortcutEntry("keyboardShortcuts", KEYBOARD_SHORTCUT_COMBOS.keyboardShortcuts),
    keyboardShortcutEntry("toggleSidebar", KEYBOARD_SHORTCUT_COMBOS.toggleSidebar),
    keyboardShortcutEntry("debugOverlay", KEYBOARD_SHORTCUT_COMBOS.debugOverlay),
    keyboardShortcutEntry("appearanceSettings", KEYBOARD_SHORTCUT_COMBOS.appearanceSettings),
    keyboardShortcutEntry("startNewSession", KEYBOARD_SHORTCUT_COMBOS.sendMessage),
    keyboardShortcutEntry("closeDialog", KEYBOARD_SHORTCUT_COMBOS.escape),
  ]),
  keyboardShortcutSection("chat", [
    keyboardShortcutEntry("sendMessage", KEYBOARD_SHORTCUT_COMBOS.sendMessage),
    keyboardShortcutEntry("newline", KEYBOARD_SHORTCUT_COMBOS.newline),
    keyboardShortcutEntry("steerImmediately", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter),
    keyboardShortcutEntry(
      "historyRecall",
      KEYBOARD_SHORTCUT_COMBOS.historyPrevious,
      KEYBOARD_SHORTCUT_COMBOS.historyNext,
    ),
    keyboardShortcutEntry("transcriptSearch", KEYBOARD_SHORTCUT_COMBOS.transcriptSearch),
    keyboardShortcutEntry("clearReply", KEYBOARD_SHORTCUT_COMBOS.escape),
    keyboardShortcutEntry("stopResponse", KEYBOARD_SHORTCUT_COMBOS.escape),
    keyboardShortcutEntry("cancelDictation", KEYBOARD_SHORTCUT_COMBOS.escape),
    keyboardShortcutEntry("saveQueuedMessage", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter),
  ]),
  keyboardShortcutSection("panels", [
    keyboardShortcutEntry("terminalPanel", KEYBOARD_SHORTCUT_COMBOS.terminalPanel),
    keyboardShortcutEntry("homePanel", KEYBOARD_SHORTCUT_COMBOS.homePanel),
    keyboardShortcutEntry("workspaceFiles", KEYBOARD_SHORTCUT_COMBOS.workspaceFiles),
    keyboardShortcutEntry("sideChat", KEYBOARD_SHORTCUT_COMBOS.sideChat),
    keyboardShortcutEntry("browserPanel", KEYBOARD_SHORTCUT_COMBOS.browserPanel),
    keyboardShortcutEntry("tasksPanel", KEYBOARD_SHORTCUT_COMBOS.tasksPanel),
    keyboardShortcutEntry("desktopPanel", KEYBOARD_SHORTCUT_COMBOS.desktopPanel),
    keyboardShortcutEntry("discussionPanel", KEYBOARD_SHORTCUT_COMBOS.discussionPanel),
    keyboardShortcutEntry("dashboardPanel", KEYBOARD_SHORTCUT_COMBOS.dashboardPanel),
    keyboardShortcutEntry("reviewPanel", KEYBOARD_SHORTCUT_COMBOS.reviewPanel),
  ]),
  keyboardShortcutSection("sidebar", [
    keyboardShortcutEntry("toggleSessionSelect", KEYBOARD_SHORTCUT_COMBOS.toggleSessionSelect),
    keyboardShortcutEntry("extendSessionSelect", KEYBOARD_SHORTCUT_COMBOS.extendSessionSelect),
  ]),
  keyboardShortcutSection("imageViewer", [
    keyboardShortcutEntry("zoomIn", KEYBOARD_SHORTCUT_COMBOS.zoomIn),
    keyboardShortcutEntry("zoomOut", KEYBOARD_SHORTCUT_COMBOS.zoomOut),
    keyboardShortcutEntry("zoomReset", KEYBOARD_SHORTCUT_COMBOS.zoomReset),
  ]),
  keyboardShortcutSection("approvals", [
    keyboardShortcutEntry("approveOnce", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter),
    keyboardShortcutEntry("approveAlways", KEYBOARD_SHORTCUT_COMBOS.approveAlways),
    keyboardShortcutEntry("denyApproval", KEYBOARD_SHORTCUT_COMBOS.denyApproval),
  ]),
] as const satisfies readonly KeyboardShortcutSection[];

// Both the chat composer and the new-session page submit on the same
// chatSendShortcut preference, so their displayed chords swap together.
const SEND_PREFERENCE_ENTRY_IDS = new Set(["sendMessage", "startNewSession"]);

export function resolveKeyboardShortcutSections(
  sendShortcut: "enter" | "modifier-enter" = "enter",
): readonly KeyboardShortcutSection[] {
  if (sendShortcut !== "modifier-enter") {
    return KEYBOARD_SHORTCUT_SECTIONS;
  }
  return KEYBOARD_SHORTCUT_SECTIONS.map((section) =>
    keyboardShortcutSection(
      section.id,
      section.entries.map((entry) =>
        SEND_PREFERENCE_ENTRY_IDS.has(entry.id)
          ? keyboardShortcutEntry(entry.id, KEYBOARD_SHORTCUT_COMBOS.modifiedEnter)
          : entry,
      ),
    ),
  );
}
