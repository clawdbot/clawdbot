// Control UI i18n module implements registry behavior.
import { matchInferredOpenClawLocale } from "@openclaw/localization-core/locale-registry";
import type { Locale, TranslationMap } from "./types.ts";

type LazyLocale = Exclude<Locale, "en">;
type LocaleModule = Record<string, TranslationMap>;

export const DEFAULT_LOCALE: Locale = "en";

const LAZY_LOCALES: readonly LazyLocale[] = [
  "zh-CN",
  "zh-TW",
  "pt-BR",
  "de",
  "es",
  "ja-JP",
  "ko",
  "fr",
  "hi",
  "ar",
  "it",
  "tr",
  "uk",
  "id",
  "pl",
  "th",
  "vi",
  "nl",
  "fa",
  "ru",
];

const LAZY_LOCALE_REGISTRY: Record<LazyLocale, () => Promise<LocaleModule>> = {
  "zh-CN": () => import("../locales/zh-CN.ts"),
  "zh-TW": () => import("../locales/zh-TW.ts"),
  "pt-BR": () => import("../locales/pt-BR.ts"),
  de: () => import("../locales/de.ts"),
  es: () => import("../locales/es.ts"),
  "ja-JP": () => import("../locales/ja-JP.ts"),
  ko: () => import("../locales/ko.ts"),
  fr: () => import("../locales/fr.ts"),
  hi: () => import("../locales/hi.ts"),
  ar: () => import("../locales/ar.ts"),
  it: () => import("../locales/it.ts"),
  tr: () => import("../locales/tr.ts"),
  uk: () => import("../locales/uk.ts"),
  id: () => import("../locales/id.ts"),
  pl: () => import("../locales/pl.ts"),
  th: () => import("../locales/th.ts"),
  vi: () => import("../locales/vi.ts"),
  nl: () => import("../locales/nl.ts"),
  fa: () => import("../locales/fa.ts"),
  ru: () => import("../locales/ru.ts"),
};

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = [DEFAULT_LOCALE, ...LAZY_LOCALES];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

function isLazyLocale(locale: Locale): locale is LazyLocale {
  return LAZY_LOCALES.includes(locale as LazyLocale);
}

export function resolveNavigatorLocale(browserLanguage: string): Locale {
  const locale = matchInferredOpenClawLocale(browserLanguage, SUPPORTED_LOCALES);
  if (locale && isSupportedLocale(locale)) {
    return locale;
  }
  return DEFAULT_LOCALE;
}

export async function loadLazyLocaleTranslation(locale: Locale): Promise<TranslationMap | null> {
  if (!isLazyLocale(locale)) {
    return null;
  }
  const module = await LAZY_LOCALE_REGISTRY[locale]();
  return module[locale.replaceAll("-", "_")] ?? null;
}
