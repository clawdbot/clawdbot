package ai.openclaw.app.ui.design

import ai.openclaw.app.AppearanceThemeFamily
import ai.openclaw.app.R
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
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
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal val clawFontFamily =
  FontFamily(
    Font(resId = R.font.manrope_400_regular, weight = FontWeight.Normal),
    Font(resId = R.font.manrope_500_medium, weight = FontWeight.Medium),
    Font(resId = R.font.manrope_600_semibold, weight = FontWeight.SemiBold),
    Font(resId = R.font.manrope_700_bold, weight = FontWeight.Bold),
  )

/**
 * App color tokens consumed by ClawTheme and bridged into Material components.
 */
@Immutable
internal data class ClawColors(
  val canvas: Color,
  val surface: Color,
  val surfaceRaised: Color,
  val surfacePressed: Color,
  val accent: Color,
  val accentSoft: Color,
  val accentBorder: Color,
  val userMessageSurface: Color,
  val border: Color,
  val borderStrong: Color,
  val text: Color,
  val textMuted: Color,
  val textSubtle: Color,
  val primary: Color,
  val primaryText: Color,
  val secondary: Color,
  val success: Color,
  val successSoft: Color,
  val warning: Color,
  val warningSoft: Color,
  val danger: Color,
  val dangerSoft: Color,
  val codeBg: Color,
  val codeText: Color,
  val codeBorder: Color,
)

/**
 * App spacing and control-size scale for Compose screens and shared controls.
 */
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
  // Touch target and visible shape are separate: `touchTarget` is the minimum
  // hit area every control keeps, while `control`, `row`, `iconSlot`, and `icon`
  // describe the smaller painted geometry that sits inside it.
  val touchTarget: Dp = 48.dp,
  val control: Dp = 36.dp,
  val row: Dp = 48.dp,
  val iconSlot: Dp = 32.dp,
  val icon: Dp = 18.dp,
)

/**
 * Radius scale for rows, panels, controls, sheets, and status pills.
 */
@Immutable
internal data class ClawRadii(
  val row: Dp = 6.dp,
  val control: Dp = 10.dp,
  val button: Dp = 10.dp,
  val panel: Dp = 12.dp,
  val sheet: Dp = 16.dp,
  // Full-round for a `control`-height capsule; larger surfaces use `panel`.
  val pill: Dp = 18.dp,
)

/**
 * App text styles kept independent from Material typography names.
 */
@Immutable
internal data class ClawTypography(
  val display: TextStyle,
  val title: TextStyle,
  val section: TextStyle,
  val body: TextStyle,
  val label: TextStyle,
  val caption: TextStyle,
  val captionSmall: TextStyle,
  val mono: TextStyle,
)

// Control UI palette (canvas #0e1015 through accent #ff5c5c). Soft variants stay
// alpha-based so a tint composites correctly over canvas, panel, and row surfaces.
private val ClawDarkColors =
  ClawColors(
    canvas = Color(0xFF0E1015),
    surface = Color(0xFF161920),
    surfaceRaised = Color(0xFF191C24),
    surfacePressed = Color(0xFF1F2330),
    accent = Color(0xFFFF5C5C),
    accentSoft = Color(0x1AFF5C5C),
    accentBorder = Color(0xFFD13C3C),
    userMessageSurface = Color(0xFFFF5C5C).copy(alpha = 0.12f).compositeOver(Color(0xFF0E1015)),
    border = Color(0xFF1E2028),
    borderStrong = Color(0xFF2E3040),
    text = Color(0xFFF4F4F5),
    textMuted = Color(0xFFBCBCC0),
    textSubtle = Color(0xFF8B8B94),
    primary = Color(0xFFD13C3C),
    primaryText = Color(0xFFFFFFFF),
    secondary = Color(0xFF14B8A6),
    success = Color(0xFF22C55E),
    successSoft = Color(0x2622C55E),
    warning = Color(0xFFF59E0B),
    warningSoft = Color(0x26F59E0B),
    danger = Color(0xFFF87171),
    dangerSoft = Color(0x26F87171),
    codeBg = Color(0xFF0A0C10),
    codeText = Color(0xFFF4F4F5),
    codeBorder = Color(0xFF1E2028),
  )

// Light mirrors the dark hierarchy on a neutral canvas and keeps the same red
// accent family, so both themes read as one product rather than two designs.
private val ClawLightColors =
  ClawColors(
    canvas = Color(0xFFF7F7F9),
    surface = Color(0xFFFFFFFF),
    surfaceRaised = Color(0xFFFFFFFF),
    surfacePressed = Color(0xFFEFEFF3),
    accent = Color(0xFFC23434),
    accentSoft = Color(0x1AC23434),
    accentBorder = Color(0xFFA32C2C),
    userMessageSurface = Color(0x26C23434).compositeOver(Color(0xFFF7F7F9)),
    border = Color(0xFFE4E4EA),
    borderStrong = Color(0xFFCFCFD8),
    text = Color(0xFF101014),
    textMuted = Color(0xFF52525B),
    textSubtle = Color(0xFF787885),
    primary = Color(0xFFC23434),
    primaryText = Color(0xFFFFFFFF),
    secondary = Color(0xFF0F8F81),
    success = Color(0xFF15803D),
    successSoft = Color(0x2215803D),
    warning = Color(0xFFB45309),
    warningSoft = Color(0x22B45309),
    danger = Color(0xFFB91C1C),
    dangerSoft = Color(0x22B91C1C),
    codeBg = Color(0xFFF1F1F4),
    codeText = Color(0xFF101014),
    codeBorder = Color(0xFFE4E4EA),
  )

private data class WebThemePalette(
  val canvas: Long,
  val surface: Long,
  val raised: Long,
  val pressed: Long,
  val accent: Long,
  val border: Long,
  val borderStrong: Long,
  val text: Long,
  val muted: Long,
  val primary: Long,
  val primaryText: Long,
  val secondary: Long,
)

private fun webThemePalette(
  family: AppearanceThemeFamily,
  dark: Boolean,
): WebThemePalette? =
  when (family) {
    AppearanceThemeFamily.Claw -> {
      null
    }

    AppearanceThemeFamily.Knot -> {
      if (dark) {
        WebThemePalette(0xFF080808, 0xFF111113, 0xFF141416, 0xFF1A1A1E, 0xFFE5243B, 0xFF202026, 0xFF303038, 0xFFC6C6CB, 0xFF8A8A94, 0xFFD92A3F, 0xFFFAFAFA, 0xFFB8BDC4)
      } else {
        WebThemePalette(0xFFF9F9FB, 0xFFF2F2F5, 0xFFFFFFFF, 0xFFEAEAEF, 0xFFC41E30, 0xFFE2E2E8, 0xFFCCCCD4, 0xFF3A3A42, 0xFF68676F, 0xFFC41E30, 0xFFFFFFFF, 0xFF5A626E)
      }
    }

    AppearanceThemeFamily.Dash -> {
      if (dark) {
        WebThemePalette(0xFF1A1210, 0xFF221A16, 0xFF28201C, 0xFF302822, 0xFFCF8B4D, 0xFF362A1C, 0xFF4C3E2C, 0xFFD8C8B8, 0xFFA18F80, 0xFFCF8B4D, 0xFF1A1210, 0xFFDCB878)
      } else {
        WebThemePalette(0xFFF7F2EC, 0xFFF0E8E0, 0xFFFFFFFF, 0xFFE8DDD2, 0xFF8A512C, 0xFFDDD0C2, 0xFFC8B8A6, 0xFF4A3828, 0xFF725D4D, 0xFF8A512C, 0xFFFFFFFF, 0xFF7D6027)
      }
    }

    AppearanceThemeFamily.Absolutely -> {
      if (dark) {
        WebThemePalette(0xFF1C1C1A, 0xFF232320, 0xFF292825, 0xFF302F2B, 0xFFD97757, 0xFF2E2C27, 0xFF3D3A33, 0xFFE4DFD4, 0xFFABA498, 0xFFD97757, 0xFF241F1B, 0xFFB8926A)
      } else {
        WebThemePalette(0xFFFAF9F5, 0xFFF3F1E9, 0xFFFFFFFF, 0xFFEDEAE0, 0xFFA8452A, 0xFFE3DFD2, 0xFFCDC7B6, 0xFF3D3A33, 0xFF6B655B, 0xFFA8452A, 0xFFFFFFFF, 0xFF8A6A44)
      }
    }

    AppearanceThemeFamily.Tide -> {
      if (dark) {
        WebThemePalette(0xFF10151B, 0xFF161D25, 0xFF1B232C, 0xFF212B36, 0xFF5AB6D8, 0xFF222C37, 0xFF33414F, 0xFFC9D2DA, 0xFF9DABB9, 0xFF5AB6D8, 0xFF0B1116, 0xFF7F9BB5)
      } else {
        WebThemePalette(0xFFF7F9FB, 0xFFEEF2F7, 0xFFFFFFFF, 0xFFE8EDF2, 0xFF1F6F8F, 0xFFDFE5EC, 0xFFC5CFD9, 0xFF333C45, 0xFF5F6B76, 0xFF1F6F8F, 0xFFFFFFFF, 0xFF3D6D88)
      }
    }

    AppearanceThemeFamily.Beacon -> {
      if (dark) {
        WebThemePalette(0xFF000000, 0xFF0A0A0A, 0xFF141414, 0xFF1C1C1C, 0xFFFFC233, 0xFF4A4A4A, 0xFF6E6E6E, 0xFFFFFFFF, 0xFFC9C9C9, 0xFFFFC233, 0xFF000000, 0xFF8ECDFF)
      } else {
        WebThemePalette(0xFFFFFFFF, 0xFFF4F4F4, 0xFFFFFFFF, 0xFFEDEDED, 0xFF6E4A00, 0xFF8A8A8A, 0xFF5A5A5A, 0xFF000000, 0xFF3A3A3A, 0xFF6E4A00, 0xFFFFFFFF, 0xFF09428D)
      }
    }

    AppearanceThemeFamily.Phosphor -> {
      if (dark) {
        WebThemePalette(0xFF0A0F0A, 0xFF0E150E, 0xFF121A12, 0xFF18221A, 0xFF4ADE80, 0xFF1D291F, 0xFF2C3D2F, 0xFFCFE0CF, 0xFF93AC95, 0xFF4ADE80, 0xFF07120A, 0xFF8FD6A5)
      } else {
        WebThemePalette(0xFFF4F7F4, 0xFFECF1EC, 0xFFFFFFFF, 0xFFE4EBE5, 0xFF10693A, 0xFFDBE4DC, 0xFFBFCDC1, 0xFF2A352B, 0xFF566B58, 0xFF10693A, 0xFFFFFFFF, 0xFF2F6B47)
      }
    }

    AppearanceThemeFamily.Crt -> {
      if (dark) {
        WebThemePalette(0xFF090A09, 0xFF0D0F0D, 0xFF111412, 0xFF171B18, 0xFF3AFF7D, 0xFF202521, 0xFF303833, 0xFFC2CAC3, 0xFF90A094, 0xFF3AFF7D, 0xFF052B12, 0xFFFFCF5C)
      } else {
        WebThemePalette(0xFFF5F5F4, 0xFFECECEA, 0xFFFFFFFF, 0xFFE3E4E1, 0xFF0A612B, 0xFFDCDEDB, 0xFFC0C5BF, 0xFF343A34, 0xFF5B655C, 0xFF0A612B, 0xFFFFFFFF, 0xFF7A5D10)
      }
    }

    AppearanceThemeFamily.Manuscript -> {
      if (dark) {
        WebThemePalette(0xFF211E18, 0xFF262218, 0xFF2A271F, 0xFF363126, 0xFF8FA8E0, 0xFF3B3527, 0xFF4F4732, 0xFFD8D0BC, 0xFFAB9F84, 0xFF8FA8E0, 0xFF101C33, 0xFFCFA85E)
      } else {
        WebThemePalette(0xFFF6F1E4, 0xFFEFE8D6, 0xFFFDFBF3, 0xFFE7DDC4, 0xFF31549B, 0xFFDDD2B8, 0xFFC0B28A, 0xFF322D22, 0xFF6A604E, 0xFF31549B, 0xFFFFFFFF, 0xFF7D6118)
      }
    }

    AppearanceThemeFamily.Rose -> {
      if (dark) {
        WebThemePalette(0xFF191724, 0xFF1D1B2A, 0xFF1F1D2E, 0xFF26233A, 0xFFEBBCBA, 0xFF29263C, 0xFF3D3958, 0xFFD5D2EB, 0xFF9793B0, 0xFFEBBCBA, 0xFF3F2224, 0xFFF6C177)
      } else {
        WebThemePalette(0xFFFAF4ED, 0xFFF5ECE2, 0xFFFFFAF3, 0xFFEEE3D5, 0xFF9C4F66, 0xFFE3D9CB, 0xFFC8BBA7, 0xFF3E3857, 0xFF665D87, 0xFF9C4F66, 0xFFFFFFFF, 0xFF286983)
      }
    }

    AppearanceThemeFamily.Miami -> {
      if (dark) {
        WebThemePalette(0xFF140F1E, 0xFF181226, 0xFF1C1530, 0xFF251B40, 0xFFF472B6, 0xFF2C2150, 0xFF453471, 0xFFCFC7E8, 0xFF968BBD, 0xFFF472B6, 0xFF3C0A24, 0xFF5FD7E8)
      } else {
        WebThemePalette(0xFFF7F3F6, 0xFFF1E9F0, 0xFFFEFCFE, 0xFFE6DBE4, 0xFFB0246F, 0xFFE2D7E0, 0xFFC4B4C2, 0xFF3C3244, 0xFF6B5F74, 0xFFB0246F, 0xFFFFFFFF, 0xFF0F6F7D)
      }
    }
  }

private fun familyColors(
  dark: Boolean,
  family: AppearanceThemeFamily,
): ClawColors {
  val base = if (dark) ClawDarkColors else ClawLightColors
  val palette = webThemePalette(family, dark) ?: return base
  val canvas = Color(palette.canvas)
  val accent = Color(palette.accent)
  return base.copy(
    canvas = canvas,
    surface = Color(palette.surface),
    surfaceRaised = Color(palette.raised),
    surfacePressed = Color(palette.pressed),
    accent = accent,
    accentSoft = accent.copy(alpha = if (dark) 0.12f else 0.10f),
    accentBorder = accent.copy(alpha = if (dark) 0.55f else 0.65f),
    userMessageSurface = accent.copy(alpha = if (dark) 0.12f else 0.15f).compositeOver(canvas),
    border = Color(palette.border),
    borderStrong = Color(palette.borderStrong),
    text = Color(palette.text),
    textMuted = Color(palette.muted),
    textSubtle = Color(palette.muted).copy(alpha = 0.82f),
    primary = Color(palette.primary),
    primaryText = Color(palette.primaryText),
    secondary = Color(palette.secondary),
    codeBg = canvas,
    codeText = Color(palette.text),
    codeBorder = Color(palette.border),
  )
}

internal fun clawColorsForTheme(
  dark: Boolean,
  family: AppearanceThemeFamily = AppearanceThemeFamily.Claw,
  accentArgb: Long?,
): ClawColors {
  val base = familyColors(dark = dark, family = family)
  val accent = accentArgb?.let(::Color) ?: return base
  val accentInk = if (accent.luminance() > 0.179f) Color.Black else Color.White
  return base.copy(
    accent = accent,
    accentSoft = accent.copy(alpha = if (dark) 0.25f else 0.08f).compositeOver(base.canvas),
    accentBorder = lerp(accent, Color.Black, 0.12f),
    userMessageSurface = accent.copy(alpha = if (dark) 0.12f else 0.15f).compositeOver(base.canvas),
    primary = accent,
    primaryText = accentInk,
  )
}

private val LocalClawColors = staticCompositionLocalOf { ClawDarkColors }
private val LocalClawSpacing = staticCompositionLocalOf { ClawSpacing() }
private val LocalClawRadii = staticCompositionLocalOf { ClawRadii() }
private val LocalClawTypography = staticCompositionLocalOf { clawTypography(clawFontFamily) }

/**
 * Composition-local access point for OpenClaw Android design tokens.
 */
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

/**
 * Installs OpenClaw design tokens and maps them into MaterialTheme for Material3 controls.
 */
@Composable
internal fun ClawDesignTheme(
  dark: Boolean = true,
  family: AppearanceThemeFamily = AppearanceThemeFamily.Claw,
  accentArgb: Long? = null,
  content: @Composable () -> Unit,
) {
  val colors = clawColorsForTheme(dark = dark, family = family, accentArgb = accentArgb)
  val typography = clawTypography(clawFontFamily)

  val spacing = ClawSpacing()

  CompositionLocalProvider(
    LocalClawColors provides colors,
    LocalClawSpacing provides spacing,
    LocalClawRadii provides ClawRadii(),
    LocalClawTypography provides typography,
    // Keep Material controls on the same accessibility floor as Claw controls while
    // their smaller painted geometry stays independent from the hit area.
    LocalMinimumInteractiveComponentSize provides spacing.touchTarget,
  ) {
    MaterialTheme(
      colorScheme = clawMaterialColorScheme(colors, dark),
      typography = materialTypography(typography),
      shapes = Shapes(),
      content = content,
    )
  }
}

private fun clawTypography(fontFamily: FontFamily) =
  ClawTypography(
    display =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
        letterSpacing = 0.sp,
      ),
    title =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 17.sp,
        lineHeight = 22.sp,
        letterSpacing = 0.sp,
      ),
    section =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 18.sp,
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
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.sp,
      ),
    captionSmall =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.4.sp,
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
    // Material also uses primary for text actions; branded fills supply their Claw color pair.
    primary = colors.text,
    onPrimary = colors.canvas,
    primaryContainer = colors.accentSoft,
    onPrimaryContainer = colors.text,
    secondary = colors.secondary,
    onSecondary = colors.canvas,
    secondaryContainer = colors.accentSoft,
    onSecondaryContainer = colors.text,
    background = colors.canvas,
    onBackground = colors.text,
    surface = colors.surface,
    onSurface = colors.text,
    surfaceVariant = colors.surfaceRaised,
    onSurfaceVariant = colors.textMuted,
    surfaceContainerLowest = colors.canvas,
    surfaceContainerLow = colors.surface,
    surfaceContainer = colors.surface,
    surfaceContainerHigh = colors.surfaceRaised,
    surfaceContainerHighest = colors.surfacePressed,
    outline = colors.borderStrong,
    outlineVariant = colors.border,
    scrim = Color(0xCC05070B),
    error = colors.danger,
    onError = colors.primaryText,
  )
} else {
  lightColorScheme(
    primary = colors.text,
    onPrimary = colors.canvas,
    primaryContainer = colors.accentSoft,
    onPrimaryContainer = colors.text,
    secondary = colors.secondary,
    onSecondary = colors.primaryText,
    secondaryContainer = colors.accentSoft,
    onSecondaryContainer = colors.text,
    background = colors.canvas,
    onBackground = colors.text,
    surface = colors.surface,
    onSurface = colors.text,
    surfaceVariant = colors.surfaceRaised,
    onSurfaceVariant = colors.textMuted,
    surfaceContainerLowest = colors.surface,
    surfaceContainerLow = colors.surface,
    surfaceContainer = colors.canvas,
    surfaceContainerHigh = colors.surfacePressed,
    surfaceContainerHighest = colors.surfacePressed,
    outline = colors.borderStrong,
    outlineVariant = colors.border,
    scrim = Color(0x99101014),
    error = colors.danger,
    onError = colors.primaryText,
  )
}
