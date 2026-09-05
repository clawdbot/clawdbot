package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatMermaidBlockTest {
  @get:Rule
  val composeRule = createComposeRule()

  private lateinit var clipboard: ClipboardManager
  private var previousClip: ClipData? = null

  @Before
  fun saveClipboard() {
    clipboard = RuntimeEnvironment.getApplication().getSystemService(ClipboardManager::class.java)
    previousClip = clipboard.primaryClip
  }

  @After
  fun restoreClipboard() {
    previousClip?.let(clipboard::setPrimaryClip) ?: clipboard.clearPrimaryClip()
  }

  @Test
  fun closedStreamingFenceExposesTouchControlsAndCopiesTheWholeSource() {
    val source = "flowchart LR\n    A[Gateway] --> B[Worker]\n"
    val markdown = mutableStateOf("```mermaid\n$source")
    composeRule.setContent {
      ClawDesignTheme {
        Box(Modifier.width(320.dp)) {
          ChatMarkdown(markdown.value, textColor = ClawTheme.colors.text, isStreaming = true)
        }
      }
    }
    composeRule.onNodeWithContentDescription("Copy diagram source").assertDoesNotExist()
    composeRule.runOnIdle { markdown.value += "```\n" }
    composeRule.onNodeWithContentDescription("Copy diagram source").assertIsDisplayed().performClick()
    composeRule.runOnIdle {
      assertEquals(
        source,
        clipboard.primaryClip
          ?.getItemAt(0)
          ?.text
          ?.toString(),
      )
    }
    composeRule.onNodeWithContentDescription("Diagram options").performClick()
    composeRule.onNodeWithText("View source").performClick()
    composeRule.onNodeWithText(source.trimEnd()).assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Diagram options").performClick()
    composeRule.onNodeWithText("View diagram").assertIsDisplayed()
  }
}
