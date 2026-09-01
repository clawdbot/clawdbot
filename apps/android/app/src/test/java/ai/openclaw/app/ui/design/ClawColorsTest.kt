package ai.openclaw.app.ui.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.lerp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ClawColorsTest {
  @Test
  fun sessionColorsAdaptToThemeAndUnsetNamesHaveNoIndicator() {
    val light = clawColorsForTheme(dark = false, accentArgb = null)
    val dark = clawColorsForTheme(dark = true, accentArgb = null)
    for (name in listOf("red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan")) {
      assertNotNull(light.sessionColor(name))
      assertNotNull(dark.sessionColor(name))
      assertNotEquals(light.sessionColor(name), dark.sessionColor(name))
    }
    for (name in listOf(null, "", "gray", "grey", "default", "reset", "none", "unknown")) {
      assertNull(light.sessionColor(name))
      assertNull(dark.sessionColor(name))
    }
  }

  @Test
  fun nullAccentPreservesHardcodedDarkAndLightPalettes() {
    val expectedAccents =
      mapOf(
        true to Triple(Color(0xFF6EA8FF), Color(0xFF1A2A44), Color(0xFF5B93E8)),
        false to Triple(Color(0xFF1B5ACB), Color(0xFFEAF2FF), Color(0xFF174CA9)),
      )

    for ((dark, expected) in expectedAccents) {
      val colors = clawColorsForTheme(dark = dark, accentArgb = null)

      assertEquals(expected.first, colors.accent)
      assertEquals(expected.second, colors.accentSoft)
      assertEquals(expected.third, colors.accentBorder)
      assertSame(colors, clawColorsForTheme(dark = dark, accentArgb = null))
    }
  }

  @Test
  fun gatewayAccentOverridesOnlyAccentTokensForBothPalettes() {
    val accent = Color(0xFFE84B35)

    for (dark in listOf(true, false)) {
      val base = clawColorsForTheme(dark = dark, accentArgb = null)
      val colors = clawColorsForTheme(dark = dark, accentArgb = 0xFFE84B35L)

      assertEquals(accent, colors.accent)
      assertEquals(accent.copy(alpha = if (dark) 0.25f else 0.08f).compositeOver(base.canvas), colors.accentSoft)
      assertEquals(lerp(accent, Color.Black, 0.12f), colors.accentBorder)
      assertNotEquals(accent, colors.accentSoft)
      assertNotEquals(accent, colors.accentBorder)
      assertNotEquals(base.accentSoft, colors.accentSoft)
      assertNotEquals(base.accentBorder, colors.accentBorder)
      assertEquals(
        base.copy(accent = colors.accent, accentSoft = colors.accentSoft, accentBorder = colors.accentBorder),
        colors,
      )
    }
  }
}
