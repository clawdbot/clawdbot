package ai.openclaw.app.i18n

import android.content.Context
import android.content.res.Configuration
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.ConfigurationCompat
import androidx.core.os.LocaleListCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
class NativeStringsTest {
  @Test
  fun sourceFallbackFormatsNestedKotlinInterpolations() {
    assertEquals(
      "2/3 fallback active tokens",
      nativeString(
        """${'$'}{device.tokens.count { !it.revoked }}/${'$'}{device.tokens.size} fallback active tokens""",
        2,
        3,
      ),
    )
  }

  @Test
  fun configurationLocaleUpdatesSystemMode() {
    val app = RuntimeEnvironment.getApplication()
    NativeStringResources.install(app)
    NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    assertEquals("Mic off", nativeString("Mic off"))

    val configuration = Configuration(app.resources.configuration)
    ConfigurationCompat.setLocales(configuration, LocaleListCompat.forLanguageTags("fr"))
    NativeStringResources.setConfigurationLocales(configuration)

    assertEquals("Micro désactivé", nativeString("Mic off"))

    ConfigurationCompat.setLocales(configuration, LocaleListCompat.forLanguageTags("de"))
    NativeStringResources.setConfigurationLocales(configuration)

    assertEquals("Mikrofon aus", nativeString("Mic off"))
  }

  @Test
  fun configurationLocaleDoesNotReplacePinnedAppLocale() {
    val app = RuntimeEnvironment.getApplication()
    persistAppLocales(app, "en")
    try {
      NativeStringResources.install(app)

      val configuration = Configuration(app.resources.configuration)
      ConfigurationCompat.setLocales(configuration, LocaleListCompat.forLanguageTags("fr"))
      NativeStringResources.setConfigurationLocales(configuration)

      assertEquals("Mic off", nativeString("Mic off"))
    } finally {
      app.deleteFile(APP_LOCALES_FILE)
      NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    }
  }

  @Test
  fun configurationLocaleUsesLiveAppCompatLocaleBeforeStorage() {
    val app = RuntimeEnvironment.getApplication()
    persistAppLocales(app, "en")
    try {
      NativeStringResources.install(app)
      assertEquals("Mic off", nativeString("Mic off"))

      AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
      val configuration = Configuration(app.resources.configuration)
      ConfigurationCompat.setLocales(configuration, LocaleListCompat.forLanguageTags("en"))
      NativeStringResources.setConfigurationLocales(configuration)

      assertEquals("Micro désactivé", nativeString("Mic off"))
    } finally {
      AppCompatDelegate.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
      app.deleteFile(APP_LOCALES_FILE)
      NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    }
  }

  @Test
  fun configurationLocaleDoesNotReplacePersistedAppLocale() {
    val app = RuntimeEnvironment.getApplication()
    persistAppLocales(app, "fr")
    try {
      NativeStringResources.install(app)

      val configuration = Configuration(app.resources.configuration)
      ConfigurationCompat.setLocales(configuration, LocaleListCompat.forLanguageTags("en"))
      NativeStringResources.setConfigurationLocales(configuration)

      assertEquals("Micro désactivé", nativeString("Mic off"))
    } finally {
      app.deleteFile(APP_LOCALES_FILE)
      NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    }
  }

  @Test
  fun resolvingStateFlowEmitsWhenTheAppLocaleChanges() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      persistAppLocales(app, "en")
      NativeStringResources.install(app)
      val resolved = MutableStateFlow(nativeText("Mic off")).resolveNativeText()
      val firstEmission = CompletableDeferred<Unit>()
      val emissions = mutableListOf<String>()
      val collection =
        launch(start = CoroutineStart.UNDISPATCHED) {
          resolved.take(2).collect { value ->
            emissions += value
            if (emissions.size == 1) firstEmission.complete(Unit)
          }
        }

      try {
        firstEmission.await()
        NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
        notifyNativeLocaleChanged()
        collection.join()

        assertEquals(listOf("Mic off", "Micro désactivé"), emissions)
      } finally {
        collection.cancel()
        NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
        app.deleteFile(APP_LOCALES_FILE)
      }
    }

  private fun persistAppLocales(
    context: Context,
    languageTags: String,
  ) {
    context.openFileOutput(APP_LOCALES_FILE, Context.MODE_PRIVATE).bufferedWriter().use { writer ->
      writer.write("""<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><locales application_locales="$languageTags" />""")
    }
  }

  private companion object {
    const val APP_LOCALES_FILE = "androidx.appcompat.app.AppCompatDelegate.application_locales_record_file"
  }
}
