import { describe, expect, it } from "vitest";
import { normalizeModifiers, parseKeyChord, scalePoint } from "./actions.js";

// normalizeKey is internal; exercise it through parseKeyChord's final segment.
const normalizeKey = (input: string) => parseKeyChord(input).key;

describe("cua-computer key normalization", () => {
  it.each([
    ["cmd+shift", ["meta", "shift"]],
    ["Super+Control+Option", ["meta", "ctrl", "alt"]],
    ["win+mod1", ["meta", "alt"]],
  ])("normalizes modifier aliases in %s", (input, expected) => {
    expect(normalizeModifiers(input)).toEqual(expected);
  });

  it.each([
    ["Return", "enter"],
    ["Esc", "escape"],
    ["PgDn", "pagedown"],
    ["Home", "home"],
    ["F12", "f12"],
    ["z", "z"],
    ["Z", "z"],
    ["c", "c"],
  ])("normalizes key %s", (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });

  it.each(["minus", "slash", "equal", "period", "comma", "semicolon"])(
    "rejects punctuation-alias key %s toward the type action",
    (input) => {
      expect(() => normalizeKey(input)).toThrow("COMPUTER_UNSUPPORTED_KEY");
    },
  );

  it("keeps letter keys usable in shortcut chords", () => {
    expect(parseKeyChord("cmd+c")).toEqual({ key: "c", modifiers: ["meta"] });
  });

  // Digits and punctuation are shifted on some keyboard layouts, and cua-driver
  // drops that shift state, so they must be rejected toward the type action
  // rather than silently degraded.
  it.each(["1", "+", "*", ":", "_", "(", ".", "?", "é"])(
    "rejects layout-shifted key %s toward the type action",
    (input) => {
      expect(() => normalizeKey(input)).toThrow("COMPUTER_UNSUPPORTED_KEY");
    },
  );

  it("splits the last chord segment into the key", () => {
    expect(parseKeyChord("cmd+ctrl+Return")).toEqual({
      key: "enter",
      modifiers: ["meta", "ctrl"],
    });
  });

  it.each(["hyper", "ctrl+hyper"])("rejects unknown vocabulary in %s", (input) => {
    const operation = input.includes("+")
      ? () => parseKeyChord(input)
      : () => normalizeModifiers(input);
    expect(operation).toThrow("COMPUTER_UNSUPPORTED_KEY");
  });

  it("keeps rounded coordinates inside the native primary-display bounds", () => {
    expect(
      scalePoint(
        {
          id: "frame",
          nativeWidth: 3840,
          nativeHeight: 2160,
          deliveredWidth: 1920,
          deliveredHeight: 1080,
          geometry: { width: 3840, height: 2160, scaleFactor: 1 },
        },
        1919.9,
        1079.9,
        "click",
      ),
    ).toEqual({ x: 3839, y: 2159 });
  });
});
