// Control UI i18n module implements registry behavior.
import type { Locale, TranslationMap } from "./types.ts";

type LazyLocale = Exclude<Locale, "en">;
type LocaleModule = Record<string, TranslationMap>;

export const DEFAULT_LOCALE: Locale = "en";

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
// SAFETY: The record contract guarantees every own key is a LazyLocale.
const LAZY_LOCALES = Object.keys(LAZY_LOCALE_REGISTRY) as LazyLocale[];

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = [DEFAULT_LOCALE, ...LAZY_LOCALES];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

function isLazyLocale(locale: Locale): locale is LazyLocale {
  return LAZY_LOCALES.includes(locale as LazyLocale);
}

export function resolveNavigatorLocale(browserLanguage: string): Locale {
  const navLang = browserLanguage.toLowerCase();
  if (navLang.startsWith("zh")) {
    const [, ...subtags] = navLang.split("-");
    if (subtags.includes("hant")) {
      return "zh-TW";
    }
    if (subtags.includes("hans")) {
      return "zh-CN";
    }
    return subtags.some((subtag) => subtag === "tw" || subtag === "hk" || subtag === "mo")
      ? "zh-TW"
      : "zh-CN";
  }
  return (
    LAZY_LOCALES.find((locale) => navLang.startsWith(locale.split("-")[0]!.toLowerCase())) ??
    DEFAULT_LOCALE
  );
}

export async function loadLazyLocaleTranslation(locale: Locale): Promise<TranslationMap | null> {
  if (!isLazyLocale(locale)) {
    return null;
  }
  const module = await LAZY_LOCALE_REGISTRY[locale]();
  return module[locale.replaceAll("-", "_")] ?? null;
}
