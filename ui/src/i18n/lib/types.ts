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
  | "ar"
  | "it"
  | "tr"
  | "uk"
  | "id"
  | "pl"
  | "th"
  | "vi"
  | "nl"
  | "fa";

export interface I18nConfig {
  locale: Locale;
  fallbackLocale: Locale;
  translations: Record<Locale, TranslationMap>;
}
