/**
 * Shared native-app locale list. Lives outside native-app-i18n.ts so the
 * derived generators (android-app-i18n, apple-app-i18n) can import it without
 * creating a cycle with native-app-i18n's top-level CLI await, which chains
 * those generators after rewriting the inventory.
 */
export const NATIVE_I18N_LOCALES = [
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
  "sv",
] as const;
