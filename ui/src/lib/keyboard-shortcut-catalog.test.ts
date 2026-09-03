/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { isCommandPaletteShortcut } from "../components/command-palette-contract.ts";
import { isTerminalPanelShortcut } from "../components/panel-toggle-contract.ts";
import { t } from "../i18n/index.ts";
import {
  formatKeyboardShortcutCombo,
  formatKeyboardShortcutParts,
  isApplePlatform,
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
  resolveKeyboardShortcutSections,
} from "./keyboard-shortcut-catalog.ts";

describe("keyboard shortcut catalog matching", () => {
  it.each([
    { name: "Command", modifiers: { metaKey: true } },
    { name: "Control", modifiers: { ctrlKey: true } },
  ])("accepts the $name primary modifier and non-Latin physical letters", ({ modifiers }) => {
    const event = new KeyboardEvent("keydown", { key: "л", code: "KeyK", ...modifiers });

    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette, event)).toBe(true);
    expect(isCommandPaletteShortcut(event)).toBe(true);
  });

  it.each([
    { name: "both primary modifiers", modifiers: { metaKey: true, ctrlKey: true } },
    { name: "an extra Shift modifier", modifiers: { metaKey: true, shiftKey: true } },
    { name: "an extra Alt modifier", modifiers: { ctrlKey: true, altKey: true } },
  ])("rejects $name for an exact primary-modifier chord", ({ modifiers }) => {
    const event = new KeyboardEvent("keydown", { key: "k", code: "KeyK", ...modifiers });

    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette, event)).toBe(false);
    expect(isCommandPaletteShortcut(event)).toBe(false);
  });

  it.each([
    { name: "the slash character", key: "/", code: "Digit7", shiftKey: true },
    { name: "the physical slash key", key: "?", code: "Slash", shiftKey: true },
    { name: "an unshifted slash", key: "/", code: "Slash", shiftKey: false },
    { name: "a non-Latin physical slash key", key: "ظ", code: "Slash", shiftKey: false },
  ])("opens the overview with $name regardless of layout-required Shift", (keyboard) => {
    const event = new KeyboardEvent("keydown", { ...keyboard, ctrlKey: true });

    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.keyboardShortcuts, event)).toBe(true);
  });

  it("leaves Latin layouts that put another printable on the Slash key alone", () => {
    // German: physical Slash produces "-", so Ctrl/Cmd+"-" must stay browser zoom.
    const zoomOut = new KeyboardEvent("keydown", { key: "-", code: "Slash", metaKey: true });

    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.keyboardShortcuts, zoomOut)).toBe(false);
  });

  it("matches physical Backquote and Comma keys independently of their produced characters", () => {
    const terminal = new KeyboardEvent("keydown", {
      key: "ö",
      code: "Backquote",
      ctrlKey: true,
    });
    const appearance = new KeyboardEvent("keydown", {
      key: "<",
      code: "Comma",
      metaKey: true,
      shiftKey: true,
    });

    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.terminalPanel, terminal)).toBe(true);
    expect(isTerminalPanelShortcut(terminal)).toBe(true);
    // Shipped contract: Ctrl+Shift+Backquote still toggles the terminal
    // (layouts where the Backquote key is shifted must keep working).
    expect(
      isTerminalPanelShortcut(
        new KeyboardEvent("keydown", {
          key: "~",
          code: "Backquote",
          ctrlKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(true);
    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.appearanceSettings, appearance)).toBe(
      true,
    );
    expect(
      isTerminalPanelShortcut(
        new KeyboardEvent("keydown", { code: "Backquote", ctrlKey: true, altKey: true }),
      ),
    ).toBe(false);
  });
});

describe("keyboard shortcut catalog presentation", () => {
  it("uses Apple glyph chips and readable non-Apple modifier chips", () => {
    expect(isApplePlatform("MacIntel")).toBe(true);
    expect(isApplePlatform("Linux x86_64")).toBe(false);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.debugOverlay, true)).toEqual([
      "⌘",
      "⇧",
      "D",
    ]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.debugOverlay, false)).toEqual([
      "Ctrl",
      "Shift",
      "D",
    ]);
    expect(formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.terminalPanel, true)).toBe("⌃`");
    expect(formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.approveAlways, false)).toBe(
      "Ctrl+Shift+Enter",
    );
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.escape, true)).toEqual(["esc"]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.historyPrevious, true)).toEqual([
      "↑",
    ]);
    expect(formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSessionSelect, true)).toBe(
      "⌘Click",
    );
    expect(formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.extendSessionSelect, false)).toBe(
      "Shift+Click",
    );
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.zoomIn, false)).toEqual(["+"]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.zoomReset, true)).toEqual(["0"]);
  });

  it("swaps both send-preference chords when the composer preference is modifier-enter", () => {
    const entryCombos = (id: string) =>
      resolveKeyboardShortcutSections("modifier-enter")
        .flatMap((section) => section.entries)
        .find((entry) => entry.id === id)?.combos;

    expect(entryCombos("startNewSession")).toEqual([KEYBOARD_SHORTCUT_COMBOS.modifiedEnter]);
    expect(entryCombos("sendMessage")).toEqual([KEYBOARD_SHORTCUT_COMBOS.modifiedEnter]);
  });

  it("derives the displayed send chord from the composer's active preference", () => {
    const sendEntry = (preference: "enter" | "modifier-enter") =>
      resolveKeyboardShortcutSections(preference)
        .find((section) => section.id === "chat")
        ?.entries.find((entry) => entry.id === "sendMessage");

    expect(sendEntry("enter")?.combos).toEqual([KEYBOARD_SHORTCUT_COMBOS.sendMessage]);
    expect(sendEntry("modifier-enter")?.combos).toEqual([KEYBOARD_SHORTCUT_COMBOS.modifiedEnter]);
  });

  it("gives every section and shortcut a resolvable label and at least one real chord", () => {
    for (const section of resolveKeyboardShortcutSections()) {
      expect(t(section.label), section.label).not.toBe(section.label);
      for (const entry of section.entries) {
        expect(t(entry.label), entry.label).not.toBe(entry.label);
        expect(entry.combos.length, entry.id).toBeGreaterThan(0);
      }
    }
  });
});
