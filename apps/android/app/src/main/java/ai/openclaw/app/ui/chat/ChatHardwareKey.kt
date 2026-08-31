package ai.openclaw.app.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.input.TextFieldValue

@Composable
internal fun ChatTextFieldValueAdapter(
  value: String,
  onValueChange: (String) -> Unit,
  keyHandler: PhysicalChatSendKeyHandler,
  content: @Composable (TextFieldValue, (TextFieldValue) -> Unit) -> Unit,
) {
  // Mirrors Compose's String adapter while exposing the IME composition range.
  var textFieldValueState by remember { mutableStateOf(TextFieldValue(text = value)) }
  val textFieldValue = textFieldValueState.copy(text = value)
  SideEffect {
    if (
      textFieldValue.selection != textFieldValueState.selection ||
      textFieldValue.composition != textFieldValueState.composition
    ) {
      textFieldValueState = textFieldValue
    }
  }
  var lastTextValue by remember(value) { mutableStateOf(value) }

  content(textFieldValue) { nextTextFieldValue ->
    val filteredTextFieldValue =
      keyHandler.filterTextFieldUpdate(
        currentText = textFieldValue.text,
        nextTextFieldValue = nextTextFieldValue,
      )
    textFieldValueState = filteredTextFieldValue

    val stringChanged = lastTextValue != filteredTextFieldValue.text
    lastTextValue = filteredTextFieldValue.text
    if (stringChanged) {
      onValueChange(filteredTextFieldValue.text)
    }
  }
}

internal class PhysicalChatSendKeyHandler {
  private var ownedEnterKey: Key? = null
  private var blankImeSequence = false
  private var uncommittedHardwareInput = false

  fun handle(
    event: KeyEvent,
    sendEnabled: Boolean,
    textEmpty: Boolean,
    compositionActive: Boolean,
    onSend: () -> Unit,
  ): Boolean {
    val enterKey = event.key == Key.Enter || event.key == Key.NumPadEnter
    if (!enterKey) {
      val commandModified = event.isCtrlPressed || event.isAltPressed || event.isMetaPressed
      if (
        event.type == KeyEventType.KeyDown &&
        event.nativeKeyEvent.repeatCount == 0 &&
        event.nativeKeyEvent.isPrintingKey &&
        !commandModified
      ) {
        // Some IMEs keep hardware-key preedit private, outside TextFieldValue.composition.
        uncommittedHardwareInput = true
      }
      return false
    }

    if (event.type == KeyEventType.KeyUp) {
      val owned = ownedEnterKey == event.key
      if (owned) ownedEnterKey = null
      blankImeSequence = false
      return owned
    }
    if (event.type != KeyEventType.KeyDown) return false

    if (event.nativeKeyEvent.repeatCount > 0) {
      return ownedEnterKey == event.key
    }

    ownedEnterKey = null
    blankImeSequence = false
    val modified = event.isShiftPressed || event.isCtrlPressed || event.isAltPressed || event.isMetaPressed
    if (modified) return false

    if (compositionActive || uncommittedHardwareInput) return false

    if (sendEnabled) {
      // Own the full sequence after sending; leaked repeats insert newlines into the cleared draft.
      ownedEnterKey = event.key
      onSend()
      return true
    }

    if (textEmpty) {
      // A private IME may hold preedit text while the app-visible value is empty.
      blankImeSequence = true
      return false
    }

    ownedEnterKey = event.key
    return true
  }

  fun filterTextFieldUpdate(
    currentText: String,
    nextTextFieldValue: TextFieldValue,
  ): TextFieldValue {
    val blankHardwareNewline =
      blankImeSequence &&
        currentText.isEmpty() &&
        nextTextFieldValue.text == "\n"
    uncommittedHardwareInput = false
    return if (blankHardwareNewline) {
      TextFieldValue()
    } else {
      nextTextFieldValue
    }
  }
}
