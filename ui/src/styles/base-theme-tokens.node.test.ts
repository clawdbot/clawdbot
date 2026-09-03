// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrcDir = path.dirname(stylesDir);
// Every alias name this bug class has produced so far, mapped to the canonical
// token. Undefined names silently drop declarations (or invalidate color-mix),
// so new aliases must be added to base.css, never invented at use sites.
const undefinedTokenMappings = {
  "bg-subtle": "bg-muted",
  "border-subtle": "border",
  fg: "text",
  // Font aliases arrive from surfaces that publish their own token names
  // (canvas widgets, the MCP Apps spec keys in mcp-app-theme.ts); inside
  // Control UI only --mono and --font-body exist.
  "font-mono": "mono",
  "font-sans": "font-body",
  foreground: "text",
  "panel-2": "panel-strong",
  success: "ok",
  surface: "panel",
  "text-muted": "muted",
  warning: "warn",
  "warning-subtle": "warn-subtle",
} as const;

function collectFiles(directory: string, extensions: readonly string[]): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : collectFiles(entryPath, extensions);
    }
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))
      ? [entryPath]
      : [];
  });
}

describe("Control UI base theme tokens", () => {
  it("defines every canonical replacement", () => {
    const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");

    for (const token of new Set(Object.values(undefinedTokenMappings))) {
      expect(baseCss, `missing --${token} in base.css`).toMatch(
        new RegExp(`^\\s*--${token}\\s*:`, "mu"),
      );
    }
  });

  it("does not reference undefined theme token names", () => {
    const undefinedTokens = Object.keys(undefinedTokenMappings);
    const referencePattern = new RegExp(
      `var\\(--(?:${undefinedTokens.join("|")})(?:\\s*\\)|\\s*,)`,
      "u",
    );
    // Inline style attributes and Lit css templates hit this class too
    // (var(--panel-2) shipped in a TS template), so scan all of ui/src.
    const violations = collectFiles(uiSrcDir, [".css", ".ts"])
      .filter((filePath) => !filePath.endsWith(".test.ts"))
      .flatMap((filePath) =>
        fs
          .readFileSync(filePath, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            referencePattern.test(line)
              ? [`${path.relative(uiSrcDir, filePath)}:${index + 1}: ${line.trim()}`]
              : [],
          ),
      );

    expect(violations).toEqual([]);
  });

  it("routes every Web Awesome switch through the shared accent", () => {
    const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");
    const localOverrides = collectFiles(stylesDir, [".css"])
      .filter((filePath) => !filePath.endsWith("base.css"))
      .filter((filePath) =>
        /[^{}]*wa-switch[^{}]*\{[^}]*--wa-form-control-activated-color:/su.test(
          fs.readFileSync(filePath, "utf8"),
        ),
      )
      .map((filePath) => path.relative(stylesDir, filePath));

    expect(baseCss).toMatch(
      /wa-switch\s*\{[^}]*--wa-form-control-activated-color:\s*var\(--accent\);[^}]*\}/su,
    );
    expect(localOverrides).toEqual([]);
  });
});

/*
 * --bg is mirrored by hand in two places outside base.css, because both must
 * paint before the app stylesheet is parsed or the picker would advertise a
 * colour the theme no longer uses:
 *   - index.html's pre-paint block, which fills the page during first paint
 *   - the Appearance preview chips in config.css, which are theme-invariant and
 *     so cannot read the live token
 * Nothing tied those copies to the palette, and every review pass on the theme
 * work turned up another hand-maintained list that had drifted. Darkening
 * Absolutely moved --bg and silently left both copies behind until a pre-paint
 * assertion caught one of them. This derives the expected values from base.css
 * so a palette edit cannot leave either copy stale again.
 */
describe("Control UI theme --bg mirrors", () => {
  const RESOLVED_THEME_BG_SELECTOR = new Map<string, string>([
    ["dark", ":root"],
    ["light", ':root:where([data-theme-mode="light"])'],
  ]);

  function readBlockToken(css: string, selector: string, token: string): string | undefined {
    const body = css.split(new RegExp(`${escapeSelector(selector)}\\s*\\{`, "u"))[1]?.split("}")[0];
    return body?.match(new RegExp(`${token}:\\s*([^;]+);`, "u"))?.[1]?.trim();
  }

  function escapeSelector(selector: string): string {
    return selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  }

  /** Every theme's canonical --bg, keyed by the resolved data-theme value. */
  function readCanonicalBackgrounds(): Map<string, string> {
    // Palettes other than the default now live in public/themes; the mirrors
    // must track them there too.
    const themesDir = path.join(stylesDir, "..", "..", "public", "themes");
    const baseCss = [
      fs.readFileSync(path.join(stylesDir, "base.css"), "utf8"),
      ...fs
        .readdirSync(themesDir)
        .filter((entry) => entry.endsWith(".css"))
        .toSorted()
        .map((entry) => fs.readFileSync(path.join(themesDir, entry), "utf8")),
    ].join("\n");
    const backgrounds = new Map<string, string>();
    for (const [resolved, selector] of RESOLVED_THEME_BG_SELECTOR) {
      const value = readBlockToken(baseCss, selector, "--bg");
      if (value) {
        backgrounds.set(resolved, value);
      }
    }
    for (const match of baseCss.matchAll(/:root\[data-theme="([^"]+)"\]\s*\{/gu)) {
      const resolved = match[1] ?? "";
      const value = readBlockToken(baseCss, `:root[data-theme="${resolved}"]`, "--bg");
      if (value) {
        backgrounds.set(resolved, value);
      }
    }
    return backgrounds;
  }

  it("keeps the index.html pre-paint background on every theme's --bg", () => {
    const indexHtml = fs.readFileSync(path.join(uiSrcDir, "..", "index.html"), "utf8");
    const canonical = readCanonicalBackgrounds();
    const mismatches: string[] = [];
    let checked = 0;

    const prePaint = new Map<string, string>();
    for (const match of indexHtml.matchAll(
      /html(?:\[data-theme(?:-mode)?="([^"]+)"\])?\s*\{\s*background:\s*([^;]+);/gu,
    )) {
      const attribute = match[1];
      const value = (match[2] ?? "").trim();
      // Bare `html` is the default dark paint; the -mode selector is light.
      prePaint.set(attribute ?? "dark", value);
    }

    for (const [resolved, background] of canonical) {
      const painted = prePaint.get(resolved);
      if (painted === undefined) {
        mismatches.push(`${resolved}: no pre-paint background in index.html`);
        continue;
      }
      checked += 1;
      if (painted.toLowerCase() !== background.toLowerCase()) {
        mismatches.push(`${resolved}: pre-paint ${painted} != --bg ${background}`);
      }
    }

    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(RESOLVED_THEME_BG_SELECTOR.size);
  });

  it("keeps the Appearance preview chips on every theme's --bg", () => {
    const configCss = fs.readFileSync(path.join(stylesDir, "config.css"), "utf8");
    const canonical = readCanonicalBackgrounds();
    const mismatches: string[] = [];
    let checked = 0;

    for (const match of configCss.matchAll(/\.settings-theme-card--([\w-]+)[^{]*\{([^}]*)\}/gu)) {
      const family = match[1] ?? "";
      const body = match[2] ?? "";
      const chip = body.match(/--theme-chip-bg:\s*([^;]+);/u)?.[1]?.trim();
      if (!chip || chip.startsWith("var(")) {
        continue;
      }
      // Light chip rules are nested under the light-mode selector, so the
      // preceding text decides which resolved palette this chip mirrors.
      const isLight = configCss
        .slice(0, match.index ?? 0)
        .split(".settings-theme-card--")
        .at(-1)
        ?.includes('data-theme-mode="light"');
      const resolved = resolveFamily(family, isLight === true);
      const background = canonical.get(resolved);
      if (!background) {
        continue;
      }
      checked += 1;
      if (chip.toLowerCase() !== background.toLowerCase()) {
        mismatches.push(`${resolved}: chip ${chip} != --bg ${background}`);
      }
    }

    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });

  /** Appearance uses theme family names; base.css keys off resolved values. */
  function resolveFamily(family: string, light: boolean): string {
    if (family === "claw") {
      return light ? "light" : "dark";
    }
    if (family === "knot") {
      return light ? "openknot-light" : "openknot";
    }
    return light ? `${family}-light` : family;
  }
});
