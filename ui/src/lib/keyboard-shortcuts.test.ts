/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { resolveAsciiShortcutKey } from "./keyboard-shortcuts.ts";

describe("resolveAsciiShortcutKey", () => {
  it("prefers the produced ASCII character for alternate Latin layouts", () => {
    const event = new KeyboardEvent("keydown", { key: "k", code: "KeyV" });

    expect(resolveAsciiShortcutKey(event)).toBe("k");
  });

  it("falls back to physical letters and digits for non-Latin layouts", () => {
    const letter = new KeyboardEvent("keydown", { key: "л", code: "KeyK" });
    const digit = new KeyboardEvent("keydown", { key: "٢", code: "Digit2" });

    expect(resolveAsciiShortcutKey(letter)).toBe("k");
    expect(resolveAsciiShortcutKey(digit)).toBe("2");
  });

  it("ignores composition, modified symbols, and non-printable keys", () => {
    const composing = new KeyboardEvent("keydown", {
      key: "Process",
      code: "KeyK",
      isComposing: true,
    });
    const shiftedDigit = new KeyboardEvent("keydown", {
      key: "@",
      code: "Digit2",
      shiftKey: true,
    });
    const optionSymbol = new KeyboardEvent("keydown", {
      key: "∂",
      code: "KeyD",
      altKey: true,
    });
    const deadKey = new KeyboardEvent("keydown", { key: "Dead", code: "KeyE" });
    const navigationKey = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      code: "KeyK",
    });

    expect(resolveAsciiShortcutKey(composing)).toBeNull();
    expect(resolveAsciiShortcutKey(shiftedDigit)).toBeNull();
    expect(resolveAsciiShortcutKey(optionSymbol)).toBeNull();
    expect(resolveAsciiShortcutKey(deadKey)).toBeNull();
    expect(resolveAsciiShortcutKey(navigationKey)).toBeNull();
  });
});
