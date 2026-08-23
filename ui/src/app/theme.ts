// Control UI module implements theme behavior.
export type ThemeName = "claw" | "knot" | "dash" | "custom";
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme =
  | "dark"
  | "light"
  | "openknot"
  | "openknot-light"
  | "dash"
  | "dash-light"
  | "custom"
  | "custom-light";

const VALID_THEME_NAMES = new Set<ThemeName>(["claw", "knot", "dash", "custom"]);
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
  return resolvedMode === "light" ? "custom-light" : "custom";
}
