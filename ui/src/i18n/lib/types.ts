export type TranslationMap = { [key: string]: string | TranslationMap };

export type Locale =
  | "en"
  | "zh-CN"
  | "zh-TW"
  | "pt-BR"
  | "de"
  | "es"
  | "ja-JP"
  | "ko"
  | "fr"
  | "tr"
  | "uk"
  | "id"
  | "pl"
  | "th";

export interface I18nConfig {
  locale: Locale;
  fallbackLocale: Locale;
  translations: Record<Locale, TranslationMap>;
}
