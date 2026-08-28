package ai.openclaw.app.ui

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AgentPickerTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun unknownSelectionRemainsVisibleAndCanSwitchToAnAvailableAgent() {
    var selectedAgentId: String? = null
    composeRule.setContent {
      ClawDesignTheme {
        AgentPicker(
          state =
            AgentPickerState(
              agents = listOf(GatewayAgentSummary(id = "main", name = "Main", emoji = null, kind = null)),
              selectedAgentId = "missing",
            ),
          onSelectAgent = { selectedAgentId = it },
        )
      }
    }

    composeRule.onNodeWithText("missing").assertIsDisplayed().performClick()
    composeRule.onNodeWithText("Main").assertIsDisplayed().performClick()

    assertEquals("main", selectedAgentId)
  }
}
