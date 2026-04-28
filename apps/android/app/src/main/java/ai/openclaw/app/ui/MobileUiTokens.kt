package ai.openclaw.app.ui

import ai.openclaw.app.R
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// ---------------------------------------------------------------------------
// MobileColors – semantic color tokens with light + dark variants
// ---------------------------------------------------------------------------

internal data class MobileColors(
  val surface: Color,
  val surfaceStrong: Color,
  val cardSurface: Color,
  val border: Color,
  val borderStrong: Color,
  val text: Color,
  val textSecondary: Color,
  val textTertiary: Color,
  val accent: Color,
  val accentSoft: Color,
  val accentBorderStrong: Color,
  val success: Color,
  val successSoft: Color,
  val warning: Color,
  val warningSoft: Color,
  val danger: Color,
  val dangerSoft: Color,
  val codeBg: Color,
  val codeText: Color,
  val codeBorder: Color,
  val codeAccent: Color,
  val chipBorderConnected: Color,
  val chipBorderConnecting: Color,
  val chipBorderWarning: Color,
  val chipBorderError: Color,
)

internal fun lightMobileColors() =
  MobileColors(
    surface = Color(0xFFF6F7FA),
    surfaceStrong = Color(0xFFECEEF3),
    cardSurface = Color(0xFFFFFFFF),
    border = Color(0xFFE5E7EC),
    borderStrong = Color(0xFFD6DAE2),
    text = Color(0xFF17181C),
    textSecondary = Color(0xFF5D6472),
    textTertiary = Color(0xFF99A0AE),
    accent = Color(0xFF1D5DD8),
    accentSoft = Color(0xFFECF3FF),
    accentBorderStrong = Color(0xFF184DAF),
    success = Color(0xFF2F8C5A),
    successSoft = Color(0xFFEEF9F3),
    warning = Color(0xFFC8841A),
    warningSoft = Color(0xFFFFF8EC),
    danger = Color(0xFFD04B4B),
    dangerSoft = Color(0xFFFFF2F2),
    codeBg = Color(0xFF15171B),
    codeText = Color(0xFFE8EAEE),
    codeBorder = Color(0xFF2B2E35),
    codeAccent = Color(0xFF3FC97A),
    chipBorderConnected = Color(0xFFCFEBD8),
    chipBorderConnecting = Color(0xFFD5E2FA),
    chipBorderWarning = Color(0xFFEED8B8),
    chipBorderError = Color(0xFFF3C8C8),
  )

internal fun darkMobileColors() =
  MobileColors(
    surface = Color(0xFF1A1C20),
    surfaceStrong = Color(0xFF24262B),
    cardSurface = Color(0xFF1E2024),
    border = Color(0xFF2E3038),
    borderStrong = Color(0xFF3A3D46),
    text = Color(0xFFE4E5EA),
    textSecondary = Color(0xFFA0A6B4),
    textTertiary = Color(0xFF6B7280),
    accent = Color(0xFF6EA8FF),
    accentSoft = Color(0xFF1A2A44),
    accentBorderStrong = Color(0xFF5B93E8),
    success = Color(0xFF5FBB85),
    successSoft = Color(0xFF152E22),
    warning = Color(0xFFE8A844),
    warningSoft = Color(0xFF2E2212),
    danger = Color(0xFFE87070),
    dangerSoft = Color(0xFF2E1616),
    codeBg = Color(0xFF111317),
    codeText = Color(0xFFE8EAEE),
    codeBorder = Color(0xFF2B2E35),
    codeAccent = Color(0xFF3FC97A),
    chipBorderConnected = Color(0xFF1E4A30),
    chipBorderConnecting = Color(0xFF1E3358),
    chipBorderWarning = Color(0xFF3E3018),
    chipBorderError = Color(0xFF3E1E1E),
  )

internal val LocalMobileColors = staticCompositionLocalOf { lightMobileColors() }

internal object MobileColorsAccessor {
  val current: MobileColors
    @Composable get() = LocalMobileColors.current
}

// ---------------------------------------------------------------------------
// Backward-compatible top-level accessors (composable getters)
// ---------------------------------------------------------------------------
// These allow existing call sites to keep using `mobileSurface`, `mobileText`, etc.
// without converting every file at once. Each resolves to the themed value.

internal val mobileSurface: Color @Composable get() = LocalMobileColors.current.surface
internal val mobileSurfaceStrong: Color @Composable get() = LocalMobileColors.current.surfaceStrong
internal val mobileCardSurface: Color @Composable get() = LocalMobileColors.current.cardSurface
internal val mobileBorder: Color @Composable get() = LocalMobileColors.current.border
internal val mobileBorderStrong: Color @Composable get() = LocalMobileColors.current.borderStrong
internal val mobileText: Color @Composable get() = LocalMobileColors.current.text
internal val mobileTextSecondary: Color @Composable get() = LocalMobileColors.current.textSecondary
internal val mobileTextTertiary: Color @Composable get() = LocalMobileColors.current.textTertiary
internal val mobileAccent: Color @Composable get() = LocalMobileColors.current.accent
internal val mobileAccentSoft: Color @Composable get() = LocalMobileColors.current.accentSoft
internal val mobileAccentBorderStrong: Color @Composable get() = LocalMobileColors.current.accentBorderStrong
internal val mobileSuccess: Color @Composable get() = LocalMobileColors.current.success
internal val mobileSuccessSoft: Color @Composable get() = LocalMobileColors.current.successSoft
internal val mobileWarning: Color @Composable get() = LocalMobileColors.current.warning
internal val mobileWarningSoft: Color @Composable get() = LocalMobileColors.current.warningSoft
internal val mobileDanger: Color @Composable get() = LocalMobileColors.current.danger
internal val mobileDangerSoft: Color @Composable get() = LocalMobileColors.current.dangerSoft
internal val mobileCodeBg: Color @Composable get() = LocalMobileColors.current.codeBg
internal val mobileCodeText: Color @Composable get() = LocalMobileColors.current.codeText
internal val mobileCodeBorder: Color @Composable get() = LocalMobileColors.current.codeBorder
internal val mobileCodeAccent: Color @Composable get() = LocalMobileColors.current.codeAccent

// Background gradient – light fades white→gray, dark fades near-black→dark-gray
internal val mobileBackgroundGradient: Brush
  @Composable get() {
    val colors = LocalMobileColors.current
    return Brush.verticalGradient(
      listOf(
        colors.surface,
        colors.surfaceStrong,
        colors.surfaceStrong,
      ),
    )
  }

// ---------------------------------------------------------------------------
// Typography tokens (theme-independent)
// ---------------------------------------------------------------------------

internal val mobileFontFamily =
  FontFamily(
    Font(resId = R.font.manrope_400_regular, weight = FontWeight.Normal),
    Font(resId = R.font.manrope_500_medium, weight = FontWeight.Medium),
    Font(resId = R.font.manrope_600_semibold, weight = FontWeight.SemiBold),
    Font(resId = R.font.manrope_700_bold, weight = FontWeight.Bold),
  )

internal val mobileDisplay =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Bold,
    fontSize = 34.sp,
    lineHeight = 40.sp,
    letterSpacing = (-0.8).sp,
  )

internal val mobileTitle1 =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.SemiBold,
    fontSize = 24.sp,
    lineHeight = 30.sp,
    letterSpacing = (-0.5).sp,
  )

internal val mobileTitle2 =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.SemiBold,
    fontSize = 20.sp,
    lineHeight = 26.sp,
    letterSpacing = (-0.3).sp,
  )

internal val mobileHeadline =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.SemiBold,
    fontSize = 16.sp,
    lineHeight = 22.sp,
    letterSpacing = (-0.1).sp,
  )

internal val mobileBody =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 15.sp,
    lineHeight = 22.sp,
  )

internal val mobileCallout =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 14.sp,
    lineHeight = 20.sp,
  )

internal val mobileCaption1 =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 12.sp,
    lineHeight = 16.sp,
    letterSpacing = 0.2.sp,
  )

internal val mobileCaption2 =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 11.sp,
    lineHeight = 14.sp,
    letterSpacing = 0.4.sp,
  )
