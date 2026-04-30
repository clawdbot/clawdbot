import type { Locale, TranslationMap } from "./types.ts";

type LazyLocale = Exclude<Locale, "en">;
type LocaleModule = Record<string, TranslationMap>;

type LazyLocaleRegistration = {
  exportName: string;
  loader: () => Promise<LocaleModule>;
};

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
];

const LAZY_LOCALE_REGISTRY: Record<LazyLocale, LazyLocaleRegistration> = {
  "zh-CN": {
    exportName: "zh_CN",
    loader: () => import("../locales/zh-CN.ts"),
  },
  "zh-TW": {
    exportName: "zh_TW",
    loader: () => import("../locales/zh-TW.ts"),
  },
  "pt-BR": {
    exportName: "pt_BR",
    loader: () => import("../locales/pt-BR.ts"),
  },
  de: {
    exportName: "de",
    loader: () => import("../locales/de.ts"),
  },
  es: {
    exportName: "es",
    loader: () => import("../locales/es.ts"),
  },
  "ja-JP": {
    exportName: "ja_JP",
    loader: () => import("../locales/ja-JP.ts"),
  },
  ko: {
    exportName: "ko",
    loader: () => import("../locales/ko.ts"),
  },
  fr: {
    exportName: "fr",
    loader: () => import("../locales/fr.ts"),
  },
  ar: {
    exportName: "ar",
    loader: () => import("../locales/ar.ts"),
  },
  it: {
    exportName: "it",
    loader: () => import("../locales/it.ts"),
  },
  tr: {
    exportName: "tr",
    loader: () => import("../locales/tr.ts"),
  },
  uk: {
    exportName: "uk",
    loader: () => import("../locales/uk.ts"),
  },
  id: {
    exportName: "id",
    loader: () => import("../locales/id.ts"),
  },
  pl: {
    exportName: "pl",
    loader: () => import("../locales/pl.ts"),
  },
  th: {
    exportName: "th",
    loader: () => import("../locales/th.ts"),
  },
  vi: {
    exportName: "vi",
    loader: () => import("../locales/vi.ts"),
  },
  nl: {
    exportName: "nl",
    loader: () => import("../locales/nl.ts"),
  },
  fa: {
    exportName: "fa",
    loader: () => import("../locales/fa.ts"),
  },
};

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = [DEFAULT_LOCALE, ...LAZY_LOCALES];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

function isLazyLocale(locale: Locale): locale is LazyLocale {
  return LAZY_LOCALES.includes(locale as LazyLocale);
}

export function resolveNavigatorLocale(navLang: string): Locale {
  if (navLang.startsWith("zh")) {
    return navLang === "zh-TW" || navLang === "zh-HK" ? "zh-TW" : "zh-CN";
  }
  if (navLang.startsWith("pt")) {
    return "pt-BR";
  }
  if (navLang.startsWith("de")) {
    return "de";
  }
  if (navLang.startsWith("es")) {
    return "es";
  }
  if (navLang.startsWith("ja")) {
    return "ja-JP";
  }
  if (navLang.startsWith("ko")) {
    return "ko";
  }
  if (navLang.startsWith("fr")) {
    return "fr";
  }
  if (navLang.startsWith("ar")) {
    return "ar";
  }
  if (navLang.startsWith("it")) {
    return "it";
  }
  if (navLang.startsWith("tr")) {
    return "tr";
  }
  if (navLang.startsWith("uk")) {
    return "uk";
  }
  if (navLang.startsWith("id")) {
    return "id";
  }
  if (navLang.startsWith("pl")) {
    return "pl";
  }
  if (navLang.startsWith("th")) {
    return "th";
  }
  if (navLang.startsWith("vi")) {
    return "vi";
  }
  if (navLang.startsWith("nl")) {
    return "nl";
  }
  if (navLang.startsWith("fa")) {
    return "fa";
  }
  return DEFAULT_LOCALE;
}

export async function loadLazyLocaleTranslation(locale: Locale): Promise<TranslationMap | null> {
  if (!isLazyLocale(locale)) {
    return null;
  }
  const registration = LAZY_LOCALE_REGISTRY[locale];
  const module = await registration.loader();
  return module[registration.exportName] ?? null;
}
