// TUI theme tests cover theme defaults and environment-driven variants.

import { expectDefined } from "@openclaw/normalization-core";
import chalk from "chalk";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const originalChalkLevel = chalk.level;
chalk.level = 3;

const { markdownTheme, searchableSelectListTheme, selectListTheme, theme } =
  await import("./theme.js");

const stripAnsi = (str: string) =>
  str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

let themeImportCase = 0;
const originalEnv = { ...process.env };

afterAll(() => {
  chalk.level = originalChalkLevel;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

type ThemeEnvOverrides = {
  OPENCLAW_THEME?: string | undefined;
  COLORFGBG?: string | undefined;
};

type ThemeModule = typeof import("./theme.js");
const ansiRgbPattern = new RegExp(
  `${String.fromCharCode(27)}\\[(38|48);2;(\\d+);(\\d+);(\\d+)m`,
  "u",
);

function colorFromStyle(style: (text: string) => string, layer: 38 | 48): string {
  const match = style("x").match(ansiRgbPattern);
  if (!match || Number(match[1]) !== layer) {
    throw new Error(`expected ${layer === 38 ? "foreground" : "background"} RGB style`);
  }
  return `#${match
    .slice(2, 5)
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

function readActivePalette(mod: ThemeModule) {
  return {
    text: colorFromStyle(mod.theme.fg, 38),
    dim: colorFromStyle(mod.theme.dim, 38),
    accent: colorFromStyle(mod.theme.accent, 38),
    accentSoft: colorFromStyle(mod.theme.accentSoft, 38),
    border: colorFromStyle(mod.theme.border, 38),
    userBg: colorFromStyle(mod.theme.userBg, 48),
    userText: colorFromStyle(mod.theme.userText, 38),
    systemText: colorFromStyle(mod.theme.system, 38),
    toolPendingBg: colorFromStyle(mod.theme.toolPendingBg, 48),
    toolSuccessBg: colorFromStyle(mod.theme.toolSuccessBg, 48),
    toolErrorBg: colorFromStyle(mod.theme.toolErrorBg, 48),
    toolTitle: colorFromStyle(mod.theme.toolTitle, 38),
    toolOutput: colorFromStyle(mod.theme.toolOutput, 38),
    quote: colorFromStyle(mod.markdownTheme.quote, 38),
    quoteBorder: colorFromStyle(mod.markdownTheme.quoteBorder, 38),
    code: colorFromStyle(mod.markdownTheme.code, 38),
    codeBorder: colorFromStyle(mod.markdownTheme.codeBlockBorder, 38),
    link: colorFromStyle(mod.markdownTheme.link, 38),
    error: colorFromStyle(mod.theme.error, 38),
    success: colorFromStyle(mod.theme.success, 38),
  };
}

async function importThemeWithEnv(env: ThemeEnvOverrides) {
  if (Object.hasOwn(env, "OPENCLAW_THEME")) {
    if (env.OPENCLAW_THEME === undefined) {
      delete process.env.OPENCLAW_THEME;
    } else {
      process.env.OPENCLAW_THEME = env.OPENCLAW_THEME;
    }
  }
  if (Object.hasOwn(env, "COLORFGBG")) {
    if (env.COLORFGBG === undefined) {
      delete process.env.COLORFGBG;
    } else {
      process.env.COLORFGBG = env.COLORFGBG;
    }
  }
  const mod = await importFreshModule<ThemeModule>(
    import.meta.url,
    `./theme.js?env=${++themeImportCase}`,
  );
  const lightPalette = readActivePalette(mod);
  return {
    ...mod,
    lightMode: lightPalette.text === "#1E1E1E",
    lightPalette,
  };
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)
    ?.map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  if (!channels || channels.length !== 3) {
    throw new Error(`invalid color: ${hex}`);
  }
  return (
    0.2126 * expectDefined(channels[0], "channels[0] test invariant") +
    0.7152 * expectDefined(channels[1], "channels[1] test invariant") +
    0.0722 * expectDefined(channels[2], "channels[2] test invariant")
  );
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].toSorted(
    (a, b) => b - a,
  );
  return (
    (expectDefined(lighter, "lighter test invariant") + 0.05) /
    (expectDefined(darker, "darker test invariant") + 0.05)
  );
}

describe("markdownTheme", () => {
  describe("highlightCode", () => {
    it("renders code blocks with the theme code color and preserves lines", () => {
      const result = markdownTheme.highlightCode!(`echo "hello"`, "not-a-real-language");
      expect(stripAnsi(result[0] ?? "")).toContain("echo");
    });

    it("preserves multi-line code blocks", () => {
      const result = markdownTheme.highlightCode!("line-1\nline-2", "javascript");
      expect(result.map((line) => stripAnsi(line))).toEqual(["line-1", "line-2"]);
    });
  });
});

describe("theme", () => {
  it("keeps assistant text in terminal default foreground", () => {
    expect(theme.assistantText("hello")).toBe("hello");
    expect(stripAnsi(theme.assistantText("hello"))).toBe("hello");
  });
});

describe("light background detection", () => {
  it("uses dark palette by default", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: undefined,
    });
    expect(mod.lightMode).toBe(false);
  });

  it("selects light palette when OPENCLAW_THEME=light", async () => {
    const mod = await importThemeWithEnv({ OPENCLAW_THEME: "light" });
    expect(mod.lightMode).toBe(true);
  });

  it("selects dark palette when OPENCLAW_THEME=dark", async () => {
    const mod = await importThemeWithEnv({ OPENCLAW_THEME: "dark" });
    expect(mod.lightMode).toBe(false);
  });

  it("treats OPENCLAW_THEME case-insensitively", async () => {
    const mod = await importThemeWithEnv({ OPENCLAW_THEME: "LiGhT" });
    expect(mod.lightMode).toBe(true);
  });

  it("detects light background from COLORFGBG", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "0;15",
    });
    expect(mod.lightMode).toBe(true);
  });

  it("treats COLORFGBG bg=7 (silver) as light", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "0;7",
    });
    expect(mod.lightMode).toBe(true);
  });

  it("treats COLORFGBG bg=8 (bright black / dark gray) as dark", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "15;8",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("treats COLORFGBG bg < 7 as dark", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "15;0",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("treats 256-color COLORFGBG bg=232 (near-black greyscale) as dark", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "15;232",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("treats 256-color COLORFGBG bg=255 (near-white greyscale) as light", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "0;255",
    });
    expect(mod.lightMode).toBe(true);
  });

  it("treats 256-color COLORFGBG bg=231 (white cube entry) as light", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "0;231",
    });
    expect(mod.lightMode).toBe(true);
  });

  it("treats 256-color COLORFGBG bg=16 (black cube entry) as dark", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "15;16",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("treats bright 256-color green backgrounds as light when dark text contrasts better", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "15;34",
    });
    expect(mod.lightMode).toBe(true);
  });

  it("treats bright 256-color cyan backgrounds as light when dark text contrasts better", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "15;39",
    });
    expect(mod.lightMode).toBe(true);
  });

  it("falls back to dark mode for invalid COLORFGBG values", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "garbage",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("ignores pathological COLORFGBG values", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "0;".repeat(40),
    });
    expect(mod.lightMode).toBe(false);
  });

  it("OPENCLAW_THEME overrides COLORFGBG", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: "dark",
      COLORFGBG: "0;15",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("keeps assistantText as identity in both modes", async () => {
    const lightMod = await importThemeWithEnv({ OPENCLAW_THEME: "light" });
    const darkMod = await importThemeWithEnv({ OPENCLAW_THEME: "dark" });
    expect(lightMod.theme.assistantText("hello")).toBe("hello");
    expect(darkMod.theme.assistantText("hello")).toBe("hello");
  });
});

describe("light palette accessibility", () => {
  it("keeps light theme text colors at WCAG AA contrast or better", async () => {
    const mod = await importThemeWithEnv({ OPENCLAW_THEME: "light" });
    const backgrounds = {
      page: "#FFFFFF",
      user: mod.lightPalette.userBg,
      pending: mod.lightPalette.toolPendingBg,
      success: mod.lightPalette.toolSuccessBg,
      error: mod.lightPalette.toolErrorBg,
      code: "#FFFFFF",
    };

    const textPairs = [
      [mod.lightPalette.text, backgrounds.page],
      [mod.lightPalette.dim, backgrounds.page],
      [mod.lightPalette.accent, backgrounds.page],
      [mod.lightPalette.accentSoft, backgrounds.page],
      [mod.lightPalette.systemText, backgrounds.page],
      [mod.lightPalette.link, backgrounds.page],
      [mod.lightPalette.quote, backgrounds.page],
      [mod.lightPalette.error, backgrounds.page],
      [mod.lightPalette.success, backgrounds.page],
      [mod.lightPalette.userText, backgrounds.user],
      [mod.lightPalette.dim, backgrounds.pending],
      [mod.lightPalette.dim, backgrounds.success],
      [mod.lightPalette.dim, backgrounds.error],
      [mod.lightPalette.toolTitle, backgrounds.pending],
      [mod.lightPalette.toolTitle, backgrounds.success],
      [mod.lightPalette.toolTitle, backgrounds.error],
      [mod.lightPalette.toolOutput, backgrounds.pending],
      [mod.lightPalette.toolOutput, backgrounds.success],
      [mod.lightPalette.toolOutput, backgrounds.error],
      [mod.lightPalette.code, backgrounds.code],
      [mod.lightPalette.border, backgrounds.page],
      [mod.lightPalette.quoteBorder, backgrounds.page],
      [mod.lightPalette.codeBorder, backgrounds.page],
    ] as const;

    for (const [foreground, background] of textPairs) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("list themes", () => {
  it("reuses shared select-list styles in searchable list theme", () => {
    expect(searchableSelectListTheme.selectedPrefix(">")).toBe(selectListTheme.selectedPrefix(">"));
    expect(searchableSelectListTheme.selectedText("entry")).toBe(
      selectListTheme.selectedText("entry"),
    );
    expect(searchableSelectListTheme.description("desc")).toBe(selectListTheme.description("desc"));
    expect(searchableSelectListTheme.scrollInfo("scroll")).toBe(
      selectListTheme.scrollInfo("scroll"),
    );
    expect(searchableSelectListTheme.noMatch("none")).toBe(selectListTheme.noMatch("none"));
  });

  it("keeps searchable list specific renderers readable", () => {
    expect(stripAnsi(searchableSelectListTheme.searchPrompt("Search:"))).toBe("Search:");
    expect(stripAnsi(searchableSelectListTheme.searchInput("query"))).toBe("query");
    expect(stripAnsi(searchableSelectListTheme.matchHighlight("match"))).toBe("match");
  });
});
