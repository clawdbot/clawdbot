package ai.openclaw.app.ui.chat

import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.text.input.TextFieldValue
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
  fun unmodifiedEnterOwnsFullSequenceAndSendsOnce() {
    var sends = 0
    val handler = PhysicalChatSendKeyHandler()

    assertTrue(handler.handle(keyEvent(AndroidKeyEvent.KEYCODE_ENTER), sendEnabled = true, textEmpty = false, compositionActive = false) { sends += 1 })
    assertTrue(
      handler.handle(
        keyEvent(AndroidKeyEvent.KEYCODE_ENTER, repeatCount = 1, metaState = AndroidKeyEvent.META_SHIFT_ON),
        sendEnabled = false,
        textEmpty = true,
        compositionActive = false,
      ) { sends += 1 },
    )
    assertTrue(
      handler.handle(
        keyEvent(
          AndroidKeyEvent.KEYCODE_ENTER,
          action = AndroidKeyEvent.ACTION_UP,
          metaState = AndroidKeyEvent.META_SHIFT_ON,
        ),
        sendEnabled = false,
        textEmpty = true,
        compositionActive = false,
      ) { sends += 1 },
    )
    assertFalse(
      handler.handle(
        keyEvent(AndroidKeyEvent.KEYCODE_ENTER, action = AndroidKeyEvent.ACTION_UP),
        sendEnabled = false,
        textEmpty = true,
        compositionActive = false,
      ) { sends += 1 },
    )

    assertEquals(1, sends)
  }

  @Test
  fun numpadEnterSends() {
    var sends = 0
    val handler = PhysicalChatSendKeyHandler()

    assertTrue(handler.handle(keyEvent(AndroidKeyEvent.KEYCODE_NUMPAD_ENTER), sendEnabled = true, textEmpty = false, compositionActive = false) { sends += 1 })

    assertEquals(1, sends)
  }

  @Test
  fun disabledEnterWithTextOwnsSequenceWithoutSending() {
    var sent = false
    val handler = PhysicalChatSendKeyHandler()

    assertTrue(handler.handle(keyEvent(AndroidKeyEvent.KEYCODE_ENTER), sendEnabled = false, textEmpty = false, compositionActive = false) { sent = true })
    assertTrue(
      handler.handle(
        keyEvent(AndroidKeyEvent.KEYCODE_ENTER, repeatCount = 1),
        sendEnabled = false,
        textEmpty = false,
        compositionActive = false,
      ) { sent = true },
    )
    assertTrue(
      handler.handle(
        keyEvent(AndroidKeyEvent.KEYCODE_ENTER, action = AndroidKeyEvent.ACTION_UP),
        sendEnabled = false,
        textEmpty = false,
        compositionActive = false,
      ) { sent = true },
    )

    assertFalse(sent)
  }

  @Test
  fun blankEnterRemainsImeInputButFiltersInsertedNewline() {
    val handler = PhysicalChatSendKeyHandler()

    assertFalse(handler.handle(keyEvent(AndroidKeyEvent.KEYCODE_ENTER), sendEnabled = false, textEmpty = true, compositionActive = false) {})
    assertEquals(
      "",
      handler
        .filterTextFieldUpdate(
          currentText = "",
          nextTextFieldValue = TextFieldValue("\n"),
        ).text,
    )
    assertEquals(
      "nihao",
      handler
        .filterTextFieldUpdate(
          currentText = "",
          nextTextFieldValue = TextFieldValue("nihao"),
        ).text,
    )
    assertFalse(
      handler.handle(
        keyEvent(AndroidKeyEvent.KEYCODE_ENTER, action = AndroidKeyEvent.ACTION_UP),
        sendEnabled = false,
        textEmpty = false,
        compositionActive = false,
      ) {},
    )
  }

  @Test
  fun compositionAndModifiedEnterRemainImeInput() {
    val modifiers =
      listOf(
        AndroidKeyEvent.META_SHIFT_ON,
        AndroidKeyEvent.META_CTRL_ON,
        AndroidKeyEvent.META_ALT_ON,
        AndroidKeyEvent.META_META_ON,
      )
    val handler = PhysicalChatSendKeyHandler()

    modifiers.forEach { metaState ->
      assertFalse(
        handler.handle(
          keyEvent(AndroidKeyEvent.KEYCODE_ENTER, metaState = metaState),
          sendEnabled = true,
          textEmpty = false,
          compositionActive = false,
          onSend = {},
        ),
      )
    }
    assertFalse(
      handler.handle(
        keyEvent(AndroidKeyEvent.KEYCODE_ENTER),
        sendEnabled = true,
        textEmpty = false,
        compositionActive = true,
        onSend = {},
      ),
    )
  }

  @Test
  fun privateImeInputOwnsEnterUntilTextFieldUpdates() {
    var sends = 0
    val handler = PhysicalChatSendKeyHandler()

    assertFalse(
      handler.handle(
        keyEvent(AndroidKeyEvent.KEYCODE_N),
        sendEnabled = true,
        textEmpty = false,
        compositionActive = false,
        onSend = { sends += 1 },
      ),
    )
    assertFalse(
      handler.handle(
        keyEvent(AndroidKeyEvent.KEYCODE_ENTER),
        sendEnabled = true,
        textEmpty = false,
        compositionActive = false,
        onSend = { sends += 1 },
      ),
    )

    handler.filterTextFieldUpdate(
      currentText = "prefix",
      nextTextFieldValue = TextFieldValue("prefix"),
    )

    assertTrue(
      handler.handle(
        keyEvent(AndroidKeyEvent.KEYCODE_ENTER),
        sendEnabled = true,
        textEmpty = false,
        compositionActive = false,
        onSend = { sends += 1 },
      ),
    )
    assertEquals(1, sends)
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
