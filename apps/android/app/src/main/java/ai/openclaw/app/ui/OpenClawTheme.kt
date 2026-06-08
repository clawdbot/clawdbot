package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeMode
import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val LocalOpenClawDarkTheme = staticCompositionLocalOf { true }

/**
 * App theme wrapper that installs dynamic Material colors and legacy mobile color tokens.
 */
@Composable
fun OpenClawTheme(
  themeMode: AppearanceThemeMode = AppearanceThemeMode.Dark,
  content: @Composable () -> Unit,
) {
  val context = LocalContext.current
  val isDark = themeMode.isDark(systemDark = isSystemInDarkTheme())
  val colorScheme = if (isDark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
  val mobileColors = if (isDark) darkMobileColors() else lightMobileColors()

  OpenClawSystemBarAppearance(lightAppearance = !isDark)

  CompositionLocalProvider(
    LocalMobileColors provides mobileColors,
    LocalOpenClawDarkTheme provides isDark,
  ) {
    MaterialTheme(colorScheme = colorScheme, content = content)
  }
}

@Composable
internal fun OpenClawSystemBarAppearance(lightAppearance: Boolean) {
  val view = LocalView.current
  if (!view.isInEditMode) {
    SideEffect {
      val window = (view.context as? Activity)?.window ?: return@SideEffect
      WindowCompat
        .getInsetsController(window, window.decorView)
        .isAppearanceLightStatusBars = lightAppearance
      WindowCompat
        .getInsetsController(window, window.decorView)
        .isAppearanceLightNavigationBars = lightAppearance
    }
  }
}

/**
 * Overlay background token tuned for panels floating over the mobile canvas.
 */
@Composable
fun overlayContainerColor(): Color {
  val scheme = MaterialTheme.colorScheme
  val isDark = LocalOpenClawDarkTheme.current
  val base = if (isDark) scheme.surfaceContainerLow else scheme.surfaceContainerHigh
  // Light mode keeps overlays away from pure-white glare on the app canvas.
  return if (isDark) base else base.copy(alpha = 0.88f)
}

/**
 * Overlay icon token kept next to overlayContainerColor for callers outside the design package.
 */
@Composable
fun overlayIconColor(): Color = MaterialTheme.colorScheme.onSurfaceVariant
