import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../../test/helpers/temp-dir.js";
import darkTheme from "./dark.json" with { type: "json" };
import { loadThemeFromPath } from "./theme.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function loadColor(color: string | number, mode: "256color" | "truecolor") {
  const themePath = join(tempDirs.make("openclaw-theme-"), "theme.json");
  writeFileSync(
    themePath,
    JSON.stringify({
      ...darkTheme,
      colors: { ...darkTheme.colors, accent: color, selectedBg: color },
    }),
  );
  return loadThemeFromPath(themePath, mode);
}

describe("loadThemeFromPath", () => {
  it.each([
    ["#0000ff", 21],
    ["#2f00ff", 21],
    ["#3000ff", 57],
    ["#7200ff", 57],
    ["#7300ff", 57],
    ["#7400ff", 93],
    ["#9a00ff", 93],
    ["#9b00ff", 93],
    ["#9c00ff", 129],
    ["#c200ff", 129],
    ["#c300ff", 129],
    ["#c400ff", 165],
    ["#ea00ff", 165],
    ["#eb00ff", 165],
    ["#ec00ff", 201],
    ["#ff00ff", 201],
    ["#ff7200", 202],
    ["#ff7300", 202],
    ["#ff7400", 208],
    ["#00ff72", 47],
    ["#00ff73", 47],
    ["#00ff74", 48],
    ["#5f87af", 67],
    ["#000000", 16],
    ["#040404", 16],
    ["#050505", 232],
    ["#080808", 232],
    ["#0c0c0c", 232],
    ["#0d0d0d", 232],
    ["#0e0e0e", 233],
    ["#707070", 242],
    ["#717171", 242],
    ["#727272", 243],
    ["#e8e8e8", 254],
    ["#e9e9e9", 254],
    ["#eaeaea", 255],
    ["#eeeeee", 255],
    ["#ffffff", 231],
    ["#606060", 59],
    ["#616161", 241],
    ["#0c0d0e", 232],
    ["#0d0d16", 233],
    ["#0d0d17", 16],
  ])(
    "renders %s as palette index %i with separate foreground/background resets",
    (color, index) => {
      const theme = loadColor(color, "256color");
      expect(theme.fg("accent", "text")).toBe(`\x1b[38;5;${index}mtext\x1b[39m`);
      expect(theme.bg("selectedBg", "text")).toBe(`\x1b[48;5;${index}mtext\x1b[49m`);
    },
  );

  it("preserves RGB channels in truecolor output", () => {
    const theme = loadColor("#5f87af", "truecolor");
    expect(theme.fg("accent", "text")).toBe("\x1b[38;2;95;135;175mtext\x1b[39m");
    expect(theme.bg("selectedBg", "text")).toBe("\x1b[48;2;95;135;175mtext\x1b[49m");
  });

  it.each(["256color", "truecolor"] as const)(
    "preserves numeric and reset colors in %s",
    (mode) => {
      for (const index of [0, 123, 255]) {
        const theme = loadColor(index, mode);
        expect(theme.fg("accent", "text")).toBe(`\x1b[38;5;${index}mtext\x1b[39m`);
        expect(theme.bg("selectedBg", "text")).toBe(`\x1b[48;5;${index}mtext\x1b[49m`);
      }
      const reset = loadColor("", mode);
      expect(reset.fg("accent", "text")).toBe("\x1b[39mtext\x1b[39m");
      expect(reset.bg("selectedBg", "text")).toBe("\x1b[49mtext\x1b[49m");
    },
  );
});
