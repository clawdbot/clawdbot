package ai.openclaw.app

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AssistantLaunchTest {
  @Test
  fun parsesAssistGestureIntent() {
    val parsed = parseAssistantLaunchIntent(Intent(Intent.ACTION_ASSIST))

    requireNotNull(parsed)
    assertEquals("assist", parsed.source)
    assertNull(parsed.prompt)
    assertFalse(parsed.autoSend)
  }

  @Test
  fun parsesAppActionPrompt() {
    val parsed =
      parseAssistantLaunchIntent(
        Intent(actionAskOpenClaw).putExtra(extraAssistantPrompt, "  summarize my unread texts  "),
      )

    requireNotNull(parsed)
    assertEquals("app_action", parsed.source)
    assertEquals("summarize my unread texts", parsed.prompt)
    assertFalse(parsed.autoSend)
  }

  @Test
  fun ignoresUnrelatedIntents() {
    assertNull(parseAssistantLaunchIntent(Intent(Intent.ACTION_VIEW)))
  }
}
