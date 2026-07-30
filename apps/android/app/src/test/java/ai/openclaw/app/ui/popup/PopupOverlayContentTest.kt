package ai.openclaw.app.ui.popup

import org.junit.Assert.assertEquals
import org.junit.Test

class PopupOverlayContentTest {
  @Test
  fun popupSpokenText_prefixesSenderWhenSubtitlePresent() {
    assertEquals("Message from Anna: Dinner at 7?", popupSpokenText(subtitle = "Anna", body = "Dinner at 7?"))
  }

  @Test
  fun popupSpokenText_isJustBodyWhenNoSubtitle() {
    assertEquals("Dinner at 7?", popupSpokenText(subtitle = null, body = "Dinner at 7?"))
  }
}
