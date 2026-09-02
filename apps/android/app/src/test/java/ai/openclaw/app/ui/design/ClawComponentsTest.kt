package ai.openclaw.app.ui.design

import ai.openclaw.app.AppearanceThemeFamily
import ai.openclaw.app.appearanceAccentPalette
import ai.openclaw.app.ui.chat.ChatMarkdown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ClawComponentsTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun selectedLabelsStayReadableAcrossThemeFamiliesAndLightAccents() {
    val cases =
      AppearanceThemeFamily.entries.flatMap { family ->
        listOf(ThemeCase(dark = true, family = family), ThemeCase(dark = false, family = family))
      } + appearanceAccentPalette.map { ThemeCase(dark = false, accentArgb = it) }
    val current = mutableStateOf(cases.first())
    composeRule.setContent {
      val theme = current.value
      ClawDesignTheme(dark = theme.dark, family = theme.family, accentArgb = theme.accentArgb) {
        Surface(color = ClawTheme.colors.surface) {
          Column(Modifier.width(320.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            ClawSegmentedControl(options = listOf("Segment", "Other"), selected = "Segment", onSelect = {})
            ClawPill(text = "Pill", selected = true, onClick = {})
            Surface(
              modifier = Modifier.testTag("primary-container"),
              color = MaterialTheme.colorScheme.primaryContainer,
              contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
            ) {
              Text("Primary container", Modifier.padding(12.dp), style = ClawTheme.type.caption)
            }
            Surface(
              modifier = Modifier.testTag("secondary-container"),
              color = MaterialTheme.colorScheme.secondaryContainer,
              contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
            ) {
              Text("Secondary container", Modifier.padding(12.dp), style = ClawTheme.type.caption)
            }
            ClawPrimaryButton(text = "Primary button", onClick = {})
            TextButton(onClick = {}) { Text("Text action") }
            OutlinedButton(onClick = {}) { Text("Outlined action") }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
              ClawStatusPill(text = "Neutral", status = ClawStatus.Neutral)
              ClawStatusPill(text = "Good", status = ClawStatus.Success)
              ClawStatusPill(text = "Warn", status = ClawStatus.Warning)
              ClawStatusPill(text = "Error", status = ClawStatus.Danger)
            }
            Box(Modifier.testTag("markdown-links").padding(12.dp)) {
              ChatMarkdown(
                text = "###### [Heading link](https://example.test/heading)\n\n[Paragraph link](https://example.test/paragraph)\n\n| [Table link](https://example.test/table) |\n| --- |\n| Value |",
                textColor = ClawTheme.colors.text,
              )
            }
          }
        }
      }
    }

    val failures = mutableListOf<String>()
    cases.forEach { theme ->
      composeRule.runOnIdle { current.value = theme }
      mapOf(
        "Segment" to null,
        "Pill" to null,
        "Primary container" to "primary-container",
        "Secondary container" to "secondary-container",
        "Primary button" to null,
        "Text action" to null,
        "Outlined action" to null,
        "Neutral" to null,
        "Good" to null,
        "Warn" to null,
        "Error" to null,
        "Heading link" to "markdown-links",
        "Paragraph link" to "markdown-links",
        "Table link" to "markdown-links",
      ).forEach { (label, containerTag) ->
        val contrast = renderedLabelContrast(label, containerTag)
        if (contrast < 4.5f) failures += "$theme, $label: $contrast:1"
      }
    }
    assertTrue("Small control labels must retain 4.5:1 contrast:\n${failures.joinToString("\n")}", failures.isEmpty())
  }

  @Test
  fun segmentedOptionsExposeAndUpdateTheirSelection() {
    val selected = mutableStateOf("System")
    composeRule.setContent {
      ClawDesignTheme {
        ClawSegmentedControl(
          options = listOf("System", "Light", "Unavailable"),
          selected = selected.value,
          onSelect = { selected.value = it },
          enabledOptions = setOf("System", "Light"),
        )
      }
    }

    composeRule.onNodeWithText("System").assertIsSelected()
    composeRule
      .onNodeWithText("Light")
      .assertIsNotSelected()
      .performClick()
      .assertIsSelected()
    composeRule.onNodeWithText("System").assertIsNotSelected()
    composeRule.onNodeWithText("Unavailable").assertIsNotEnabled().assertIsNotSelected()
  }

  @Test
  fun filterPillsExposeAndUpdateTheirSelection() {
    val selected = mutableStateOf("All")
    composeRule.setContent {
      ClawDesignTheme {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          listOf("All", "Enabled").forEach { option ->
            ClawPill(text = option, selected = option == selected.value, onClick = { selected.value = option })
          }
        }
      }
    }

    composeRule.onNodeWithText("All").assertIsSelected()
    composeRule
      .onNodeWithText("Enabled")
      .assertIsNotSelected()
      .performClick()
      .assertIsSelected()
    composeRule.onNodeWithText("All").assertIsNotSelected()
  }

  @Test
  fun emptySegmentedOptionsProduceNoRows() {
    assertEquals(emptyList<List<String>>(), segmentedControlRows(emptyList()))
  }

  @Test
  fun segmentedOptionsStayOnOneRowByDefault() {
    val options = listOf("One", "Two", "Three", "Four", "Five")

    assertEquals(listOf(options), segmentedControlRows(options))
  }

  @Test
  fun optedInSmallSegmentedOptionSetsStayOnOneRow() {
    val options = listOf("One", "Two", "Three", "Four")

    assertEquals(listOf(options), segmentedControlRows(options, maxOptionsPerRow = 4))
  }

  @Test
  fun fiveSegmentedOptionsSplitIntoBalancedRows() {
    val options = listOf("Pending", "Held", "Applied", "Rejected", "All")

    assertEquals(
      listOf(
        listOf("Pending", "Held", "Applied"),
        listOf("Rejected", "All"),
      ),
      segmentedControlRows(options, maxOptionsPerRow = 4),
    )
  }

  @Test
  fun largerSegmentedOptionSetsKeepRowsBalancedAndBounded() {
    val rows = segmentedControlRows((1..10).map(Int::toString), maxOptionsPerRow = 4)

    assertEquals(listOf(4, 3, 3), rows.map { it.size })
    assertEquals((1..10).map(Int::toString), rows.flatten())
  }

  private fun renderedLabelContrast(
    label: String,
    containerTag: String?,
  ): Float {
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule
      .onNodeWithText(label, useUnmergedTree = true)
      .assertIsDisplayed()
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
    val layout = layouts.single().layoutInput
    val foreground =
      layout.text
        .getLinkAnnotations(0, layout.text.length)
        .firstOrNull()
        ?.item
        ?.styles
        ?.style
        ?.color ?: layout.style.color
    assertTrue("$label must resolve its rendered foreground", foreground != Color.Unspecified)
    val container =
      if (containerTag == null) composeRule.onNodeWithText(label) else composeRule.onNodeWithTag(containerTag)
    val pixels = container.captureToImage().toPixelMap()
    // Sample painted padding, away from text, rounded corners, and one-pixel borders.
    val background = pixels[pixels.width / 2, 2]
    assertEquals("$label must have an opaque rendered background", 1f, background.alpha, 0.001f)
    val foregroundLuminance = foreground.compositeOver(background).luminance()
    val backgroundLuminance = background.luminance()
    return (maxOf(foregroundLuminance, backgroundLuminance) + 0.05f) /
      (minOf(foregroundLuminance, backgroundLuminance) + 0.05f)
  }

  private data class ThemeCase(
    val dark: Boolean,
    val family: AppearanceThemeFamily = AppearanceThemeFamily.Claw,
    val accentArgb: Long? = null,
  )
}
