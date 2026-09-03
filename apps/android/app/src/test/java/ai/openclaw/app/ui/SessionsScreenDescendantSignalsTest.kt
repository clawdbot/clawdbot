package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SessionsScreenDescendantSignalsTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun collapsedSignalsExposeStatusAndExpandedStateRemovesThem() {
    val compact = mutableStateOf(false)
    val collapsedState =
      mutableStateOf<SessionDescendantState?>(
        SessionDescendantState(
          containsCurrent = true,
          hasRunning = true,
          hasUnread = true,
          hasFailure = true,
          hasAttention = true,
        ),
      )
    var iconNames = emptyList<String>()
    composeRule.setContent {
      ClawDesignTheme {
        iconNames =
          collapsedState.value
            ?.presentationSignals()
            ?.map { it.icon.name }
            .orEmpty()
        SessionDescendantSignals(collapsedState.value, visible = compact.value)
      }
    }

    composeRule.onNodeWithContentDescription("Needs attention").assertDoesNotExist()
    composeRule.runOnIdle { compact.value = true }
    composeRule.onNodeWithContentDescription("Needs attention").assertExists()
    composeRule.onNodeWithContentDescription("Thread failed").assertExists()
    composeRule.onNodeWithContentDescription("Current thread").assertExists()
    composeRule.onNodeWithContentDescription("Running").assertExists()
    composeRule.onNodeWithContentDescription("Unread").assertExists()
    composeRule.runOnIdle { assertEquals(iconNames.size, iconNames.distinct().size) }

    composeRule.runOnIdle { collapsedState.value = null }
    composeRule.onNodeWithContentDescription("Needs attention").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Thread failed").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Current thread").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Running").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Unread").assertDoesNotExist()
  }
}
