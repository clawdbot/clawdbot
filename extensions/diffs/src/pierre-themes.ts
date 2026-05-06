import { createRequire } from "node:module";
import type { ThemeRegistrationResolved } from "@pierre/diffs";
import { RegisteredCustomThemes, ResolvedThemes, ResolvingThemes } from "@pierre/diffs";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";

type PierreThemeName = "pierre-dark" | "pierre-light";
const themeRequire = createRequire(import.meta.url);
const PIERRE_THEME_SPECS = [
  ["pierre-dark", "@pierre/theme/themes/pierre-dark.json"],
  ["pierre-light", "@pierre/theme/themes/pierre-light.json"],
] as const satisfies ReadonlyArray<readonly [PierreThemeName, string]>;

function createThemeLoader(
  themeName: PierreThemeName,
  themeSpecifier: string,
): () => Promise<ThemeRegistrationResolved> {
  let cachedTheme: ThemeRegistrationResolved | undefined;
  return async () => {
    if (cachedTheme) {
      return cachedTheme;
    }
    const themePath = themeRequire.resolve(themeSpecifier);
    const { value: theme } = await readJsonFileWithFallback<Record<string, unknown>>(themePath, {});
    cachedTheme = {
      ...theme,
      name: themeName,
    } as ThemeRegistrationResolved;
    return cachedTheme;
  };
}

const PIERRE_THEME_LOADERS = new Map(
  PIERRE_THEME_SPECS.map(([themeName, themeSpecifier]) => [
    themeName,
    createThemeLoader(themeName, themeSpecifier),
  ]),
);

export function ensurePierreThemesRegistered(): void {
  let replacedThemeLoader = false;

  for (const [themeName, loader] of PIERRE_THEME_LOADERS) {
    if (RegisteredCustomThemes.get(themeName) !== loader) {
      RegisteredCustomThemes.set(themeName, loader);
      replacedThemeLoader = true;
    }
  }

  if (!replacedThemeLoader) {
    return;
  }

  // If another path swapped these loaders, clear the resolver caches so the
  // next render rehydrates the highlighter with the Node-safe theme source.
  for (const [themeName] of PIERRE_THEME_LOADERS) {
    ResolvedThemes.delete(themeName);
    ResolvingThemes.delete(themeName);
  }
}
