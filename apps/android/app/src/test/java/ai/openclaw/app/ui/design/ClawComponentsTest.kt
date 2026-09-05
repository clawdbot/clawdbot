package ai.openclaw.app.ui.design

import ai.openclaw.app.AppearanceThemeFamily
import ai.openclaw.app.GatewaySummaryState
import ai.openclaw.app.appearanceAccentPalette
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.ui.SettingsRefreshControls
import ai.openclaw.app.ui.SettingsSummaryContent
import ai.openclaw.app.ui.chat.ChatMarkdown
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
  fun listItemKeepsCompleteLabelsAtNarrowWidthsAndLargeText() {
    val cases =
      listOf(
        ListRowCase("Fournisseurs et modèles", "Vérifier l’état de préparation"),
        ListRowCase("Fournisseurs et modèles", "Vérifier l’état de préparation", slots = ListRowSlots.Settings),
        ListRowCase("Microphone USB du bureau", "Microphone externe", "Session suivante", ListRowSlots.Microphone),
        ListRowCase("Passerelle principale du bureau", "gateway.example.test:18789", slots = ListRowSlots.Gateway),
      )
    val current = mutableStateOf(cases.first())
    val width = mutableStateOf(320.dp)
    val fontScale = mutableStateOf(1f)
    val connected = mutableStateOf(false)
    var rowClicks = 0
    var forgetClicks = 0
    var connectionClicks = 0
    composeRule.setContent {
      val row = current.value
      DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fontScale.value)) {
        ClawDesignTheme {
          // SettingsShellScreen and SettingsDetailFrame give rows scrollable height.
          LazyColumn(Modifier.width(width.value)) {
            item {
              ClawListItem(
                title = row.title,
                subtitle = row.subtitle,
                metadata = row.metadata,
                leading =
                  if (row.slots == ListRowSlots.None) {
                    null
                  } else {
                    {
                      if (row.slots == ListRowSlots.Settings) {
                        Icon(Icons.Default.Cloud, null, Modifier.size(20.dp))
                      } else {
                        ClawIconBadge(if (row.slots == ListRowSlots.Microphone) Icons.Default.Mic else Icons.Default.Cloud)
                      }
                    }
                  },
                trailing =
                  if (row.slots == ListRowSlots.None) {
                    null
                  } else {
                    {
                      when (row.slots) {
                        ListRowSlots.Settings -> {
                          Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                            Box(Modifier.size(4.5.dp).background(ClawTheme.colors.success))
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Ouvrir ${row.title}", Modifier.size(17.dp))
                          }
                        }

                        ListRowSlots.Microphone -> {
                          Icon(Icons.Default.Check, "Sélectionné", Modifier.size(18.dp))
                        }

                        ListRowSlots.Gateway -> {
                          Row {
                            Switch(connected.value, {
                              connected.value = it
                              connectionClicks++
                            }, Modifier.testTag("gateway-connection"))
                            TextButton(onClick = { forgetClicks++ }) { Text("Oublier") }
                          }
                        }

                        ListRowSlots.None -> {}
                      }
                    }
                  },
                onClick = { rowClicks++ },
              )
            }
          }
        }
      }
    }
    for (row in cases) {
      for (scale in listOf(1f, 2f)) {
        for (rowWidth in listOf(320.dp, 280.dp)) {
          composeRule.runOnIdle {
            current.value = row
            width.value = rowWidth
            fontScale.value = scale
          }
          val labels = listOfNotNull(row.title, row.subtitle, row.metadata, "Oublier".takeIf { row.slots == ListRowSlots.Gateway })
          for (label in labels) {
            val layouts = mutableListOf<TextLayoutResult>()
            composeRule
              .onNodeWithText(label, useUnmergedTree = true)
              .performScrollTo()
              .assertIsDisplayed()
              .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
            val layout = layouts.single()
            // Paragraph width can exceed a tight Text node even when every glyph fits.
            assertFalse("${row.slots}/$rowWidth/$scale: $label must retain every line", layout.multiParagraph.didExceedMaxLines)
            assertTrue("$label must fit vertically", layout.multiParagraph.height <= layout.size.height + 1f)
            assertTrue("${row.slots}/$rowWidth/$scale: $label must fit horizontally", (0 until layout.lineCount).all { layout.getLineLeft(it) >= -1f && layout.getLineRight(it) <= layout.size.width + 1f })
            assertTrue("$label must not be ellipsized", (0 until layout.lineCount).none(layout::isLineEllipsized))
            assertEquals(label.length, layout.getLineEnd(layout.lineCount - 1, visibleEnd = true))
          }
          val beforeRowClicks = rowClicks
          val beforeForgetClicks = forgetClicks
          val beforeConnectionClicks = connectionClicks
          if (row.slots == ListRowSlots.Settings) {
            composeRule.onNodeWithContentDescription("Ouvrir ${row.title}").assertHasClickAction()
            composeRule
              .onNodeWithContentDescription("Ouvrir ${row.title}", useUnmergedTree = true)
              .performScrollTo()
              .performClick()
          } else {
            composeRule.onNodeWithText(row.title).assertHasClickAction()
            // A merged row's center can be a trailing button; touch the title itself.
            composeRule
              .onNodeWithText(row.title, useUnmergedTree = true)
              .performScrollTo()
              .performClick()
          }
          composeRule.runOnIdle {
            assertEquals("${row.slots}/$rowWidth/$scale: one row callback", beforeRowClicks + 1, rowClicks)
            assertEquals(beforeForgetClicks, forgetClicks)
            assertEquals(beforeConnectionClicks, connectionClicks)
          }
          if (row.slots == ListRowSlots.Gateway) {
            composeRule.onNodeWithText("Oublier").performScrollTo().performClick()
            composeRule
              .onNodeWithTag("gateway-connection")
              .performScrollTo()
              .assertIsDisplayed()
              .performClick()
            composeRule.runOnIdle {
              assertEquals("Trailing controls must not activate the row", beforeRowClicks + 1, rowClicks)
              assertEquals(beforeForgetClicks + 1, forgetClicks)
              assertEquals(beforeConnectionClicks + 1, connectionClicks)
            }
          }
        }
      }
    }
  }

  private enum class ListRowSlots { None, Settings, Microphone, Gateway }

  private data class ListRowCase(
    val title: String,
    val subtitle: String,
    val metadata: String? = null,
    val slots: ListRowSlots = ListRowSlots.None,
  )

  @Test
  fun gatewaySummaryShowsFailuresWithoutInventingDataAndRetainsLoadedSnapshots() {
    val state = mutableStateOf(GatewaySummaryState<String>(refreshing = true))
    val connected = mutableStateOf(true)
    composeRule.setContent {
      ClawDesignTheme {
        Column {
          SettingsRefreshControls(connected.value, state.value.refreshing, state.value.errorText, onRefresh = {})
          SettingsSummaryContent(state.value, connected.value, "Connect to load the summary.") { snapshot ->
            Text(snapshot)
          }
        }
      }
    }
    composeRule.onNodeWithText("Refreshing").assertIsDisplayed().assertIsNotEnabled()
    composeRule.onNodeWithText("Load from gateway").assertDoesNotExist()

    composeRule.runOnIdle { state.value = GatewaySummaryState(errorText = nativeText("Could not load channels.")) }
    composeRule.onNodeWithText("Could not load channels.").assertIsDisplayed()
    composeRule.onNodeWithText("Load from gateway").assertDoesNotExist()

    composeRule.runOnIdle { state.value = GatewaySummaryState(summary = "Last successful response") }
    composeRule.onNodeWithText("Last successful response").assertIsDisplayed()
    composeRule.onNodeWithText("Could not load channels.").assertDoesNotExist()
    composeRule.runOnIdle { state.value = state.value.copy(errorText = nativeText("Could not load channels.")) }
    composeRule.onNodeWithText("Last successful response").assertIsDisplayed()
    composeRule.onNodeWithText("Could not load channels.").assertIsDisplayed()

    composeRule.runOnIdle { connected.value = false }
    composeRule.onNodeWithText("Connect to load the summary.").assertIsDisplayed()
    composeRule.onNodeWithText("Last successful response").assertDoesNotExist()
  }

  @Test
  fun selectedLabelsStayReadableAcrossThemeFamiliesAndLightAccents() {
    val cases = contrastThemeCases()
    val current = mutableStateOf(cases.first())
    composeRule.setContent {
      val theme = current.value
      ClawDesignTheme(dark = theme.dark, family = theme.family, accentArgb = theme.accentArgb) {
        Surface(color = ClawTheme.colors.surface) {
          Column(Modifier.width(320.dp).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            ClawSegmentedControl(options = listOf("Segment", "Other"), selected = "Segment", onSelect = {})
            ClawPill(text = "Pill", selected = true, onClick = {})
            ClawPanel(Modifier.testTag("list-item-panel")) {
              ClawListItem(title = "Row title", subtitle = "Row subtitle", metadata = "Row metadata")
            }
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
        "Row title" to "list-item-panel",
        "Row subtitle" to "list-item-panel",
        "Row metadata" to "list-item-panel",
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
        val contrast =
          renderedLabelContrast(
            label = composeRule.onNodeWithText(label, useUnmergedTree = true),
            container = if (containerTag == null) composeRule.onNodeWithText(label) else composeRule.onNodeWithTag(containerTag),
          ).ratio
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
}

internal data class ContrastThemeCase(
  val dark: Boolean,
  val family: AppearanceThemeFamily = AppearanceThemeFamily.Claw,
  val accentArgb: Long? = null,
)

internal fun contrastThemeCases(): List<ContrastThemeCase> =
  AppearanceThemeFamily.entries.flatMap { family ->
    listOf(ContrastThemeCase(dark = true, family = family), ContrastThemeCase(dark = false, family = family))
  } + appearanceAccentPalette.map { ContrastThemeCase(dark = false, accentArgb = it) }

internal data class RenderedLabelContrast(
  val foreground: Color,
  val background: Color,
  val sampleX: Int,
  val sampleY: Int,
  val ratio: Float,
)

internal fun renderedLabelContrast(
  label: SemanticsNodeInteraction,
  container: SemanticsNodeInteraction = label,
): RenderedLabelContrast {
  container.performScrollTo()
  val layouts = mutableListOf<TextLayoutResult>()
  label
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
  assertTrue("${layout.text} must resolve its rendered foreground", foreground != Color.Unspecified)
  val pixels = container.captureToImage().toPixelMap()
  // Sample painted padding, away from text, rounded corners, and one-pixel borders.
  val sampleX = pixels.width / 2
  val sampleY = 2
  val background = pixels[sampleX, sampleY]
  assertEquals("${layout.text} must have an opaque rendered background", 1f, background.alpha, 0.001f)
  val foregroundLuminance = foreground.compositeOver(background).luminance()
  val backgroundLuminance = background.luminance()
  val ratio =
    (maxOf(foregroundLuminance, backgroundLuminance) + 0.05f) /
      (minOf(foregroundLuminance, backgroundLuminance) + 0.05f)
  return RenderedLabelContrast(foreground, background, sampleX, sampleY, ratio)
}
