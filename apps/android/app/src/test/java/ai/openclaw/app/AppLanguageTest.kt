package ai.openclaw.app

import androidx.core.os.LocaleListCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.xmlpull.v1.XmlPullParser

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppLanguageTest {
  @Test
  fun supportedLanguagesMatchPackagedTranslations() {
    assertEquals(
      setOf(
        "ar",
        "de",
        "en",
        "es",
        "fa",
        "fr",
        "hi",
        "id",
        "it",
        "ja",
        "ko",
        "nl",
        "pl",
        "pt-BR",
        "ru",
        "sv",
        "th",
        "tr",
        "uk",
        "vi",
        "zh-CN",
        "zh-TW",
      ),
      AppLanguage.entries.mapNotNull(AppLanguage::languageTag).toSet(),
    )
  }

  @Test
  fun everyLanguageRoundTripsThroughAndroidLocales() {
    AppLanguage.entries.forEach { language ->
      assertEquals(language, appLanguageFromLocales(localesForAppLanguage(language)))
    }
  }

  @Test
  fun systemUsesAnEmptyLocaleList() {
    assertTrue(localesForAppLanguage(AppLanguage.System).isEmpty)
    assertEquals(AppLanguage.System, appLanguageFromLocales(LocaleListCompat.getEmptyLocaleList()))
  }

  @Test
  fun languageTagsNormalizeAtThePlatformBoundary() {
    assertEquals(AppLanguage.Indonesian, AppLanguage.fromLanguageTag("in"))
    assertEquals(AppLanguage.PortugueseBrazil, AppLanguage.fromLanguageTag("PT-br"))
    assertEquals(AppLanguage.English, AppLanguage.fromLanguageTag("en-US"))
    assertEquals(AppLanguage.German, AppLanguage.fromLanguageTag("de-DE"))
    assertEquals(AppLanguage.ChineseTraditional, AppLanguage.fromLanguageTag("zh-Hant-HK"))
    assertEquals(AppLanguage.System, AppLanguage.fromLanguageTag(null))
  }

  @Test
  fun requestedLocaleListUsesTheFirstSupportedLanguage() {
    assertEquals(
      AppLanguage.French,
      appLanguageFromLocales(LocaleListCompat.forLanguageTags("xx,fr-FR,de-DE")),
    )
  }

  @Test
  fun generatedLocaleConfigMatchesPickerLanguages() {
    val parser = RuntimeEnvironment.getApplication().resources.getXml(R.xml._generated_res_locale_config)
    val packagedTags = mutableSetOf<String?>()
    var defaultLocaleTag: String? = null
    while (parser.eventType != XmlPullParser.END_DOCUMENT) {
      if (parser.eventType == XmlPullParser.START_TAG) {
        when (parser.name) {
          "locale-config" -> defaultLocaleTag = parser.getAttributeValue(androidNamespace, "defaultLocale")
          "locale" -> packagedTags += AppLanguage.fromLanguageTag(parser.getAttributeValue(androidNamespace, "name")).languageTag
        }
      }
      parser.next()
    }

    assertEquals("en", defaultLocaleTag)
    assertEquals(AppLanguage.entries.mapNotNull(AppLanguage::languageTag).toSet(), packagedTags)
  }

  @Test
  fun everyPickerOptionHasAUniqueLabel() {
    val labels = AppLanguage.entries.map(AppLanguage::displayName)
    assertFalse(labels.any(String::isBlank))
    assertEquals(labels.size, labels.toSet().size)
  }

  @Test
  fun systemSubtitleReportsTheActualSystemLocale() {
    assertEquals("Follow Android · en-US", appLanguageRowSubtitle(AppLanguage.System, "en-US"))
    assertEquals("OpenClaw translations · ja", appLanguageRowSubtitle(AppLanguage.Japanese, "en-US"))
  }

  private companion object {
    const val androidNamespace = "http://schemas.android.com/apk/res/android"
  }
}
