// Control UI module implements theme behavior.
import { inferControlUiPublicAssetPath } from "./public-assets.ts";
export type ThemeName =
  | "claw"
  | "knot"
  | "dash"
  | "absolutely"
  | "tide"
  | "beacon"
  | "phosphor"
  | "custom";
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
  | "tide"
  | "tide-light"
  | "beacon"
  | "beacon-light"
  | "phosphor"
  | "phosphor-light"
  | "custom"
  | "custom-light";

const VALID_THEME_NAMES = new Set<ThemeName>([
  "claw",
  "knot",
  "dash",
  "absolutely",
  "tide",
  "beacon",
  "phosphor",
  "custom",
]);

const THEME_FONT_STYLESHEET_ID = "openclaw-theme-fonts";
/* Themes that ship their own faces. The stylesheet is fetched only while such a
   theme is active, so every other theme pays nothing for fonts it never paints.
   Loading with the app bundle (not the first-paint boot script) costs one
   font-display: swap on a cold load and keeps the theme->asset mapping in one
   place. Values are bundle-relative asset names: the href is resolved against
   the configured Control UI mount, and the stylesheet's own url() references
   are relative to it, so both levels follow a non-root base path. */
const THEME_FONT_STYLESHEETS: Partial<Record<ThemeName, ControlUiFontStylesheet>> = {
  absolutely: "fonts/absolutely.css",
  beacon: "fonts/beacon.css",
  phosphor: "fonts/phosphor.css",
};
type ControlUiFontStylesheet = `fonts/${string}.css`;

const THEME_PALETTE_STYLESHEET_ID = "openclaw-theme-palette";
/* Built-in palettes other than the default ship outside the startup stylesheet,
   so the default path does not download tokens for six themes it never paints.
   index.html links the persisted family before first paint; this keeps the link
   correct when the theme changes at runtime. Claw has no entry because its
   tokens are the :root defaults. */
const THEME_PALETTE_STYLESHEETS: Partial<Record<ThemeName, ControlUiPaletteStylesheet>> = {
  knot: "themes/knot.css",
  dash: "themes/dash.css",
  absolutely: "themes/absolutely.css",
  tide: "themes/tide.css",
  beacon: "themes/beacon.css",
  phosphor: "themes/phosphor.css",
};
type ControlUiPaletteStylesheet = `themes/${string}.css`;
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
  if (theme === "tide") {
    return resolvedMode === "light" ? "tide-light" : "tide";
  }
  if (theme === "beacon") {
    return resolvedMode === "light" ? "beacon-light" : "beacon";
  }
  if (theme === "phosphor") {
    return resolvedMode === "light" ? "phosphor-light" : "phosphor";
  }
  return resolvedMode === "light" ? "custom-light" : "custom";
}

function syncThemeStylesheet(
  id: string,
  asset: ControlUiFontStylesheet | ControlUiPaletteStylesheet | undefined,
): void {
  if (typeof document === "undefined") {
    return;
  }
  const existing = document.getElementById(id);
  if (!asset) {
    existing?.remove();
    return;
  }
  const href = inferControlUiPublicAssetPath(asset);
  if (existing instanceof HTMLLinkElement) {
    if (existing.getAttribute("href") !== href) {
      existing.href = href;
    }
    return;
  }
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

/** Loads (or drops) the webfont stylesheet a theme declares. Idempotent. */
export function syncThemeFontStylesheet(theme: ThemeName): void {
  syncThemeStylesheet(THEME_FONT_STYLESHEET_ID, THEME_FONT_STYLESHEETS[theme]);
}

/** Loads (or drops) the palette stylesheet a built-in theme ships. Idempotent. */
export function syncThemePaletteStylesheet(theme: ThemeName): void {
  syncThemeStylesheet(THEME_PALETTE_STYLESHEET_ID, THEME_PALETTE_STYLESHEETS[theme]);
}
