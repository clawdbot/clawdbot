package ai.openclaw.app.ui.chat

import androidx.compose.ui.input.key.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import android.view.KeyEvent as AndroidKeyEvent

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatHardwareKeyTest {
  @Test
  fun unmodifiedEnterSendsOnce() {
    var sends = 0

    assertTrue(handlePhysicalChatSend(keyEvent(AndroidKeyEvent.KEYCODE_ENTER), sendEnabled = true) { sends += 1 })
    assertTrue(handlePhysicalChatSend(keyEvent(AndroidKeyEvent.KEYCODE_NUMPAD_ENTER), sendEnabled = true) { sends += 1 })
    assertFalse(handlePhysicalChatSend(keyEvent(AndroidKeyEvent.KEYCODE_ENTER, repeatCount = 1), sendEnabled = true) { sends += 1 })

    assertEquals(2, sends)
  }

  @Test
  fun disabledEnterIsConsumedWithoutSending() {
    var sent = false

    assertTrue(handlePhysicalChatSend(keyEvent(AndroidKeyEvent.KEYCODE_ENTER), sendEnabled = false) { sent = true })

    assertFalse(sent)
  }

  @Test
  fun modifiedEnterAndKeyUpRemainTextInput() {
    val modifiers =
      listOf(
        AndroidKeyEvent.META_SHIFT_ON,
        AndroidKeyEvent.META_CTRL_ON,
        AndroidKeyEvent.META_ALT_ON,
        AndroidKeyEvent.META_META_ON,
      )

    modifiers.forEach { metaState ->
      assertFalse(handlePhysicalChatSend(keyEvent(AndroidKeyEvent.KEYCODE_ENTER, metaState = metaState), sendEnabled = true) {})
    }
    assertFalse(
      handlePhysicalChatSend(
        keyEvent(AndroidKeyEvent.KEYCODE_ENTER, action = AndroidKeyEvent.ACTION_UP),
        sendEnabled = true,
        onSend = {},
      ),
    )
  }

  private fun keyEvent(
    keyCode: Int,
    action: Int = AndroidKeyEvent.ACTION_DOWN,
    repeatCount: Int = 0,
    metaState: Int = 0,
  ): KeyEvent =
    KeyEvent(
      AndroidKeyEvent(
        0L,
        0L,
        action,
        keyCode,
        repeatCount,
        metaState,
      ),
    )
}
