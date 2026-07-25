package ai.openclaw.wear

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

class WearThemeTest {
  @Test
  fun `wear palettes mirror the canonical phone surfaces and voice accents`() {
    val dark = wearColorsFor(WearThemeMode.Dark)
    assertEquals(Color(0xFF030303), dark.canvas)
    assertEquals(Color(0xFF0A0A0A), dark.surface)
    assertEquals(Color(0xFF111111), dark.surfaceRaised)
    assertEquals(Color(0xFF1A1A1A), dark.surfacePressed)
    assertEquals(Color(0xFF242424), dark.border)
    assertEquals(Color(0xFF3A3A3A), dark.borderStrong)
    assertEquals(Color(0xFFF8F8F8), dark.text)
    assertEquals(Color(0xFFA8A8A8), dark.textMuted)
    assertEquals(Color(0xFFFFFFFF), dark.primary)
    assertEquals(Color(0xFF050505), dark.primaryText)
    assertEquals(Color(0xFF6EA8FF), dark.voiceAccent)
    assertEquals(Color(0xFF1A2A44), dark.voiceAccentSoft)

    val light = wearColorsFor(WearThemeMode.Light)
    assertEquals(Color(0xFFFAFBFC), light.canvas)
    assertEquals(Color(0xFFFFFEFB), light.surface)
    assertEquals(Color(0xFFFFFFFF), light.surfaceRaised)
    assertEquals(Color(0xFFE9EDF3), light.surfacePressed)
    assertEquals(Color(0xFFDDE3EC), light.border)
    assertEquals(Color(0xFFC7D0DC), light.borderStrong)
    assertEquals(Color(0xFF111318), light.text)
    assertEquals(Color(0xFF505865), light.textMuted)
    assertEquals(Color(0xFF111827), light.primary)
    assertEquals(Color(0xFFFFFFFF), light.primaryText)
    assertEquals(Color(0xFF1B5ACB), light.voiceAccent)
    assertEquals(Color(0xFFEAF2FF), light.voiceAccentSoft)
  }

  @Test
  fun `dark and light palettes keep panels distinct from the canvas`() {
    WearThemeMode.entries.forEach { mode ->
      val colors = wearColorsFor(mode)

      assertNotEquals("$mode canvas and panel must differ", colors.canvas, colors.surfaceRaised)
      assertTrue(
        "$mode panel outline must remain visible",
        contrastRatio(colors.borderStrong, colors.surfaceRaised) >= MIN_OUTLINE_CONTRAST,
      )
    }
  }

  @Test
  fun `dark and light palettes keep text readable on panels`() {
    WearThemeMode.entries.forEach { mode ->
      val colors = wearColorsFor(mode)

      assertTrue(
        "$mode text must remain readable",
        contrastRatio(colors.text, colors.surfaceRaised) >= MIN_TEXT_CONTRAST,
      )
      assertTrue(
        "$mode muted text must remain readable",
        contrastRatio(colors.textMuted, colors.surfaceRaised) >= MIN_TEXT_CONTRAST,
      )
    }
  }

  @Test
  fun `dark and light primary and voice accents keep their content readable`() {
    WearThemeMode.entries.forEach { mode ->
      val colors = wearColorsFor(mode)

      assertTrue(
        "$mode primary content must remain readable",
        contrastRatio(colors.primaryText, colors.primary) >= MIN_TEXT_CONTRAST,
      )
      assertTrue(
        "$mode voice accent content must remain readable",
        contrastRatio(colors.onVoiceAccent, colors.voiceAccent) >= MIN_TEXT_CONTRAST,
      )
    }
  }

  private fun contrastRatio(
    foreground: Color,
    background: Color,
  ): Double {
    val foregroundLuminance = relativeLuminance(foreground)
    val backgroundLuminance = relativeLuminance(background)
    return (max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (min(foregroundLuminance, backgroundLuminance) + 0.05)
  }

  private fun relativeLuminance(color: Color): Double =
    0.2126 * linearize(color.red.toDouble()) +
      0.7152 * linearize(color.green.toDouble()) +
      0.0722 * linearize(color.blue.toDouble())

  private fun linearize(channel: Double): Double =
    if (channel <= 0.03928) {
      channel / 12.92
    } else {
      ((channel + 0.055) / 1.055).pow(2.4)
    }

  private companion object {
    const val MIN_OUTLINE_CONTRAST = 1.5
    const val MIN_TEXT_CONTRAST = 4.5
  }
}
