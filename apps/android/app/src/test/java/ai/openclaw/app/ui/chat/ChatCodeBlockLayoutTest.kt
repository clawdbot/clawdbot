package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.config.ConfigurationRegistry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatCodeBlockLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  private lateinit var clipboard: ClipboardManager
  private var previousClip: ClipData? = null

  @Before
  fun setUp() {
    assertEquals(GraphicsMode.Mode.NATIVE, ConfigurationRegistry.get(GraphicsMode.Mode::class.java))
    clipboard = RuntimeEnvironment.getApplication().getSystemService(ClipboardManager::class.java)
    previousClip = clipboard.primaryClip
  }

  @After
  fun restoreClipboard() {
    previousClip?.let(clipboard::setPrimaryClip) ?: clipboard.clearPrimaryClip()
  }

  @Test
  fun publicEndAndStartRevealTheActualCodeEndpointsAndCopyKeepsTheEntireSource() {
    val code = "  FIRST_CODE\r\n" + "middle\r\n".repeat(700) + "LAST_CODE\r\n  "
    show { ChatCodeBlock(code = code, language = "kotlin") }

    visibleGlyph("FIRST_CODE")
    click("End of code")
    visibleGlyph("LAST_CODE")
    assertCopiedSource(code)
    click("Start of code")
    visibleGlyph("FIRST_CODE")
  }

  @Test
  fun quotedFencedCodeUsesTheSameNavigableRenderer() {
    val code = "QUOTED_FIRST\n" + "middle\n".repeat(300) + "QUOTED_LAST\n"
    val markdown = "> ```text\n" + code.trimEnd('\n').lineSequence().joinToString("\n") { "> $it" } + "\n> ```"
    show { ChatMarkdown(text = markdown, textColor = ClawTheme.colors.text) }

    visibleGlyph("QUOTED_FIRST")
    click("End of code")
    visibleGlyph("QUOTED_LAST")
    assertCopiedSource(code)
    click("Start of code")
    visibleGlyph("QUOTED_FIRST")
  }

  @Test
  fun layoutBoundariesPreserveLineSpacingGraphemesAndCopiedSource() {
    val cases =
      listOf(
        BoundaryCase("LF before cap", "x".repeat(16_383) + "\nY", lineBreaks = 1),
        BoundaryCase("LF after cap", "x".repeat(16_384) + "\nY", lineBreaks = 1),
        BoundaryCase("CRLF before cap", "x".repeat(16_382) + "\r\nY", lineBreaks = 1),
        BoundaryCase("CRLF across cap", "x".repeat(16_383) + "\r\nY", lineBreaks = 1),
        BoundaryCase("blank LF line", "x".repeat(16_384) + "\n\nY", lineBreaks = 2),
        BoundaryCase("blank CRLF line", "x".repeat(16_383) + "\r\n\r\nY", lineBreaks = 2),
        BoundaryCase("combining at cap", "x".repeat(16_383) + "e\u0301Y", intactTail = "e\u0301Y"),
        BoundaryCase("joined emoji at cap", "x".repeat(16_383) + "👩\u200D💻Y", intactTail = "👩\u200D💻Y"),
        BoundaryCase("LF before over-budget grapheme", "x".repeat(16_384) + "\na" + "\u0301".repeat(20_000) + "Y"),
        BoundaryCase("CRLF before over-budget grapheme", "x".repeat(16_384) + "\r\na" + "\u0301".repeat(20_000) + "Y"),
      )
    val current = mutableStateOf(cases.first())
    show {
      key(current.value.label) {
        ChatCodeBlock(code = current.value.code, language = null)
      }
    }

    cases.forEach { case ->
      val controlSpacing =
        case.lineBreaks?.let { breaks ->
          val separator = case.code.substringAfterLast('x').substringBefore('Y')
          val control = case.copy(label = "${case.label}: unsplit control", code = "x${separator}Y")
          composeRule.runOnIdle { current.value = control }
          composeRule.onNodeWithText("End of code").assertDoesNotExist()
          val (_, controlLayout) = renderedText("Y")
          assertEquals("${case.label}: the short control must retain its explicit lines", breaks + 1, controlLayout.lineCount)
          visibleGlyph("Y").top - visibleGlyph("x").top
        }
      composeRule.runOnIdle { current.value = case }
      click("End of code")
      val ending = visibleGlyph("Y")
      val (_, endingLayout) = renderedText("Y")
      controlSpacing?.let { expected ->
        val previous = visibleGlyph("x")
        // Final-line extents include edge metrics, not a repeatable baseline advance.
        // Compare with the same separator rendered without a layout boundary.
        assertEquals("${case.label}: a layout boundary must match unsplit code spacing", expected, ending.top - previous.top, 2f)
      }
      case.intactTail?.let { tail ->
        assertTrue(
          "${case.label}: the displayed tail must contain the complete grapheme",
          endingLayout.layoutInput.text.text
            .endsWith(tail),
        )
      }
      assertCopiedSource(case.code)
    }
  }

  @Test
  fun shortCodeKeepsItsCompleteHighlightedMonospaceLayoutWithoutNavigation() {
    val code = "val answer = \"short\"\n  "
    show { ChatCodeBlock(code = code, language = "kotlin") }

    composeRule.onNodeWithText("KOTLIN").assertIsDisplayed()
    visibleGlyph("short")
    val (_, layout) = renderedText("short")
    assertEquals(code.trimEnd(), layout.layoutInput.text.text)
    assertEquals(FontFamily.Monospace, layout.layoutInput.style.fontFamily)
    assertTrue(
      "Short completed code must retain syntax highlighting",
      layout.layoutInput.text.spanStyles
        .isNotEmpty(),
    )
    listOf("Start of code", "End of code", "Copy code").forEach { label ->
      composeRule.onNodeWithText(label).assertDoesNotExist()
    }
  }

  private fun show(content: @Composable () -> Unit) {
    composeRule.setContent {
      ClawDesignTheme {
        Box(Modifier.size(360.dp, 800.dp).clipToBounds()) { content() }
      }
    }
  }

  private fun click(label: String) {
    composeRule
      .onNode(hasText(label) and hasClickAction())
      .assertIsDisplayed()
      .assertIsEnabled()
      .performClick()
  }

  private fun assertCopiedSource(expected: String) {
    clipboard.setPrimaryClip(ClipData.newPlainText("before copy", "not the code"))
    click("Copy code")
    composeRule.runOnIdle {
      assertEquals(
        "Copy code must retain the full source, not just the visible layout or trimmed display",
        expected,
        clipboard.primaryClip
          ?.getItemAt(0)
          ?.text
          ?.toString(),
      )
    }
  }

  private fun renderedText(marker: String): Pair<SemanticsNode, TextLayoutResult> {
    val target = composeRule.onNode(hasText(marker, substring = true), useUnmergedTree = true).assertIsDisplayed()
    val layouts = mutableListOf<TextLayoutResult>()
    target.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
    return target.fetchSemanticsNode() to layouts.single()
  }

  private fun visibleGlyph(marker: String): Rect {
    val (node, layout) = renderedText(marker)
    val start =
      layout.layoutInput.text.text
        .lastIndexOf(marker)
    assertTrue("The rendered layout must contain $marker", start >= 0)
    var lastGlyph = Rect.Zero
    marker.indices.forEach { index ->
      val glyph = layout.getBoundingBox(start + index).translate(node.positionInRoot)
      assertTrue("$marker glyph $index needs finite positive geometry", glyph.left.isFinite() && glyph.top.isFinite() && glyph.width > 0 && glyph.height > 0)
      assertTrue(
        "$marker glyph $index must be inside the clipped code viewport: $glyph vs ${node.boundsInRoot}",
        node.boundsInRoot.contains(glyph.topLeft) && node.boundsInRoot.contains(glyph.bottomRight - Offset(0.01f, 0.01f)),
      )
      lastGlyph = glyph
    }
    return lastGlyph
  }

  private data class BoundaryCase(
    val label: String,
    val code: String,
    val lineBreaks: Int? = null,
    val intactTail: String? = null,
  )
}
