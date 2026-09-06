package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.voice.AudioInputDeviceOption
import ai.openclaw.app.voice.AudioInputPreferenceState
import android.media.AudioDeviceInfo
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AudioInputPreferenceStatusTest {
  @get:Rule val composeRule = createComposeRule()

  @Test fun requestedIsNotAppliedAndChangingToAutoStillWaitsForTheNextSession() {
    val selected = mutableStateOf<String?>("usb")
    val active = mutableStateOf<AudioInputPreferenceState>(AudioInputPreferenceState.Requested("usb"))
    val capturing = mutableStateOf(true)
    composeRule.setContent {
      ClawDesignTheme {
        AudioInputDevicePanel(
          devices = listOf(AudioInputDeviceOption("usb", "USB mic", AudioDeviceInfo.TYPE_USB_DEVICE)),
          preferredDeviceKey = selected.value,
          activePreference = active.value,
          captureActive = capturing.value,
          onSelect = { selected.value = it },
        )
      }
    }
    composeRule.onNodeWithText("Requested").assertIsDisplayed()
    composeRule.onNodeWithText("Next session").assertDoesNotExist()
    composeRule.runOnIdle { active.value = AudioInputPreferenceState.Applied("usb") }
    composeRule.onNodeWithText("Requested").assertDoesNotExist()
    composeRule.runOnIdle { selected.value = null }
    composeRule.onNodeWithText("Next session").assertIsDisplayed()
    composeRule.runOnIdle { active.value = AudioInputPreferenceState.Requested(null) }
    composeRule.onNodeWithText("Requested").assertIsDisplayed()
    composeRule.onNodeWithText("Next session").assertDoesNotExist()
    composeRule.runOnIdle { active.value = AudioInputPreferenceState.Applied(null) }
    composeRule.onNodeWithText("Requested").assertDoesNotExist()
    composeRule.runOnIdle {
      capturing.value = false
      active.value = AudioInputPreferenceState.Inactive
      selected.value = "usb"
    }
    composeRule.onNodeWithText("Next session").assertDoesNotExist()
  }
}
