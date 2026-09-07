package ai.openclaw.app.ui.design

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

// Names and ordering follow the gateway session color contract; values stay local to the theme.
private val sessionColorPalette =
  linkedMapOf(
    "red" to (Color(0xFFB85B58) to Color(0xFFE98B87)),
    "blue" to (Color(0xFF4A75AD) to Color(0xFF80A7DD)),
    "green" to (Color(0xFF50825F) to Color(0xFF86B796)),
    "yellow" to (Color(0xFF9D7D27) to Color(0xFFDBC174)),
    "purple" to (Color(0xFF8562AC) to Color(0xFFB79CD4)),
    "orange" to (Color(0xFFAA733E) to Color(0xFFD6A06C)),
    "pink" to (Color(0xFFAE5F87) to Color(0xFFD895B7)),
    "cyan" to (Color(0xFF448792) to Color(0xFF7EBBC4)),
  )

internal val sessionColorNames: Set<String> = sessionColorPalette.keys

internal fun ClawColors.sessionColor(name: String?): Color? {
  val (light, dark) = sessionColorPalette[name] ?: return null
  return if (canvas.luminance() < 0.5f) dark else light
}

// Drawing inside the row keeps its layout unchanged when a color is set or cleared.
internal fun Modifier.sessionColorStripe(color: Color?): Modifier =
  if (color == null) {
    this
  } else {
    drawBehind {
      val width = 3.dp.toPx()
      val inset = 8.dp.toPx()
      drawRoundRect(
        color = color,
        topLeft = Offset(if (layoutDirection == LayoutDirection.Rtl) size.width - width else 0f, inset),
        size = Size(width, size.height - inset * 2),
        cornerRadius = CornerRadius(width / 2),
      )
    }
  }
