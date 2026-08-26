// Control UI module implements theme behavior.
export type ThemeName = "claw" | "knot" | "dash" | "absolutely" | "custom";
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme =
  | "dark"
  | "light"
  | "openknot"
  | "openknot-light"
  | "dash"
  | "dash-light"
  | "absolutely"
  | "absolutely-light"
  | "custom"
  | "custom-light";

const VALID_THEME_NAMES = new Set<ThemeName>(["claw", "knot", "dash", "absolutely", "custom"]);

const THEME_FONT_STYLESHEET_ID = "openclaw-theme-fonts";
/* Themes that ship their own faces. The stylesheet is fetched only while such a
   theme is active, so every other theme pays nothing for fonts it never paints.
   Loading with the app bundle (not the first-paint boot script) costs one
   font-display: swap on a cold load and keeps the theme->asset mapping in one
   place. */
const THEME_FONT_STYLESHEETS: Partial<Record<ThemeName, string>> = {
  absolutely: "/fonts/absolutely.css",
};
const VALID_THEME_MODES = new Set<ThemeMode>(["system", "light", "dark"]);

function prefersLightScheme(): boolean {
  if (typeof globalThis.matchMedia !== "function") {
    return false;
  }
  return globalThis.matchMedia("(prefers-color-scheme: light)").matches;
}

export function parseThemeSelection(
  themeRaw: unknown,
  modeRaw: unknown,
): { theme: ThemeName; mode: ThemeMode } {
  const theme = typeof themeRaw === "string" ? themeRaw : "";
  const mode = typeof modeRaw === "string" ? modeRaw : "";

  const normalizedTheme = VALID_THEME_NAMES.has(theme as ThemeName) ? (theme as ThemeName) : "claw";
  const normalizedMode = VALID_THEME_MODES.has(mode as ThemeMode) ? (mode as ThemeMode) : "system";

  return { theme: normalizedTheme, mode: normalizedMode };
}

function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return prefersLightScheme() ? "light" : "dark";
  }
  return mode;
}

export function resolveTheme(theme: ThemeName, mode: ThemeMode): ResolvedTheme {
  const resolvedMode = resolveMode(mode);
  if (theme === "claw") {
    return resolvedMode === "light" ? "light" : "dark";
  }
  if (theme === "knot") {
    return resolvedMode === "light" ? "openknot-light" : "openknot";
  }
  if (theme === "dash") {
    return resolvedMode === "light" ? "dash-light" : "dash";
  }
  if (theme === "absolutely") {
    return resolvedMode === "light" ? "absolutely-light" : "absolutely";
  }
  return resolvedMode === "light" ? "custom-light" : "custom";
}

/** Loads (or drops) the webfont stylesheet a theme declares. Idempotent. */
export function syncThemeFontStylesheet(theme: ThemeName): void {
  if (typeof document === "undefined") {
    return;
  }
  const href = THEME_FONT_STYLESHEETS[theme];
  const existing = document.getElementById(THEME_FONT_STYLESHEET_ID);
  if (!href) {
    existing?.remove();
    return;
  }
  if (existing instanceof HTMLLinkElement) {
    if (!existing.href.endsWith(href)) {
      existing.href = href;
    }
    return;
  }
  const link = document.createElement("link");
  link.id = THEME_FONT_STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}
