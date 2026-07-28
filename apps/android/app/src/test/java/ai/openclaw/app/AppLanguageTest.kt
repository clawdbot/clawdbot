package ai.openclaw.app

import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.i18n.joinedNativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.node.NodePresenceAliveBeacon
import ai.openclaw.app.ui.chat.contextMeterThinkingLabel
import ai.openclaw.app.ui.formatApprovalDuration
import ai.openclaw.app.ui.formatCronWake
import ai.openclaw.app.ui.formatUsageUpdated
import ai.openclaw.app.ui.skillWorkshopStatusLabel
import android.os.Build
import androidx.appcompat.app.AppCompatActivity
import androidx.core.os.LocaleListCompat
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
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

  @Test
  fun retainedNativeTextResolvesAgainstTheCurrentLocale() {
    val activity = Robolectric.buildActivity(LocaleTestActivity::class.java).setup()
    NativeStringResources.install(activity.get())
    val retained = MutableStateFlow(nativeText("Mic off")).resolveNativeText()
    val retainedComposite =
      MutableStateFlow(
        joinedNativeText(
          separator = " · ",
          parts = listOf(nativeText("Mic off"), verbatimText("raw")),
        ),
      ).resolveNativeText()
    val previous = currentAppLanguage()
    try {
      setAppLanguage(AppLanguage.English)
      assertEquals("Mic off", retained.value)
      assertEquals("Mic off · raw", retainedComposite.value)
      assertEquals("Pending", skillWorkshopStatusLabel("pending"))

      setAppLanguage(AppLanguage.French)
      assertEquals("Micro désactivé", retained.value)
      assertEquals("Micro désactivé · raw", retainedComposite.value)
      assertEquals("En attente", skillWorkshopStatusLabel("pending"))
      assertEquals("Retenu", skillWorkshopStatusLabel("quarantined"))
      assertEquals("Retenu", skillWorkshopStatusLabel("stale"))
      assertEquals("Appliqué", skillWorkshopStatusLabel("applied"))
      assertEquals("Rejeté", skillWorkshopStatusLabel("rejected"))
      assertEquals("Chargement", skillWorkshopStatusLabel("loading"))
      assertEquals("future_status", skillWorkshopStatusLabel("future_status"))
      assertEquals("Élevé", contextMeterThinkingLabel("high"))
      assertEquals("adaptive", contextMeterThinkingLabel("adaptive"))
      val androidRelease =
        Build.VERSION.RELEASE
          ?.trim()
          .orEmpty()
          .ifEmpty { "unknown" }
      assertEquals(
        "Android $androidRelease (SDK ${Build.VERSION.SDK_INT})",
        NodePresenceAliveBeacon.androidPlatformMetadata(),
      )
      assertEquals("Connexion…", gatewayConnectionStatusForDisplay("Connecting…"))
      assertEquals(
        "Impossible de charger les approbations.",
        gatewayExecApprovalTextForDisplay("Could not load approvals."),
      )
      assertEquals("1 min", formatApprovalDuration(60_000))
      assertEquals("2 min", formatUsageUpdated(updatedAtMs = 0, nowMs = 120_000))
      assertEquals("3 h", formatCronWake(timeMs = 10_800_000, nowMs = 0))
    } finally {
      setAppLanguage(previous)
      activity.destroy()
    }
  }

  private companion object {
    const val androidNamespace = "http://schemas.android.com/apk/res/android"
  }
}

private class LocaleTestActivity : AppCompatActivity()
