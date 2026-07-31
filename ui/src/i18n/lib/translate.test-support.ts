import type { i18n } from "./translate.ts";
import "./translate.ts";
import type { Locale, TranslationMap } from "./types.ts";

type LocaleTranslationLoader = (locale: Locale) => Promise<TranslationMap | null>;
type TranslateTestApi = {
  createI18nManager(loadLocaleTranslation: LocaleTranslationLoader): typeof i18n;
};

function getTestApi(): TranslateTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.i18nManagerTestApi")
  ];
  if (!api) {
    throw new Error("i18n manager test API is unavailable");
  }
  return api as TranslateTestApi;
}

export function createI18nManagerForTesting(
  loadLocaleTranslation: LocaleTranslationLoader,
): typeof i18n {
  return getTestApi().createI18nManager(loadLocaleTranslation);
}
