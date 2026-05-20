package ai.openclaw.app.ui.design

import ai.openclaw.app.ui.mobileFontFamily
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Immutable
internal data class ClawColors(
  val canvas: Color,
  val surface: Color,
  val surfaceRaised: Color,
  val surfacePressed: Color,
  val border: Color,
  val borderStrong: Color,
  val text: Color,
  val textMuted: Color,
  val textSubtle: Color,
  val primary: Color,
  val primaryText: Color,
  val success: Color,
  val successSoft: Color,
  val warning: Color,
  val warningSoft: Color,
  val danger: Color,
  val dangerSoft: Color,
)

@Immutable
internal data class ClawSpacing(
  val xxxs: Dp = 4.dp,
  val xxs: Dp = 8.dp,
  val xs: Dp = 12.dp,
  val sm: Dp = 16.dp,
  val md: Dp = 20.dp,
  val lg: Dp = 24.dp,
  val xl: Dp = 32.dp,
  val xxl: Dp = 40.dp,
  val touchTarget: Dp = 48.dp,
)

@Immutable
internal data class ClawRadii(
  val row: Dp = 4.dp,
  val panel: Dp = 7.dp,
  val control: Dp = 8.dp,
  val sheet: Dp = 12.dp,
  val pill: Dp = 999.dp,
)

@Immutable
internal data class ClawTypography(
  val display: TextStyle,
  val title: TextStyle,
  val section: TextStyle,
  val body: TextStyle,
  val label: TextStyle,
  val caption: TextStyle,
  val mono: TextStyle,
)

private val ClawDarkColors =
  ClawColors(
    canvas = Color(0xFF030303),
    surface = Color(0xFF0A0A0A),
    surfaceRaised = Color(0xFF111111),
    surfacePressed = Color(0xFF1A1A1A),
    border = Color(0xFF242424),
    borderStrong = Color(0xFF3A3A3A),
    text = Color(0xFFF8F8F8),
    textMuted = Color(0xFFA8A8A8),
    textSubtle = Color(0xFF707070),
    primary = Color(0xFFFFFFFF),
    primaryText = Color(0xFF050505),
    success = Color(0xFF3EDB82),
    successSoft = Color(0xFF102719),
    warning = Color(0xFFE6B956),
    warningSoft = Color(0xFF2B2412),
    danger = Color(0xFFFF6B6B),
    dangerSoft = Color(0xFF2C1414),
  )

private val ClawLightColors =
  ClawColors(
    canvas = Color(0xFFF7F7F7),
    surface = Color(0xFFFFFFFF),
    surfaceRaised = Color(0xFFFFFFFF),
    surfacePressed = Color(0xFFEDEDED),
    border = Color(0xFFE0E0E0),
    borderStrong = Color(0xFFBDBDBD),
    text = Color(0xFF070707),
    textMuted = Color(0xFF595959),
    textSubtle = Color(0xFF8A8A8A),
    primary = Color(0xFF050505),
    primaryText = Color(0xFFFFFFFF),
    success = Color(0xFF157A3E),
    successSoft = Color(0xFFEAF8EF),
    warning = Color(0xFF9A6A12),
    warningSoft = Color(0xFFFFF5DD),
    danger = Color(0xFFB42323),
    dangerSoft = Color(0xFFFFE9E9),
  )

private val LocalClawColors = staticCompositionLocalOf { ClawDarkColors }
private val LocalClawSpacing = staticCompositionLocalOf { ClawSpacing() }
private val LocalClawRadii = staticCompositionLocalOf { ClawRadii() }
private val LocalClawTypography = staticCompositionLocalOf { clawTypography(mobileFontFamily) }

internal object ClawTheme {
  val colors: ClawColors
    @Composable
    @ReadOnlyComposable
    get() = LocalClawColors.current

  val spacing: ClawSpacing
    @Composable
    @ReadOnlyComposable
    get() = LocalClawSpacing.current

  val radii: ClawRadii
    @Composable
    @ReadOnlyComposable
    get() = LocalClawRadii.current

  val type: ClawTypography
    @Composable
    @ReadOnlyComposable
    get() = LocalClawTypography.current
}

@Composable
internal fun ClawDesignTheme(
  dark: Boolean = true,
  content: @Composable () -> Unit,
) {
  val colors = if (dark) ClawDarkColors else ClawLightColors
  val typography = clawTypography(mobileFontFamily)

  CompositionLocalProvider(
    LocalClawColors provides colors,
    LocalClawSpacing provides ClawSpacing(),
    LocalClawRadii provides ClawRadii(),
    LocalClawTypography provides typography,
  ) {
    MaterialTheme(
      colorScheme = clawMaterialColorScheme(colors, dark),
      typography = materialTypography(typography),
      shapes = Shapes(),
      content = content,
    )
  }
}

@Composable
internal fun rememberClawDarkPreference(): Boolean = isSystemInDarkTheme()

private fun clawTypography(fontFamily: FontFamily) =
  ClawTypography(
    display =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.Bold,
        fontSize = 26.sp,
        lineHeight = 32.sp,
        letterSpacing = 0.sp,
      ),
    title =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
        lineHeight = 25.sp,
        letterSpacing = 0.sp,
      ),
    section =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
      ),
    body =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 19.sp,
        letterSpacing = 0.sp,
      ),
    label =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.sp,
      ),
    caption =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.Medium,
        fontSize = 12.5.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.sp,
      ),
    mono =
      TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.sp,
      ),
  )

private fun materialTypography(type: ClawTypography) =
  Typography(
    displayMedium = type.display,
    titleLarge = type.title,
    titleMedium = type.section,
    bodyLarge = type.body,
    labelLarge = type.label,
    labelSmall = type.caption,
  )

private fun clawMaterialColorScheme(
  colors: ClawColors,
  dark: Boolean,
) = if (dark) {
  darkColorScheme(
    primary = colors.primary,
    onPrimary = colors.primaryText,
    background = colors.canvas,
    onBackground = colors.text,
    surface = colors.surface,
    onSurface = colors.text,
    surfaceVariant = colors.surfaceRaised,
    onSurfaceVariant = colors.textMuted,
    outline = colors.border,
    error = colors.danger,
    onError = colors.primaryText,
  )
} else {
  lightColorScheme(
    primary = colors.primary,
    onPrimary = colors.primaryText,
    background = colors.canvas,
    onBackground = colors.text,
    surface = colors.surface,
    onSurface = colors.text,
    surfaceVariant = colors.surfaceRaised,
    onSurfaceVariant = colors.textMuted,
    outline = colors.border,
    error = colors.danger,
    onError = colors.primaryText,
  )
}
