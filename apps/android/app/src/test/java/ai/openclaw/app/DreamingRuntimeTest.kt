package ai.openclaw.app

import ai.openclaw.app.i18n.NativeText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DreamingRuntimeTest {
  @Test
  fun missingDiaryDateUsesOwnedFallbackText() {
    val entry = parseGatewayDreamDiaryEntry("# Dream\n\nA narrative summary.")

    assertEquals("A narrative summary.", entry?.text)
    assertEquals(NativeText.Resource(source = "Dream", formatArgs = emptyList()), entry?.date)
  }

  @Test
  fun gatewayDiaryDateEqualToFallbackRemainsVerbatim() {
    val entry = parseGatewayDreamDiaryEntry("*Dream*\n\nGateway-authored summary.")

    assertEquals("Gateway-authored summary.", entry?.text)
    assertTrue(entry?.date is NativeText.Verbatim)
    assertEquals(NativeText.Verbatim("Dream"), entry?.date)
  }
}
