package ai.openclaw.app.ui

import androidx.compose.material3.MaterialTheme
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
class TalkStatusRowTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun asynchronousFailureRemainsVisibleAfterDisableAndClearsForStopOrRestart() {
    val enabled = mutableStateOf(true)
    val failure = mutableStateOf(false)
    val status = mutableStateOf("Connecting…")
    composeRule.setContent {
      MaterialTheme { TalkStatusRow(enabled.value, failure.value, status.value) }
    }
    composeRule.onNodeWithText("Connecting…").assertIsDisplayed()
    composeRule.runOnIdle {
      status.value = "Échec de Talk : session refusée."
      failure.value = true
      enabled.value = false
    }
    composeRule.onNodeWithText("Échec de Talk : session refusée.").assertIsDisplayed()
    composeRule.runOnIdle {
      failure.value = false
      status.value = "Off"
    }
    composeRule.onNodeWithText("Échec de Talk : session refusée.").assertDoesNotExist()
    composeRule.onNodeWithText("Off").assertDoesNotExist()
    composeRule.runOnIdle {
      enabled.value = true
      status.value = "Connecting…"
    }
    composeRule.onNodeWithText("Connecting…").assertIsDisplayed()
    composeRule.runOnIdle { status.value = "Listening · openai · gpt-realtime-2.1 · oauth · alloy · webrtc" }
    composeRule.onNodeWithText("Listening · openai · gpt-realtime-2.1 · oauth · alloy · webrtc").assertIsDisplayed()
  }
}
