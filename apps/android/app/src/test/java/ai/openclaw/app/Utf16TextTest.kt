package ai.openclaw.app

import ai.openclaw.app.ui.localizedInitial
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Locale

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class Utf16TextTest {
  @Test
  fun firstGraphemeOrNullPreservesUserPerceivedCharacters() {
    assertEquals("🧭", "🧭 Scout".firstGraphemeOrNull())
    assertEquals("🇺🇸", "🇺🇸 Scout".firstGraphemeOrNull())
    assertEquals("👩🏽‍💻", "👩🏽‍💻 Dev".firstGraphemeOrNull())
    assertEquals("A\u0308", "A\u0308lice".firstGraphemeOrNull())
    assertEquals("S", "Scout".firstGraphemeOrNull())
    assertNull("".firstGraphemeOrNull())
  }

  @Test
  fun localizedInitialPreservesGraphemesAndLocale() {
    assertEquals("🧭", localizedInitial("🧭 Scout", languageTag = "en", fallbackLocale = Locale.US))
    assertEquals("🇺🇸", localizedInitial("🇺🇸 Scout", languageTag = "en", fallbackLocale = Locale.US))
    assertEquals("👩🏽‍💻", localizedInitial("👩🏽‍💻 Dev", languageTag = "en", fallbackLocale = Locale.US))
    assertEquals("İ", localizedInitial("istanbul", languageTag = "tr", fallbackLocale = Locale.US))
    assertNull(localizedInitial("", languageTag = "en", fallbackLocale = Locale.US))
  }

  @Test
  fun takeUtf16SafePreservesCodeUnitLimitWithoutSplittingSurrogatePairs() {
    assertEquals("ab", "ab".takeUtf16Safe(2))
    assertEquals("ab", "abc".takeUtf16Safe(2))
    assertEquals("", "\uD83D\uDE00tail".takeUtf16Safe(1))
    assertEquals("\uD83D\uDE00", "\uD83D\uDE00tail".takeUtf16Safe(2))
  }
}
