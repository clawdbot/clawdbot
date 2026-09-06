package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatThinkingLevelOption
import androidx.compose.ui.unit.LayoutDirection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatEffortPositionTest {
  private val options =
    listOf("off", "low", "medium", "high", "xhigh").map { id ->
      ChatThinkingLevelOption(id = id, label = id)
    }

  @Test
  fun advertisedLevelsShareOneEvenSliderAndNeedleScale() {
    val expectedFractions = listOf(0f, 0.25f, 0.5f, 0.75f, 1f)
    val expectedAngles = listOf(150f, 210f, 270f, 330f, 390f)

    options.forEachIndexed { index, option ->
      val position = resolveChatEffortPosition(option.id, options)

      assertTrue(position.anchored)
      assertEquals(index, position.optionIndex)
      assertEquals(expectedFractions[index], position.fraction)
      assertEquals(expectedAngles[index], chatEffortNeedleAngle(position))
    }
  }

  @Test
  fun unadvertisedLevelHasNoNeedlePosition() {
    val position = resolveChatEffortPosition("future-effort", options)

    assertFalse(position.anchored)
    assertEquals(-1, position.optionIndex)
    assertNull(position.fraction)
    assertNull(chatEffortNeedleAngle(position))
  }

  @Test
  fun rtlMirrorsEveryVisualStop() {
    val fractions = chatEffortStopFractions(options.size)

    assertEquals(fractions, fractions.map { fraction -> chatEffortVisualFraction(fraction, LayoutDirection.Ltr) })
    assertEquals(fractions.reversed(), fractions.map { fraction -> chatEffortVisualFraction(fraction, LayoutDirection.Rtl) })
  }
}
