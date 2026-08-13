package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Locale

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatDurationFormatterRobolectricTest {
  @Test
  fun fullDurationUsesLocalizedHumanReadableWording() {
    assertEquals("4 hours, 2 minutes", formatChatDurationFull(14_520_000L, Locale.US))

    val german = formatChatDurationFull(14_520_000L, Locale.GERMAN)
    assertTrue(german.contains("4"))
    assertTrue(german.contains("2"))
    assertTrue(german != "4h 2m")
  }
}
