package ai.openclaw.wear

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale

class WearLocaleTextTest {
  @Test
  fun `uppercases labels with the active locale`() {
    assertEquals("İLETİŞİM", wearUppercase("iletişim", Locale.forLanguageTag("tr")))
  }
}
