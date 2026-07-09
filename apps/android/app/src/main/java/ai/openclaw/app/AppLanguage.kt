package ai.openclaw.app

import android.content.Context
import android.content.res.Resources
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.app.LocaleManagerCompat
import androidx.core.os.LocaleListCompat
import java.util.Locale

/** Keep these tags aligned with androidResources.localeFilters so Android never offers an unsupported locale. */
internal enum class AppLanguage(
  val languageTag: String?,
  val displayName: String,
) {
  System(languageTag = null, displayName = "System"),
  English(languageTag = "en", displayName = "English"),
  Arabic(languageTag = "ar", displayName = "العربية"),
  German(languageTag = "de", displayName = "Deutsch"),
  Spanish(languageTag = "es", displayName = "Español"),
  Persian(languageTag = "fa", displayName = "فارسی"),
  French(languageTag = "fr", displayName = "Français"),
  Hindi(languageTag = "hi", displayName = "हिन्दी"),
  Indonesian(languageTag = "id", displayName = "Bahasa Indonesia"),
  Italian(languageTag = "it", displayName = "Italiano"),
  Japanese(languageTag = "ja", displayName = "日本語"),
  Korean(languageTag = "ko", displayName = "한국어"),
  Dutch(languageTag = "nl", displayName = "Nederlands"),
  Polish(languageTag = "pl", displayName = "Polski"),
  PortugueseBrazil(languageTag = "pt-BR", displayName = "Português (Brasil)"),
  Russian(languageTag = "ru", displayName = "Русский"),
  Swedish(languageTag = "sv", displayName = "Svenska"),
  Thai(languageTag = "th", displayName = "ไทย"),
  Turkish(languageTag = "tr", displayName = "Türkçe"),
  Ukrainian(languageTag = "uk", displayName = "Українська"),
  Vietnamese(languageTag = "vi", displayName = "Tiếng Việt"),
  ChineseSimplified(languageTag = "zh-CN", displayName = "简体中文"),
  ChineseTraditional(languageTag = "zh-TW", displayName = "繁體中文"),
  ;

  companion object {
    fun fromLanguageTag(languageTag: String?): AppLanguage {
      val locale = languageTag?.trim()?.takeIf(String::isNotEmpty)?.let(Locale::forLanguageTag)
      return locale?.let(::fromLocale) ?: System
    }

    internal fun fromLocale(locale: Locale): AppLanguage? {
      val exactTag = locale.toLanguageTag()
      val exactMatch = entries.firstOrNull { language -> language.languageTag?.equals(exactTag, ignoreCase = true) == true }
      if (exactMatch != null) return exactMatch

      return entries.firstOrNull { language ->
        val supportedLocale = language.languageTag?.let(Locale::forLanguageTag) ?: return@firstOrNull false
        LocaleListCompat.matchesLanguageAndScript(locale, supportedLocale)
      }
    }
  }
}

internal fun appLanguageFromLocales(locales: LocaleListCompat): AppLanguage =
  if (locales.isEmpty) {
    AppLanguage.System
  } else {
    (0 until locales.size()).firstNotNullOfOrNull { index -> locales[index]?.let(AppLanguage::fromLocale) }
      ?: AppLanguage.System
  }

internal fun currentAppLanguage(): AppLanguage = appLanguageFromLocales(AppCompatDelegate.getApplicationLocales())

internal fun localesForAppLanguage(language: AppLanguage): LocaleListCompat = language.languageTag?.let(LocaleListCompat::forLanguageTags) ?: LocaleListCompat.getEmptyLocaleList()

internal fun setAppLanguage(language: AppLanguage) {
  val locales = localesForAppLanguage(language)
  if (locales != AppCompatDelegate.getApplicationLocales()) {
    AppCompatDelegate.setApplicationLocales(locales)
  }
}

internal fun currentSystemLanguageTag(context: Context): String {
  val systemLocales = LocaleManagerCompat.getSystemLocales(context)
  val locale = systemLocales[0] ?: Resources.getSystem().configuration.locales[0]
  return locale.toLanguageTag()
}

internal fun appLanguageRowSubtitle(
  language: AppLanguage,
  systemLanguageTag: String,
): String {
  val languageTag = language.languageTag
  if (languageTag != null) return "OpenClaw translations · $languageTag"
  return "Follow Android · $systemLanguageTag"
}
