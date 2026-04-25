import { afterEach, describe, expect, it, vi } from "vitest";

const { markdownTheme, searchableSelectListTheme, selectListTheme, theme } =
  await import("./theme.js");

const stripAnsi = (str: string) =>
  str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)
    ?.map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  if (!channels || channels.length !== 3) {
    throw new Error(`invalid color: ${hex}`);
  }
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].toSorted(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
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
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function importThemeWithEnv(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return import("./theme.js");
  }

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
    vi.resetModules();
    process.env.OPENCLAW_THEME = "light";
    const mod = await import("./theme.js");
    const backgrounds = {
      page: "#FFFFFF",
      user: mod.lightPalette.userBg,
      pending: mod.lightPalette.toolPendingBg,
      success: mod.lightPalette.toolSuccessBg,
      error: mod.lightPalette.toolErrorBg,
      code: mod.lightPalette.codeBlock,
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
